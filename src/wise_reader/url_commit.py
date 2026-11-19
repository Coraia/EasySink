"""Library-scoped URL execution, receipts, and disk bundle storage."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import stat
import threading
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Generic, TypeVar
from uuid import UUID, uuid4

from .store import Store, _now
from .url_transport import Control, ImportFailure, normalize_url

T = TypeVar("T")


def _canonical_json(data) -> bytes:
    return json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


class Execution(Generic[T]):
    def __init__(self, control: Control, operation: Callable[[], T]):
        self.control = control
        self._value: T | None = None
        self._error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, args=(operation,), name="url-import")

    def _run(self, operation: Callable[[], T]) -> None:
        try:
            self.control.remaining()
            self._value = operation()
            if not (isinstance(self._value, Receipt) and self._value.state in ("committed", "unknown")):
                self.control.remaining()
        except BaseException as exc:
            self._error = exc

    def join(self, timeout: float | None = None) -> bool:
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def result(self) -> T:
        if self._thread.is_alive():
            raise ImportFailure("running")
        if self._error is not None:
            raise self._error
        return self._value  # type: ignore[return-value]


class ExecutionOwner:
    """Hold the library lock for life, and the slot until its thread exits."""

    def __init__(self, library_directory: Path):
        self._mutex = threading.Lock()
        self._active: Execution | None = None
        self._fd: int | None = None
        path = library_directory.resolve(strict=True) / ".url-import.lock"
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ImportFailure("unsafe_owner_lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ImportFailure("owner_busy") from exc
        except BaseException:
            os.close(fd)
            raise
        self._fd = fd

    def _check(self) -> None:
        if self._fd is None:
            raise ImportFailure("owner_closed")
        if self._active is not None:
            if self._active._thread.is_alive():
                raise ImportFailure("busy")
            self._active._thread.join()
            self._active = None

    def start_execution(self, execution: Execution[T]) -> Execution[T]:
        with self._mutex:
            self._check()
            execution.control.remaining()
            self._active = execution
            try:
                execution._thread.start()
            except BaseException:
                self._active = None
                raise
            return execution

    def close(self) -> None:
        with self._mutex:
            if self._fd is None:
                return
            self._check()
            fd, self._fd = self._fd, None
            # Keep the lock inode in place so concurrent openers contend on the same file.
            os.close(fd)


@dataclass(frozen=True)
class Receipt:
    request_id: str
    state: str
    input_digest: str | None = None
    generation: str | None = None
    owner_epoch: str | None = None
    error_code: str | None = None
    doc_id: int | None = None
    snapshot_id: str | None = None
    cleanup_pending: bool = False
    reused: bool = False


@dataclass(frozen=True)
class Attempt:
    request_id: str
    input_digest: str
    generation: str
    owner_epoch: str
    control: Control


@dataclass(frozen=True)
class BeginResult:
    receipt: Receipt
    attempt: Attempt | None = None


@dataclass(frozen=True)
class AssetBytes:
    asset_id: str
    data: bytes
    mime: str
    width: int
    height: int


@dataclass(frozen=True)
class StagedAsset:
    asset_id: str
    relative_name: str
    mime: str
    width: int
    height: int
    byte_count: int
    sha256: str


@dataclass(frozen=True)
class FrozenDocument:
    payload: bytes
    version: str
    asset_ids: tuple[str, ...]
    row: dict
    blocks: str


@dataclass(frozen=True)
class SourceSnapshot:
    source_key: str
    snapshot_id: str
    extractor_version: str
    sanitizer_version: str
    metadata_json: bytes
    observation_json: bytes

    @classmethod
    def freeze(cls, prepared: dict, source_key: str, extractor_version: str, sanitizer_version: str,
               metadata_json: bytes, observation_json: bytes, assets: tuple[AssetBytes, ...]) -> tuple[SourceSnapshot, FrozenDocument]:
        norm_key = normalize_url(source_key).url
        asset_ids = tuple(asset.asset_id for asset in assets)
        row, blocks_json = prepared["row"], prepared["blocks"]
        blocks = json.loads(blocks_json)
        for block in blocks:
            block.pop("id", None)
            block.pop("asset_url", None)
            if block.get("type") == "image":
                block["asset_id"] = asset_ids.index(block["asset_id"])
        ordered = [
            {"sha256": hashlib.sha256(a.data).hexdigest(), "bytes": len(a.data), "mime": a.mime, "width": a.width, "height": a.height}
            for a in assets
        ]
        semantic = {"title": row["title"], "text": row["text"], "blocks": blocks, "metadata": json.loads(metadata_json), "assets": ordered}
        envelope = {
            "format": "wise-reader-url-snapshot-1", "source_key": norm_key,
            "extractor_version": extractor_version, "sanitizer_version": sanitizer_version,
            "semantic_sha256": hashlib.sha256(_canonical_json(semantic)).hexdigest(), "assets": ordered,
        }
        identity = hashlib.sha256(_canonical_json(envelope)).hexdigest()
        payload = json.dumps({"row": row, "version": identity, "blocks": blocks_json}, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        return cls(norm_key, identity, extractor_version, sanitizer_version, metadata_json, observation_json), FrozenDocument(payload, identity, asset_ids, row, blocks_json)


@dataclass(frozen=True)
class PreparedImport:
    source: SourceSnapshot
    document: FrozenDocument
    assets: tuple[StagedAsset, ...]
    stage_dir: Path
    manifest_sha256: str


class StageArea:
    """Manage staged and published URL asset bundles under .url-retained."""

    def __init__(self, library_directory: Path):
        self._root = library_directory / ".url-retained"
        self.staging_dir = self._root / ".staging"
        self.bundles_dir = self._root / "bundles"
        for path in (self._root, self.staging_dir, self.bundles_dir):
            path.mkdir(mode=0o700, exist_ok=True)

    def clean_staging(self) -> None:
        for entry in self.staging_dir.iterdir():
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)

    def prepare(self, source: SourceSnapshot, document: FrozenDocument, assets: tuple[AssetBytes, ...],
                raw_html: bytes, control: Control) -> PreparedImport:
        control.remaining()
        stage_dir = self.staging_dir / uuid4().hex
        stage_dir.mkdir(mode=0o700)
        try:
            members: list[tuple[str, bytes]] = [("document.json", document.payload), ("raw.html.bin", raw_html)]
            staged: list[StagedAsset] = []
            for asset in assets:
                name = uuid4().hex + (".png" if asset.mime == "image/png" else ".jpg")
                members.append((name, asset.data))
                staged.append(StagedAsset(asset.asset_id, name, asset.mime, asset.width, asset.height,
                                          len(asset.data), hashlib.sha256(asset.data).hexdigest()))
            manifest = json.dumps({
                "format": "url-bundle-1", "source_key": source.source_key, "snapshot_id": source.snapshot_id,
                "extractor_version": source.extractor_version, "sanitizer_version": source.sanitizer_version,
                "metadata_hex": source.metadata_json.hex(), "observation_hex": source.observation_json.hex(),
                "asset_ids": document.asset_ids, "assets": [vars(a) for a in staged],
                "members": [{"name": n, "bytes": len(d), "sha256": hashlib.sha256(d).hexdigest()} for n, d in members],
            }, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
            members.append(("manifest.json", manifest))
            for name, data in members:
                control.remaining()
                fd = os.open(stage_dir / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    os.write(fd, data)
                finally:
                    os.close(fd)
            control.remaining()
            return PreparedImport(source, document, tuple(staged), stage_dir, hashlib.sha256(manifest).hexdigest())
        except BaseException:
            self.discard(stage_dir)
            raise

    def publish(self, prepared: PreparedImport) -> tuple[str, str]:
        bundle_name = uuid4().hex
        prepared.stage_dir.rename(self.bundles_dir / bundle_name)
        return bundle_name, prepared.manifest_sha256

    def discard(self, stage_dir: Path) -> None:
        if stage_dir.exists() or stage_dir.is_symlink():
            shutil.rmtree(stage_dir, ignore_errors=True)

    def close(self) -> None:
        return None


class URLCommitter:
    """Receipt admission, request lifecycle, and SQLite publication for URL imports."""

    def __init__(self, store: Store):
        self.store = store
        self._gate = threading.RLock()
        self._attempt: Attempt | None = None
        self._execution: Execution | None = None
        self._execution_attempt: Attempt | None = None
        self._epoch = str(uuid4())
        self._recovery_ready = False
        self._stopping = False
        self._shutdown_lock = threading.Lock()
        self._owner = ExecutionOwner(store.path.parent)
        try:
            self.staging = StageArea(store.path.parent)
            with self._gate, store.transaction():
                has_lib = store.query_one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wr_url_library'")
                row = store.query_one("SELECT library_id FROM wr_url_library LIMIT 1") if has_lib else None
                store.executescript("""
                CREATE TABLE IF NOT EXISTS wr_url_library (singleton INTEGER PRIMARY KEY CHECK(singleton=1), library_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS wr_url_request (
                    request_id TEXT PRIMARY KEY, input_digest TEXT, original_url TEXT,
                    generation TEXT NOT NULL, owner_epoch TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('running','committed','failed','cancelled','interrupted')),
                    doc_id INTEGER, snapshot_id TEXT, error_code TEXT, created_at TEXT NOT NULL, completed_at TEXT);
                CREATE TABLE IF NOT EXISTS wr_url_snapshot (
                    snapshot_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, doc_id INTEGER UNIQUE,
                    bundle_name TEXT NOT NULL UNIQUE, manifest_hash TEXT NOT NULL,
                    extractor_version TEXT NOT NULL, sanitizer_version TEXT NOT NULL, metadata_json BLOB NOT NULL,
                    availability TEXT NOT NULL CHECK(availability IN ('ready','unavailable','deleted')));
                CREATE TABLE IF NOT EXISTS wr_url_asset (
                    snapshot_id TEXT NOT NULL, asset_id TEXT NOT NULL, relative_name TEXT NOT NULL, mime TEXT NOT NULL,
                    width INTEGER NOT NULL, height INTEGER NOT NULL, byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL,
                    PRIMARY KEY(snapshot_id, asset_id), UNIQUE(snapshot_id, relative_name));
                CREATE TABLE IF NOT EXISTS wr_url_observation (
                    request_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, original_url TEXT NOT NULL,
                    final_url TEXT NOT NULL, fetched_at TEXT NOT NULL, raw_html_hash TEXT NOT NULL,
                    observation_json BLOB NOT NULL, bundle_name TEXT NOT NULL);
                """)
                if row is None:
                    self._library_id = str(uuid4())
                    store.execute("INSERT INTO wr_url_library(singleton, library_id) VALUES(1, ?)", (self._library_id,))
                else:
                    self._library_id = str(UUID(row["library_id"]))
                if "manifest_hash" not in {r["name"] for r in store.query("PRAGMA table_info(wr_url_observation)")}:
                    store.execute("ALTER TABLE wr_url_observation ADD COLUMN manifest_hash TEXT")
                if "removed_docs" not in {r["name"] for r in store.query("PRAGMA table_info(wr_url_snapshot)")}:
                    store.execute("ALTER TABLE wr_url_snapshot ADD COLUMN removed_docs TEXT NOT NULL DEFAULT '[]'")
                    for snap in store.query("SELECT snapshot_id FROM wr_url_snapshot WHERE availability='deleted'"):
                        ids = [r["doc_id"] for r in store.query(
                            "SELECT DISTINCT doc_id FROM wr_url_request WHERE snapshot_id=? AND state='committed' ORDER BY doc_id",
                            (snap["snapshot_id"],)) if r["doc_id"] is not None]
                        store.execute("UPDATE wr_url_snapshot SET removed_docs=? WHERE snapshot_id=?", (json.dumps(ids), snap["snapshot_id"]))
                store.execute("UPDATE wr_url_request SET state='interrupted', error_code='owner_interrupted', completed_at=? WHERE state='running'", (_now(),))
            self.staging.clean_staging()
            self._recovery_ready = True
        except BaseException:
            if hasattr(self, "staging"):
                self.staging.close()
            self._owner.close()
            raise

    def _lifetime(self) -> None:
        if self._owner._fd is None:
            raise ImportFailure("owner_closed")

    def identity(self) -> str:
        with self._gate:
            self._lifetime()
            return self._library_id

    @staticmethod
    def _request_id(value: str) -> str:
        try:
            if str(UUID(value)) != value:
                raise ValueError
        except (ValueError, TypeError, AttributeError) as exc:
            raise ImportFailure("invalid_request_id") from exc
        return value

    @staticmethod
    def _removed_docs(snapshot: dict) -> list[int]:
        raw = snapshot.get("removed_docs", "[]")
        ids = json.loads(raw) if isinstance(raw, str) else []
        return [int(i) for i in ids] if isinstance(ids, list) else []

    def _receipt_for_row(self, row: dict) -> Receipt:
        rid, st, digest, gen, ep, err = row["request_id"], row["state"], row["input_digest"], row["generation"], row["owner_epoch"], row["error_code"]
        if st != "committed":
            return Receipt(rid, st, digest, gen, ep, err)
        snap = self.store.query_one("SELECT * FROM wr_url_snapshot WHERE snapshot_id=?", (row["snapshot_id"],))
        if snap is None:
            return Receipt(rid, "unavailable", digest, gen, ep, "closure_invalid")
        if row["doc_id"] in self._removed_docs(snap) or (snap["availability"] == "deleted" and snap["doc_id"] is None):
            return Receipt(rid, "source_removed", digest, gen, ep, "source_removed")
        if snap["availability"] != "ready" or snap["doc_id"] != row["doc_id"]:
            return Receipt(rid, "unavailable", digest, gen, ep, "closure_invalid")
        earliest = self.store.query_one(
            "SELECT o.request_id FROM wr_url_observation o JOIN wr_url_request r ON r.request_id=o.request_id "
            "WHERE r.snapshot_id=? AND r.doc_id=? AND r.state='committed' ORDER BY o.rowid LIMIT 1",
            (row["snapshot_id"], row["doc_id"]))
        reused = earliest is not None and earliest["request_id"] != rid
        return Receipt(rid, "committed", digest, gen, ep, None, row["doc_id"], row["snapshot_id"], reused=reused)

    def status(self, request_id: str) -> Receipt:
        request_id = self._request_id(request_id)
        with self._gate:
            self._lifetime()
            row = self.store.query_one("SELECT * FROM wr_url_request WHERE request_id=?", (request_id,))
            return Receipt(request_id, "not_found") if row is None else self._receipt_for_row(row)

    def begin(self, request_id: str, url: str, control: Control) -> BeginResult:
        request_id = self._request_id(request_id)
        digest = hashlib.sha256(normalize_url(url).url.encode("utf-8")).hexdigest()
        with self._gate:
            self._lifetime()
            if self._stopping:
                raise ImportFailure("stopping")
            current = self.status(request_id)
            if current.state != "not_found":
                if current.input_digest is not None and current.input_digest != digest:
                    raise ImportFailure("request_conflict")
                return BeginResult(current)
            if not self._recovery_ready:
                raise ImportFailure("recovery_incomplete")
            self._owner._check()
            if self.store.query_one("SELECT 1 FROM wr_url_request WHERE state='running' LIMIT 1"):
                raise ImportFailure("busy")
            control.remaining()
            attempt = Attempt(request_id, digest, str(uuid4()), self._epoch, control)
            with self.store.transaction():
                self.store.execute(
                    "INSERT INTO wr_url_request (request_id, input_digest, original_url, generation, owner_epoch, state, created_at) "
                    "VALUES (?, ?, ?, ?, ?, 'running', ?)",
                    (request_id, digest, url, attempt.generation, self._epoch, _now()))
            self._attempt, self._execution = attempt, None
            return BeginResult(self.status(request_id), attempt)

    def _verify_attempt(self, attempt: Attempt) -> None:
        self._lifetime()
        if attempt is not self._attempt:
            raise ImportFailure("stale_attempt")
        attempt.control.remaining()
        current = self.store.query_one("SELECT state, generation, owner_epoch, input_digest FROM wr_url_request WHERE request_id=?", (attempt.request_id,))
        if (current is None or current["state"] != "running" or current["generation"] != attempt.generation
                or current["owner_epoch"] != self._epoch or current["input_digest"] != attempt.input_digest):
            raise ImportFailure("attempt_unconfirmed")

    def start(self, attempt: Attempt, execution: Execution[T]) -> Execution[T]:
        with self._gate:
            if self._stopping:
                raise ImportFailure("stopping")
            self._verify_attempt(attempt)
            if self._execution is not None:
                raise ImportFailure("attempt_already_started")
            self._owner.start_execution(execution)
            self._execution, self._execution_attempt = execution, attempt
            return execution

    def cancel(self, request_id: str) -> Receipt:
        request_id = self._request_id(request_id)
        with self._gate:
            self._lifetime()
            current = self.status(request_id)
            if current.state not in ("not_found", "running"):
                return current
            now = _now()
            with self.store.transaction():
                if current.state == "not_found":
                    self.store.execute(
                        "INSERT INTO wr_url_request (request_id, generation, owner_epoch, state, error_code, created_at, completed_at) "
                        "VALUES (?, ?, ?, 'cancelled', 'cancelled', ?, ?)", (request_id, str(uuid4()), self._epoch, now, now))
                else:
                    self.store.execute("UPDATE wr_url_request SET state='cancelled', error_code='cancelled', completed_at=? WHERE request_id=? AND state='running'", (now, request_id))
            if self._attempt is not None and self._attempt.request_id == request_id:
                self._attempt.control.cancel()
                self._attempt = None
            return self.status(request_id)

    def execute(self, attempt: Attempt, execution: Execution) -> Receipt:
        self.start(attempt, execution)
        execution.join()
        return self.finish(attempt, execution)

    def finish(self, attempt: Attempt, execution: Execution) -> Receipt:
        with self._gate:
            self._lifetime()
            if execution is not self._execution or attempt is not self._execution_attempt:
                raise ImportFailure("execution_mismatch")
            if execution._thread.is_alive():
                raise ImportFailure("running")
            row = self.store.query_one("SELECT state FROM wr_url_request WHERE request_id=?", (attempt.request_id,))
            if row is not None and row["state"] == "running":
                try:
                    value = execution.result()
                except Exception as exc:
                    code = exc.code if isinstance(exc, ImportFailure) else type(exc).__name__
                    with self.store.transaction():
                        self.store.execute(
                            "UPDATE wr_url_request SET state='failed', error_code=?, completed_at=? "
                            "WHERE request_id=? AND state='running' AND generation=? AND owner_epoch=?",
                            (code[:128], _now(), attempt.request_id, attempt.generation, attempt.owner_epoch))
                else:
                    if isinstance(value, Receipt) and value.state == "unknown":
                        return value
            return self.status(attempt.request_id)

    def commit(self, attempt: Attempt, prepared: PreparedImport, engine) -> Receipt:
        source = prepared.source
        observation = json.loads(source.observation_json)
        attempt.control.remaining()
        published_bundle: str | None = None
        try:
            with self._gate:
                self._verify_attempt(attempt)
                if not self.store.is_plugin_enabled("importer"):
                    raise ImportFailure("importer_disabled")
                existing = self.store.query_one("SELECT * FROM wr_url_snapshot WHERE snapshot_id=?", (source.snapshot_id,))
                doc_input = {"row": prepared.document.row, "version": source.snapshot_id, "blocks": prepared.document.blocks}
                with self.store.transaction():
                    if existing is not None and existing["availability"] == "ready" and existing["doc_id"] is not None:
                        doc_id, bundle_name, manifest_hash = existing["doc_id"], existing["bundle_name"], existing["manifest_hash"]
                    else:
                        if existing is not None and (self.staging.bundles_dir / existing["bundle_name"]).is_dir():
                            bundle_name, manifest_hash = existing["bundle_name"], existing["manifest_hash"]
                        else:
                            published_bundle, manifest_hash = self.staging.publish(prepared)
                            bundle_name = published_bundle
                        doc_id = engine.persist_import(doc_input, cache_analysis=False)["id"]
                        if existing is None:
                            self.store.execute(
                                "INSERT INTO wr_url_snapshot (snapshot_id, source_key, doc_id, bundle_name, manifest_hash, "
                                "extractor_version, sanitizer_version, metadata_json, availability) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready')",
                                (source.snapshot_id, source.source_key, doc_id, bundle_name, manifest_hash,
                                 source.extractor_version, source.sanitizer_version, source.metadata_json))
                            for asset in prepared.assets:
                                self.store.execute(
                                    "INSERT INTO wr_url_asset (snapshot_id, asset_id, relative_name, mime, width, height, byte_count, sha256) "
                                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                    (source.snapshot_id, asset.asset_id, asset.relative_name, asset.mime,
                                     asset.width, asset.height, asset.byte_count, asset.sha256))
                        else:
                            self.store.execute(
                                "UPDATE wr_url_snapshot SET doc_id=?, availability='ready', bundle_name=?, manifest_hash=? WHERE snapshot_id=?",
                                (doc_id, bundle_name, manifest_hash, source.snapshot_id))
                    self.store.execute(
                        "INSERT INTO wr_url_observation (request_id, snapshot_id, original_url, final_url, fetched_at, "
                        "raw_html_hash, observation_json, bundle_name, manifest_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (attempt.request_id, source.snapshot_id, observation["original_url"], observation["final_url"],
                         observation["fetched_at"], observation["raw_html_sha256"], source.observation_json, bundle_name, manifest_hash))
                    changed = self.store.execute(
                        "UPDATE wr_url_request SET state='committed', doc_id=?, snapshot_id=?, completed_at=? "
                        "WHERE request_id=? AND state='running' AND generation=? AND owner_epoch=?",
                        (doc_id, source.snapshot_id, _now(), attempt.request_id, attempt.generation, attempt.owner_epoch))
                    if changed.rowcount != 1:
                        raise ImportFailure("attempt_unconfirmed")
                published_bundle = None
                self.staging.discard(prepared.stage_dir)
                return self.status(attempt.request_id)
        except BaseException:
            if published_bundle is not None:
                shutil.rmtree(self.staging.bundles_dir / published_bundle, ignore_errors=True)
            self.staging.discard(prepared.stage_dir)
            raise

    def read_asset(self, snapshot_id: str, asset_id: str) -> AssetBytes:
        if len(snapshot_id) != 64 or any(c not in "0123456789abcdef" for c in snapshot_id):
            raise ImportFailure("invalid_snapshot_id")
        if not asset_id or len(asset_id) > 128:
            raise ImportFailure("invalid_asset_id")
        with self._gate:
            self._lifetime()
            snapshot = self.store.query_one("SELECT * FROM wr_url_snapshot WHERE snapshot_id=?", (snapshot_id,))
            if snapshot is None:
                raise ImportFailure("not_found")
            if snapshot["availability"] != "ready" or snapshot["doc_id"] is None:
                raise ImportFailure("unavailable")
            row = self.store.query_one("SELECT * FROM wr_url_asset WHERE snapshot_id=? AND asset_id=?", (snapshot_id, asset_id))
            if row is None:
                raise ImportFailure("not_found")
            bundles_root = self.staging.bundles_dir.resolve()
            asset_path = (bundles_root / snapshot["bundle_name"] / row["relative_name"]).resolve()
            if not asset_path.is_relative_to(bundles_root) or not asset_path.is_file():
                raise ImportFailure("unavailable")
            return AssetBytes(asset_id, asset_path.read_bytes(), row["mime"], row["width"], row["height"])

    def delete_document(self, doc_id: int) -> str:
        if type(doc_id) is not int or doc_id <= 0:
            raise ImportFailure("invalid_document_id")
        with self._gate, self.store.transaction():
            self._lifetime()
            snapshot = self.store.query_one("SELECT * FROM wr_url_snapshot WHERE doc_id=?", (doc_id,))
            if snapshot is None:
                raise ImportFailure("url_document_not_found")
            removed = self._removed_docs(snapshot)
            self.store.delete_document(doc_id)
            self.store.execute(
                "UPDATE wr_url_snapshot SET doc_id=NULL, availability='deleted', removed_docs=? WHERE snapshot_id=? AND doc_id=?",
                (json.dumps([*removed, doc_id]), snapshot["snapshot_id"], doc_id))
            return "source_removed"

    @staticmethod
    def _source_payload(snapshot: dict, observation: dict | None) -> dict | None:
        if snapshot["availability"] != "ready" or observation is None:
            return None
        metadata = json.loads(snapshot["metadata_json"])
        return {
            "snapshot_id": snapshot["snapshot_id"], "original_url": observation["original_url"],
            "final_url": observation["final_url"], "fetched_at": observation["fetched_at"],
            "author": metadata.get("author"), "published_at": metadata.get("published_at"),
        }

    @staticmethod
    def list_documents(store: Store, committer: URLCommitter | None) -> list[dict]:
        if committer is not None and committer.store is not store:
            raise ImportFailure("unknown")
        with committer._gate if committer is not None else nullcontext(), store._lock:
            rows = store.list_documents()
            if not rows or not store.query_one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wr_url_snapshot'"):
                return rows
            snapshots = {s["doc_id"]: s for s in store.query("SELECT * FROM wr_url_snapshot WHERE doc_id IS NOT NULL")}
            if not snapshots:
                return rows
            if committer is None:
                return [{**r, "availability": "unknown", "source": None} if r["id"] in snapshots else r for r in rows]
            committer._lifetime()
            obs_by_snap: dict[str, dict] = {}
            for obs in store.query("SELECT * FROM wr_url_observation ORDER BY rowid"):
                obs_by_snap.setdefault(obs["snapshot_id"], obs)
            result = []
            for row in rows:
                snap = snapshots.get(row["id"])
                if snap is None:
                    result.append(row)
                else:
                    src = URLCommitter._source_payload(snap, obs_by_snap.get(snap["snapshot_id"]))
                    result.append({**row, "availability": "ready" if src else "unavailable", "source": src})
            return result

    @staticmethod
    @contextmanager
    def document_access(store: Store, doc_id: int, committer: URLCommitter | None):
        if type(doc_id) is not int or doc_id <= 0:
            raise ImportFailure("invalid_document_id")
        if committer is not None and committer.store is not store:
            raise ImportFailure("unknown")
        with committer._gate if committer is not None else nullcontext(), store._lock:
            if not store.query_one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wr_url_snapshot'"):
                yield None
                return
            snapshot = store.query_one("SELECT * FROM wr_url_snapshot WHERE doc_id=?", (doc_id,))
            if snapshot is None:
                removed = store.query_one("SELECT 1 FROM wr_url_request WHERE doc_id=? AND state='committed' LIMIT 1", (doc_id,))
                yield ({"availability": "source_removed", "source": None} if removed is not None else None)
                return
            if committer is None:
                yield {"availability": "unknown", "source": None}
                return
            committer._lifetime()
            obs = store.query_one("SELECT * FROM wr_url_observation WHERE snapshot_id=? ORDER BY rowid LIMIT 1", (snapshot["snapshot_id"],))
            src = URLCommitter._source_payload(snapshot, obs)
            yield {"availability": "ready" if src else "unavailable", "source": src}

    @property
    def stopping(self) -> bool:
        with self._gate:
            return self._stopping

    @property
    def recovery_ready(self) -> bool:
        with self._gate:
            return self._recovery_ready and not self._stopping and self._owner._fd is not None

    def stop_admission(self) -> None:
        with self._gate:
            self._stopping = True

    def shutdown(self) -> Receipt | None:
        self.stop_admission()
        with self._shutdown_lock:
            with self._gate:
                if self._owner._fd is None:
                    return None
                self._lifetime()
                execution, attempt = self._execution, self._execution_attempt
            if execution is not None:
                execution.join()
            result, errors = None, []
            for step in (
                lambda: self.finish(attempt, execution) if execution is not None and attempt is not None else None,
                self.close,
            ):
                try:
                    value = step()
                    if value is not None:
                        result = value
                except BaseException as exc:
                    errors.append(exc)
            if errors:
                raise BaseExceptionGroup("URL shutdown failed", errors)
            return result

    def close(self) -> None:
        with self._gate:
            if self._owner._fd is None:
                return
            self._owner._check()
            self._stopping = True
            errors = []
            for action in (
                lambda: self._attempt.control.cancel() if self._attempt is not None else None,
                self.staging.close,
                self._owner.close,
            ):
                try:
                    action()
                except BaseException as exc:
                    errors.append(exc)
            self._attempt = None
            if errors:
                raise BaseExceptionGroup("URL cleanup failed", errors)
