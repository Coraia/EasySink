"""On-demand formula sidecars. The reader process never imports model libraries."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import time
import uuid

from fastapi import HTTPException

from wise_reader.pdf_lab.worker import checked_result, registered_path, safe_asset, atomic_json
from .uploads import error

SETTINGS = {"version": 1, "device": "cpu", "providers": ["CPUExecutionProvider"],
            "intra_threads": 4, "inter_threads": 1, "batch_size": 1,
            "interline_enable": True, "label": "display_formula", "color": "RGB"}
MAX_CROP_BYTES = 16 * 1024**2
MAX_CROP_PIXELS = 16_000_000
MODEL_FILE = "MFR/pp_formulanet_plus_m/PP-FormulaNet_plus-M.onnx"
CONFIG_FILE = "MFR/pp_formulanet_plus_m/PP-FormulaNet_plus-M_inference.yml"
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
ACTIVE = {"queued", "running"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def file_hash(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024**2), b""):
            sha.update(chunk)
    return sha.hexdigest()


def runtime_spec():
    from wise_reader.pdf_lab.adapters.mineru_runtime import discover_mineru_runtime
    runtime = discover_mineru_runtime()
    # Discovery validates the pinned manifest identity and file stats. Hash only
    # in the inference child, never gigabytes on a cache hit or status request.
    manifest = json.loads(runtime.manifest.read_text())
    hashes = {r["file"]: r["sha256"] for r in manifest["files"] if r["root"] == "models"}
    return runtime, {"runtime_identity": runtime.identity,
                     "model_sha256": hashes[MODEL_FILE], "config_sha256": hashes[CONFIG_FILE]}


class FormulaService:
    """Lifecycle callbacks do not acquire module.control_lock (caller owns it)."""

    def __init__(self, module, *, queue_size=8, timeout=120):
        self.module = module
        self.root = module.originals.root / "formula-cache"
        self.database = self.root / "cache.sqlite3"
        self.queue = asyncio.Queue(maxsize=queue_size)
        self.timeout = timeout
        self.lock = asyncio.Lock()
        self.runner = None
        self.process = None
        self.active_job = None
        self.closing = False
        self.ready = False
        self.service_lock = None
        self.locations = {}
        self.source_stats = {}

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.database, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self):
        self.root.mkdir(mode=0o700, exist_ok=True)
        if self.root.is_symlink() or not self.root.resolve().is_relative_to(self.module.originals.root):
            raise ValueError("Formula cache must belong to the originals registry.")
        self.service_lock = (self.root / "service.lock").open("a+")
        try:
            fcntl.flock(self.service_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.db() as db:
                db.executescript("""
                    PRAGMA journal_mode=WAL;
                    PRAGMA synchronous=FULL;
                    CREATE TABLE IF NOT EXISTS cache (
                        key TEXT PRIMARY KEY, base TEXT NOT NULL, identity TEXT NOT NULL,
                        result TEXT NOT NULL, created REAL NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS cache_base ON cache(base,created);
                    CREATE TABLE IF NOT EXISTS jobs (
                        id TEXT PRIMARY KEY, book INTEGER NOT NULL, key TEXT NOT NULL,
                        status TEXT NOT NULL, payload TEXT NOT NULL, context TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS jobs_book_key ON jobs(book,key,status);
                """)
                for row in db.execute("SELECT * FROM jobs WHERE status IN ('queued','running')").fetchall():
                    payload = json.loads(row["payload"])
                    payload.update(status="failed", updated_at=time.time(), error={
                        "code": "formula_interrupted", "message": "Recognition was interrupted; retry this formula.",
                        "retryable": True})
                    db.execute("UPDATE jobs SET status='failed',payload=? WHERE id=?",
                               (json.dumps(payload), row["id"]))
        except BaseException:
            self.service_lock.close()
            self.service_lock = None
            raise

    async def start(self):
        if self.ready:
            return
        async with self.lock:
            if self.ready:
                return
            try:
                await asyncio.to_thread(self._initialize)
            except (OSError, ValueError, sqlite3.Error):
                # Formula storage/lock failure must not prevent ordinary reading.
                return
            self.closing = False
            self.ready = True
            self.runner = asyncio.create_task(self._work(), name="formula-cpu-queue")

    async def close(self):
        self.closing = True
        if self.runner:
            self.runner.cancel()
            await asyncio.gather(self.runner, return_exceptions=True)
        if self.ready:
            await asyncio.to_thread(self._cancel, None, "formula_interrupted")
        if self.service_lock:
            self.service_lock.close()
            self.service_lock = None
        self.ready = False

    def _cancel(self, book_id, code):
        with self.db() as db:
            rows = db.execute("SELECT * FROM jobs WHERE status IN ('queued','running')").fetchall()
            for row in rows:
                if book_id is not None and row["book"] != book_id:
                    continue
                payload = json.loads(row["payload"])
                payload.update(status="cancelled", updated_at=time.time(), error={
                    "code": code, "message": "Formula recognition stopped; the original image is retained.",
                    "retryable": True})
                db.execute("UPDATE jobs SET status='cancelled',payload=? WHERE id=?",
                           (json.dumps(payload), row["id"]))

    async def processing_changed(self, enabled):
        if self.ready and not enabled:
            await asyncio.to_thread(self._cancel, None, "processing_disabled")
            await self._terminate(self.process)

    async def cancel_book(self, book_id):
        if self.ready:
            await asyncio.to_thread(self._cancel, book_id, "book_lifecycle_changed")
            if self.active_job and self.active_job["book_id"] == book_id:
                await self._terminate(self.process)

    def _resolve(self, book_id, task_id, formula_id):
        if not all(isinstance(v, str) and IDENTIFIER.fullmatch(v) for v in (task_id, formula_id)):
            raise error(422, "invalid_formula_identity", "Use registered task and formula identifiers.")
        mapping, book = self.module.source_book(book_id)
        task = self.module.originals.task(task_id)
        if not task or task["book_id"] != book["id"]:
            raise error(404, "formula_not_found", "No registered formula belongs to this book and task.")
        try:
            output = self.module.originals.output(task)
            if output.is_symlink() or not output.resolve().is_relative_to((self.module.originals.root / "tasks").resolve()):
                raise ValueError("Invalid task owner.")
            original = self.module.originals.source(book)
            if original.is_symlink() or not original.resolve().is_relative_to((self.module.originals.root / "originals").resolve()):
                raise ValueError("Invalid source owner.")
            stat = original.stat()
            signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            if stat.st_size != book["byte_size"] or mapping["source_sha256"] != book["file_sha256"]:
                raise ValueError("Source size or registry identity changed.")
            if self.source_stats.get(book["id"]) != signature:
                if file_hash(original) != book["file_sha256"]:
                    raise ValueError("Original checksum changed.")
                if len(self.source_stats) >= 256:
                    self.source_stats.clear()
                self.source_stats[book["id"]] = signature
            hint = self.locations.get((task_id, formula_id))
            if hint is None:
                # Converter's ID prefix is only an index hint, never authority:
                # checked_result still requires publication and exact region ID.
                prefix = re.fullmatch(r"p(\d{6,})-f[0-9a-f]{20}", formula_id)
                if prefix:
                    hint = int(prefix[1])
            numbers = [hint] if hint else self.module.workers.published_pages(task)
            selected = None
            for number in numbers:
                result = checked_result(output / "published.json", task, book, number, number)
                if result["schema_version"] != 2:
                    continue
                for page in result["pages"]:
                    for region in page.get("formula_regions", []):
                        if not isinstance(region, dict) or region.get("formula_id") != formula_id:
                            continue
                        if selected is not None:
                            raise ValueError("Ambiguous formula identity.")
                        selected = (page, region)
            if not selected:
                raise error(404, "formula_not_found", "This formula is not in the task's published pages.")
            page, region = selected
            source = region.get("source", {})
            box = source.get("bbox")
            if source.get("page_number") != page["page_number"] or not isinstance(box, list) or len(box) != 4:
                raise ValueError("Formula source does not match its page.")
            if any(type(v) not in (int, float) or not math.isfinite(v) for v in box):
                raise ValueError("Invalid formula coordinates.")
            if not (0 <= box[0] < box[2] <= page["width"] + .1 and 0 <= box[1] < box[3] <= page["height"] + .1):
                raise ValueError("Formula leaves its source page.")
            relative = region["asset"]
            path = safe_asset(output, relative)
            metadata = page.get("assets", {}).get(relative)
            if not isinstance(metadata, dict):
                raise ValueError("No registered crop metadata.")
            size = path.stat().st_size
            if type(metadata.get("bytes")) is not int or not 0 < size == metadata["bytes"] <= MAX_CROP_BYTES:
                raise ValueError("Crop size changed or exceeds the formula budget.")
            width, height = metadata.get("width_px"), metadata.get("height_px")
            if not all(type(v) is int and v > 0 for v in (width, height)) or width * height > MAX_CROP_PIXELS:
                raise ValueError("Crop exceeds the image budget.")
            sha = file_hash(path)
            if sha != metadata.get("sha256"):
                raise ValueError("Crop checksum changed.")
            if len(self.locations) >= 4096:
                self.locations.clear()
            self.locations[(task_id, formula_id)] = page["page_number"]
            return {"book_id": book_id, "task_id": task_id, "formula_id": formula_id,
                    "generation": mapping["generation"], "source_sha256": book["file_sha256"],
                    "page_number": page["page_number"], "crop_sha256": sha,
                    "source": {"page_number": page["page_number"], "bbox": box},
                    "asset": relative, "bytes": size, "width_px": width, "height_px": height}
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
            raise error(409, "formula_asset_invalid", "The retained formula image or source could not be verified.")

    @staticmethod
    def _base(selection):
        return {k: selection[k] for k in ("source_sha256", "page_number", "crop_sha256")} | {"settings": SETTINGS}

    def _cache(self, selection):
        base = self._base(selection)
        # Runtime absence must never hide a retained successful result. A ready
        # runtime pins lookups to its current model identity, without model hashing.
        try:
            model = runtime_spec()[1] if self.module.enabled() else None
        except (RuntimeError, OSError, ValueError, KeyError, ImportError):
            model = None
        with self.db() as db:
            rows = db.execute("SELECT * FROM cache WHERE base=? ORDER BY created DESC", (digest(base),)).fetchall()
        for row in rows:
            try:
                identity, result = json.loads(row["identity"]), json.loads(row["result"])
                if digest(identity) != row["key"] or any(identity.get(k) != v for k, v in base.items()):
                    continue
                if model and any(identity.get(k) != v for k, v in model.items()):
                    continue
                if not isinstance(result.get("latex"), str) or not 0 < len(result["latex"].strip()) <= 65536:
                    continue
                with self.db() as db:
                    receipts = db.execute("SELECT id,payload FROM jobs WHERE book=? AND key=? AND status='completed'",
                                          (selection["book_id"], row["key"])).fetchall()
                receipt = next((r for r in receipts if all(json.loads(r["payload"]).get(k) == selection[k]
                               for k in ("task_id", "formula_id"))), None)
                now = row["created"]
                job = {"id": receipt["id"] if receipt else uuid.uuid4().hex, "book_id": selection["book_id"],
                        "task_id": selection["task_id"], "formula_id": selection["formula_id"],
                        "status": "completed", "cached": True, "latex": result["latex"], "error": None,
                        "created_at": now, "updated_at": now, "source": selection["source"],
                        "cache_key": row["key"], "quality": "unreviewed", "timings": result.get("timings", {})}
                if receipt is None:
                    # Reprocessed versions may reuse the same verified crop, but
                    # their pollable receipt must retain the new source identity.
                    self._save(job, {"selection": selection, "identity": identity})
                return job
            except (ValueError, TypeError, KeyError):
                continue
        return None

    def _job(self, job_id):
        with self.db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return (json.loads(row["payload"]), json.loads(row["context"])) if row else (None, None)

    def _save(self, job, context):
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?,?)",
                       (job["id"], job["book_id"], job["cache_key"], job["status"], json.dumps(job), json.dumps(context)))

    def _inflight(self, selection):
        with self.db() as db:
            rows = db.execute("SELECT payload,context FROM jobs WHERE book=? AND status IN ('queued','running')",
                              (selection["book_id"],)).fetchall()
        for row in rows:
            context = json.loads(row["context"])
            if (context["selection"]["generation"] == selection["generation"]
                    and all(context["selection"][k] == selection[k] for k in ("task_id", "formula_id"))
                    and self._base(context["selection"]) == self._base(selection)):
                return json.loads(row["payload"])
        return None

    async def lookup(self, book_id, task_id, formula_id):
        if not self.ready:
            raise error(503, "formula_service_not_ready", "Formula service is starting; original images remain available.")
        selected = await asyncio.to_thread(self._resolve, book_id, task_id, formula_id)
        cached = await asyncio.to_thread(self._cache, selected)
        return cached or await asyncio.to_thread(self._inflight, selected)

    def _guard(self, selected):
        mapping, _ = self.module.source_book(selected["book_id"])
        if self.closing:
            raise error(503, "formula_service_stopping", "Formula service is stopping.")
        if not self.module.enabled():
            raise error(409, "processing_disabled", "Enable PDF processing to recognize a new formula.")
        if mapping["lifecycle"] != "active":
            raise error(409, "book_recycled", "Restore this PDF before recognizing a new formula.")
        if mapping["generation"] != selected["generation"]:
            raise error(409, "book_lifecycle_changed", "Book processing changed; retry this formula.")

    async def submit(self, book_id, task_id, formula_id):
        if not self.ready:
            raise error(503, "formula_service_not_ready", "Formula service is starting; original images remain available.")
        async with self.lock:
            selected = await asyncio.to_thread(self._resolve, book_id, task_id, formula_id)
            cached = await asyncio.to_thread(self._cache, selected)
            if cached:
                return cached
            self._guard(selected)
            shared = await asyncio.to_thread(self._inflight, selected)
            if shared:
                return shared
            if self.queue.full():
                raise error(429, "formula_queue_full", "The local formula queue is full; retry shortly.")
            try:
                runtime, model = await asyncio.to_thread(runtime_spec)
            except (RuntimeError, OSError, ValueError, KeyError, ImportError):
                raise error(503, "formula_runtime_not_ready", "The local CPU formula runtime is not ready; the original image remains available.")
            identity = self._base(selected) | model
            now = time.time()
            job = {"id": uuid.uuid4().hex, "book_id": book_id, "task_id": task_id, "formula_id": formula_id,
                   "status": "queued", "cached": False, "latex": None, "error": None,
                   "created_at": now, "updated_at": now, "source": selected["source"],
                   "cache_key": digest(identity), "quality": "unreviewed", "timings": {}}
            context = {"selection": selected, "identity": identity}
            async with self.module.control_lock:
                self._guard(selected)
                await asyncio.to_thread(self._save, job, context)
                self.queue.put_nowait(job["id"])
            return job

    async def status(self, book_id, job_id):
        if not self.ready or not IDENTIFIER.fullmatch(job_id):
            raise error(404, "formula_job_not_found", "Formula job is unavailable.")
        job, context = await asyncio.to_thread(self._job, job_id)
        if job is None:
            raise error(404, "formula_job_not_found", "Formula job is unavailable.")
        if job["book_id"] != book_id:
            raise error(404, "formula_job_not_found", "Formula job does not belong to this book.")
        selected = await asyncio.to_thread(self._resolve, book_id, job["task_id"], job["formula_id"])
        if self._base(selected) != self._base(context["selection"]):
            raise error(409, "formula_asset_invalid", "The formula source changed after this job was created.")
        return job

    async def _terminate(self, process):
        if process is None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), 2)
        except asyncio.TimeoutError:
            pass
        # Kill the whole group even if its leader has already exited.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await asyncio.wait_for(process.wait(), 2)

    async def _drain(self, stream):
        tail = b""
        while chunk := await stream.read(8192):
            tail = (tail + chunk)[-32768:]
        return tail.decode("utf-8", errors="replace")

    async def _wait_runtime(self, selected):
        """Keep the request queued while an import uses the shared CPU runtime."""
        runtime, _ = await asyncio.to_thread(runtime_spec)
        started = time.monotonic()
        with (runtime.manifest.parent / "inference.lock").open("a+") as lease:
            while True:
                self._guard(selected)
                try:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    if time.monotonic() - started >= self.timeout:
                        raise error(504, "formula_queue_timeout", "本机仍在处理阅读内容，请稍后重试；原式已保留。")
                    await asyncio.sleep(.25)
                else:
                    fcntl.flock(lease, fcntl.LOCK_UN)
                    return

    async def _infer(self, job, context):
        from wise_reader.pdf_lab.adapters.mineru_runtime import runtime_environment
        runtime, model = await asyncio.to_thread(runtime_spec)
        if any(context["identity"].get(k) != v for k, v in model.items()):
            raise error(409, "formula_runtime_changed", "The formula runtime changed; retry recognition.")
        selected = context["selection"]
        work = self.root / "jobs" / job["id"]
        await asyncio.to_thread(work.mkdir, parents=True, exist_ok=True, mode=0o700)
        task = self.module.originals.task(selected["task_id"])
        crop = registered_path(self.module.originals.output(task), selected["asset"])
        request = {"crop": str(crop), "crop_sha256": selected["crop_sha256"],
                   "bytes": selected["bytes"], "width_px": selected["width_px"], "height_px": selected["height_px"],
                   "model": str(runtime.models / MODEL_FILE), "config": str(runtime.models / CONFIG_FILE),
                   "identity": context["identity"], "settings": SETTINGS,
                   "lock": str(runtime.manifest.parent / "inference.lock"), "parent_pid": os.getpid()}
        await asyncio.to_thread(atomic_json, work / "input.json", request)
        env = await asyncio.to_thread(runtime_environment, runtime, work / "runtime")
        script = Path(__file__).resolve().parents[3] / "scripts/formula_recognize.py"
        self._guard(selected)
        spawn = asyncio.create_task(asyncio.create_subprocess_exec(
            str(runtime.python), str(script), "--input", str(work / "input.json"), "--output", str(work / "result.json"),
            cwd=work, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True))
        drains = []
        try:
            try:
                self.process = await asyncio.shield(spawn)
            except asyncio.CancelledError:
                self.process = await spawn
                raise
            drains = [asyncio.create_task(self._drain(self.process.stdout)), asyncio.create_task(self._drain(self.process.stderr))]
            started = time.monotonic()
            while self.process.returncode is None:
                self._guard(selected)
                if time.monotonic() - started > self.timeout:
                    raise error(504, "formula_timeout", "Local formula recognition timed out; retry if needed.")
                try:
                    await asyncio.wait_for(self.process.wait(), .2)
                except asyncio.TimeoutError:
                    pass
            result_path = work / "result.json"
            if not result_path.is_file() or result_path.stat().st_size > 256 * 1024:
                raise error(502, "formula_worker_failed", "The formula worker did not return a valid result.")
            result = json.loads(await asyncio.to_thread(result_path.read_text))
            if self.process.returncode != 0 or result.get("status") != "completed":
                code = "formula_runtime_busy" if result.get("error", {}).get("code") == "formula_runtime_busy" else "formula_worker_failed"
                raise error(503, code, "The local CPU runtime is busy; retry shortly." if code.endswith("busy") else "Local formula recognition failed; retry this formula.")
            if result.get("identity") != context["identity"] or not isinstance(result.get("latex"), str) or not 0 < len(result["latex"].strip()) <= 65536:
                raise error(502, "formula_invalid_result", "Formula recognition returned an invalid or empty result.")
            return result
        finally:
            await self._terminate(self.process)
            if drains:
                outputs = await asyncio.gather(*drains)
                for name, value in zip(("stdout.txt", "stderr.txt"), outputs):
                    await asyncio.to_thread((work / name).write_text, value)
            self.process = None

    def _complete(self, job, context, result):
        job.update(status="completed", latex=result["latex"], updated_at=time.time(), timings=result.get("timings", {}))
        with self.db() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job["id"],)).fetchone()
            if not row or row["status"] not in ACTIVE:
                return
            db.execute("INSERT OR REPLACE INTO cache VALUES(?,?,?,?,?)",
                       (job["cache_key"], digest(self._base(context["selection"])), json.dumps(context["identity"]),
                        json.dumps({"latex": result["latex"], "timings": result.get("timings", {})}), time.time()))
            db.execute("UPDATE jobs SET status='completed',payload=? WHERE id=?", (json.dumps(job), job["id"]))

    async def _work(self):
        while True:
            job_id = await self.queue.get()
            job = context = None
            try:
                job, context = await asyncio.to_thread(self._job, job_id)
                if job["status"] not in ACTIVE:
                    continue
                self.active_job = job
                selected = await asyncio.to_thread(self._resolve, job["book_id"], job["task_id"], job["formula_id"])
                if selected != context["selection"]:
                    raise error(409, "formula_source_changed", "Formula source changed while queued; retry.")
                await self._wait_runtime(selected)
                async with self.module.control_lock:
                    self._guard(selected)
                    current, _ = await asyncio.to_thread(self._job, job_id)
                    if current["status"] not in ACTIVE:
                        continue
                    job.update(status="running", updated_at=time.time())
                    await asyncio.to_thread(self._save, job, context)
                result = await self._infer(job, context)
                checked = await asyncio.to_thread(self._resolve, job["book_id"], job["task_id"], job["formula_id"])
                if checked != selected:
                    raise error(409, "formula_source_changed", "Formula source changed during recognition; retry.")
                async with self.module.control_lock:
                    self._guard(selected)
                    await asyncio.to_thread(self._complete, job, context, result)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if job and context:
                    current, _ = await asyncio.to_thread(self._job, job_id)
                    if current["status"] in ACTIVE:
                        detail = exc.detail if isinstance(exc, HTTPException) else {
                            "code": "formula_worker_failed", "message": "Formula recognition failed; the original image is retained."}
                        job.update(status="failed", updated_at=time.time(), error={**detail, "retryable": True})
                        await asyncio.to_thread(self._save, job, context)
            finally:
                self.active_job = None
                self.queue.task_done()
