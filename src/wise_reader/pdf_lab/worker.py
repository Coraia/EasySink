"""Local process control and bounded, verified PDF page publication.

New tasks use immutable page snapshots and a small SQLite publication index.
Legacy v1 results remain readable; no reading request loads an OCR model.
"""

import asyncio
import copy
from contextlib import contextmanager
import hashlib
import inspect
import json
import math
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from .adapters.mineru import asset_holders, validate_formula_contract

from .storage import ACTIVE_STATES, LabStore

ROOT = Path(__file__).resolve().parents[3]
CONVERTER = ROOT / "scripts/pdf_lab_convert.py"
MAX_RESULT_BYTES = 64 * 1024 * 1024
MAX_PAGE_BYTES = 32 * 1024 * 1024
MAX_ASSET_BYTES = 64 * 1024 * 1024
PUBLICATION_DATABASE = "published.sqlite3"


async def stop_process_group(pid: int):
    """Stop an already verified, private process group, even without its leader."""
    try:
        os.killpg(pid, signal.SIGCONT)
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return
        await asyncio.sleep(.05)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    # Grandchildren are reparented/reaped by the OS, not waitpid-able here.
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return
        await asyncio.sleep(.05)
    raise RuntimeError("Owned PDF process group did not exit after SIGKILL.")


def worker_python() -> Path:
    isolated = ROOT / ".venv-pdf-lab/bin/python"
    return isolated if isolated.is_file() else Path(sys.executable)


def local_environment() -> dict:
    # The native host supplies writable cache/model locations outside its
    # read-only Resources tree. Forward only explicit runtime controls, never
    # personal provider credentials or arbitrary Python search-path overrides.
    environment = {name: os.environ[name] for name in (
        "PATH", "HOME", "USER", "TMPDIR", "LANG", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE",
        "XDG_CACHE_HOME", "PDF_LAB_MODELS_DIR", "WISE_READER_MINERU_MANIFEST", "HF_HOME", "HF_HUB_CACHE",
        "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE", "TORCH_HOME",
    )
                   if name in os.environ}
    environment.update(PYTHONPATH=str(ROOT / "src"), PYTHONUNBUFFERED="1",
                       HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                       HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1")
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS",
                 "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS", "TORCH_NUM_THREADS"):
        environment[name] = "2"
    return environment


def registered_path(output: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError("Invalid relative output path.")
    path = PurePosixPath(relative)
    if path.is_absolute() or any(p in {"..", ".", ""} for p in relative.split("/")):
        raise ValueError("Path leaves its registered output.")
    resolved = (output / relative).resolve()
    if not resolved.is_relative_to(output.resolve()):
        raise ValueError("Path leaves its registered output.")
    return resolved


def safe_asset(output: Path, relative: str) -> Path:
    resolved = registered_path(output, relative)
    if resolved.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        raise ValueError("Unsupported asset format.")
    if not resolved.is_file() or resolved.stat().st_size > MAX_ASSET_BYTES:
        raise ValueError("Asset is missing or exceeds the limit.")
    return resolved


def load_json(path: Path, limit: int = MAX_RESULT_BYTES) -> dict:
    if not path.is_file() or path.stat().st_size > limit:
        raise ValueError("Result is missing or exceeds the limit.")
    result = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise ValueError("Result must be an object.")
    return result


def checked_header(result: dict, task: dict, book: dict):
    if result.get("schema_version") not in {1, 2} or result.get("page_count") != book["page_count"]:
        raise ValueError("Result schema or original page count does not match.")
    if not isinstance(result.get("pages"), list):
        raise ValueError("Result pages must be an array.")
    if not isinstance(result.get("warnings", []), list) or not isinstance(result.get("metrics", {}), dict):
        raise ValueError("Result diagnostics do not match the contract.")
    if result.get("engine") != task["engine"]:
        raise ValueError("Result engine does not match its task.")
    if result["schema_version"] == 2:
        identity = result.get("identity", {})
        if not isinstance(identity, dict):
            raise ValueError("Result identity must be an object.")
        digest = result.get("source_sha256", identity.get("source_sha256"))
        if digest != book["file_sha256"]:
            raise ValueError("Result original digest does not match its book.")
        # The converter persists exact settings; no resume may expand the range.
        settings = result.get("settings", result.get("processing_config", identity))
        if not isinstance(settings, dict):
            raise ValueError("Result settings must be an object.")
        for name in ("start_page", "end_page"):
            recorded = settings.get(name, result.get(name, result.get("metrics", {}).get(name)))
            if recorded != task[name]:
                raise ValueError("Result processing range does not match its task.")


def checked_page(page: dict, task: dict, book: dict, output: Path, number: int | None = None):
    if not isinstance(page, dict):
        raise ValueError("Result page must be an object.")
    actual = page.get("page_number")
    if type(actual) is not int or not task["start_page"] <= actual <= task["end_page"]:
        raise ValueError("Result has an out-of-scope page.")
    if number is not None and actual != number:
        raise ValueError("Page notification and page file disagree.")
    if any(type(page.get(k)) not in (int, float) or not math.isfinite(page[k]) or page[k] <= 0
           for k in ("width", "height")):
        raise ValueError("Result has invalid page geometry.")
    if not isinstance(page.get("text"), str) or not isinstance(page.get("blocks"), list):
        raise ValueError("Result has invalid page text or blocks.")
    if page.get("coordinate_space", "rotated_crop_top_left") != "rotated_crop_top_left":
        raise ValueError("Result page uses an unsupported coordinate space.")
    block_ids = set()
    for block in page["blocks"]:
        if not isinstance(block, dict) or not isinstance(block.get("source"), dict):
            raise ValueError("Result block and source must be objects.")
        identifier = block.get("id")
        source = block["source"]
        bbox = source.get("bbox")
        if not isinstance(identifier, str) or not identifier or identifier in block_ids:
            raise ValueError("Result has invalid or repeated block identities.")
        block_ids.add(identifier)
        if not isinstance(block.get("text"), str) or not isinstance(block.get("type"), str):
            raise ValueError("Result block has invalid text or type.")
        if source.get("page_number") != actual or not isinstance(bbox, list) or len(bbox) != 4:
            raise ValueError("Result source does not match its original page.")
        if any(type(n) not in (int, float) or not math.isfinite(n) for n in bbox):
            raise ValueError("Result source coordinates are invalid.")
        x0, y0, x1, y1 = bbox
        if not (0 <= x0 <= x1 <= page["width"] + .1 and 0 <= y0 <= y1 <= page["height"] + .1):
            raise ValueError("Result source coordinates leave the visible page.")
        if source.get("coordinate_space", "rotated_crop_top_left") != "rotated_crop_top_left":
            raise ValueError("Result source uses an unsupported coordinate space.")
        for name in ("width", "height"):
            if name in source and (type(source[name]) not in (int, float)
                                   or abs(source[name] - page[name]) > .1):
                raise ValueError("Result source geometry disagrees with its page.")
        if block.get("asset") is not None:
            safe_asset(output, block["asset"])
        elif block["type"] in {"image", "image_fallback"}:
            raise ValueError("Image block has no retained asset.")
    validate_formula_contract(page)
    for holder in asset_holders(page):
        relative = holder.get("asset")
        if relative is None:
            continue
        path = safe_asset(output, relative)
        # Legacy results lack an assets map. New formula objects require one.
        recorded = page.get("assets", {}).get(relative)
        if page.get("extraction_method") == "mineru_source" or holder.get("formula_id"):
            if not isinstance(recorded, dict) or recorded != holder.get("asset_metadata"):
                raise ValueError("Formula asset is not declared with matching metadata.")
            if (recorded.get("bytes") != path.stat().st_size
                    or not isinstance(recorded.get("sha256"), str)
                    or len(recorded["sha256"]) != 64
                    or any(type(recorded.get(k)) is not int or recorded[k] <= 0 for k in ("width_px", "height_px"))):
                raise ValueError("Formula asset metadata is invalid.")
    return page


def retain_assets(output: Path, page: dict):
    """Keep snapshots independent of damaged checkpoints later repaired on resume."""
    retained = {}
    for block in asset_holders(page):
        relative = block.get("asset")
        if not relative:
            continue
        if relative not in retained:
            source = safe_asset(output, relative)
            name = "published-assets/" + relative
            destination = registered_path(output, name)
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=".asset-", dir=destination.parent)
            digest = hashlib.sha256()
            try:
                with os.fdopen(descriptor, "wb") as stream, source.open("rb") as original:
                    while chunk := original.read(1024 * 1024):
                        digest.update(chunk)
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
                recorded = block.get("asset_metadata", {}).get("sha256")
                if recorded is not None and recorded != digest.hexdigest():
                    raise ValueError("Page asset checksum does not match its recorded content.")
                os.replace(temporary, destination)
                directory_fd = os.open(destination.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            finally:
                Path(temporary).unlink(missing_ok=True)
            retained[relative] = name
        block["asset"] = retained[relative]
    if isinstance(page.get("assets"), dict):
        page["assets"] = {retained.get(name, name): metadata for name, metadata in page["assets"].items()}


@contextmanager
def publication_connection(output: Path, create: bool = False):
    path = output / PUBLICATION_DATABASE
    if create:
        output.mkdir(parents=True, exist_ok=True, mode=0o700)
        db = sqlite3.connect(path, timeout=5)
    else:
        if not path.is_file() or not path.resolve().is_relative_to(output.resolve()):
            raise ValueError("Published page index is unavailable.")
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        db.row_factory = sqlite3.Row
        if create:
            db.execute("PRAGMA journal_mode = WAL")
            db.execute("PRAGMA synchronous = FULL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS pages (
                    page_number INTEGER PRIMARY KEY, page_path TEXT NOT NULL,
                    ready INTEGER NOT NULL, content_sha256 TEXT NOT NULL,
                    published_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS assets (
                    asset TEXT PRIMARY KEY, page_number INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS assets_page ON assets(page_number);
            """)
        with db:
            yield db
    finally:
        db.close()


def checked_result(path: Path, task: dict, book: dict,
                   start: int | None = None, end: int | None = None) -> dict:
    """Validate a retained result. For v2, only requested page files are loaded.

    Legacy callers may omit bounds; reading endpoints must supply a bounded range.
    A published v2 manifest delegates page membership to its local SQLite index.
    """
    result = load_json(path)
    checked_header(result, task, book)
    output = path.parent
    low = task["start_page"] if start is None else start
    high = task["end_page"] if end is None else end
    if result["schema_version"] == 1:
        pages, seen = [], set()
        for page in result["pages"]:
            number = page.get("page_number") if isinstance(page, dict) else None
            if type(number) is not int or number in seen:
                raise ValueError("Result has repeated or invalid pages.")
            seen.add(number)
            if low <= number <= high:
                pages.append(checked_page(page, task, book, output))
        result["pages"] = pages
        return result
    if result.get("publication_index") is not None:
        if result["publication_index"] != PUBLICATION_DATABASE:
            raise ValueError("Unknown publication index.")
        with publication_connection(output) as db:
            entries = [dict(row) for row in db.execute(
                "SELECT page_number, page_path, content_sha256 FROM pages "
                "WHERE page_number BETWEEN ? AND ? ORDER BY page_number", (low, high))]
    else:
        entries, seen = [], set()
        for entry in result["pages"]:
            if not isinstance(entry, dict):
                raise ValueError("Page index entry must be an object.")
            number = entry.get("page_number")
            if type(number) is not int or not task["start_page"] <= number <= task["end_page"] or number in seen:
                raise ValueError("Result has repeated or out-of-scope pages.")
            seen.add(number)
            if low <= number <= high:
                entries.append(entry)
    pages = []
    for entry in entries:
        page_path = registered_path(output, entry.get("page_path"))
        if page_path.suffix != ".json":
            raise ValueError("Invalid page file format.")
        page = load_json(page_path, MAX_PAGE_BYTES)
        if entry.get("content_sha256"):
            digest = hashlib.sha256(page_path.read_bytes()).hexdigest()
            if digest != entry["content_sha256"]:
                raise ValueError("Published page changed after registration.")
        pages.append(checked_page(page, task, book, output, entry["page_number"]))
    result["pages"] = pages
    return result


def atomic_json(path: Path, result):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name, suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


class LocalWorkers:
    def __init__(self, store: LabStore, on_publish=None, asset_prefix: str = "/api/pdf-lab", *, on_reconcile=None):
        self.store = store
        self.on_publish = on_publish
        self.on_reconcile = on_reconcile
        self.asset_prefix = asset_prefix.rstrip("/")
        self.lock = asyncio.Lock()
        self.capacity = asyncio.Semaphore(1)
        self.processes = {}
        self.probes = set()
        self.jobs = {}
        self.notifications = set()
        self.headers = {}
        self.cached_capabilities = {}
        self.capability_time = {}
        self.capability_lock = asyncio.Lock()
        self.closing = False

    async def capabilities(self, *, include_remote=True, fresh=False):
        async with self.capability_lock:
            cached = self.cached_capabilities.get(include_remote)
            if not fresh and cached and time.monotonic() - self.capability_time[include_remote] < 10:
                return copy.deepcopy(cached)
            reason = "Conversion entry point is not ready."
            result = None
            if CONVERTER.is_file() and not self.closing:
                process = None
                try:
                    async with self.lock:
                        if self.closing:
                            raise ValueError("PDF service is stopping.")
                        process = await asyncio.create_subprocess_exec(
                            str(worker_python()), str(CONVERTER),
                            "--capabilities" if include_remote else "--local-capabilities", cwd=ROOT,
                            env=local_environment(), stdin=asyncio.subprocess.DEVNULL,
                            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                            start_new_session=True)
                        self.probes.add(process)
                    try:
                        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=7)
                    except asyncio.CancelledError:
                        await self.terminate(process)
                        raise
                    except asyncio.TimeoutError:
                        await self.terminate(process)
                        raise ValueError("Capability probe timed out.")
                    if process.returncode or len(stdout) > 256 * 1024:
                        raise ValueError("Capability probe failed.")
                    result = json.loads(stdout)
                    if not isinstance(result, dict):
                        raise ValueError("Capability probe must return an object.")
                    adapters = result.get("adapters")
                    if not isinstance(adapters, list) or any(
                        not isinstance(a, dict) or not isinstance(a.get("id"), str)
                        or type(a.get("available")) is not bool for a in adapters
                    ):
                        raise ValueError("Capability probe returned an invalid contract.")
                except (OSError, ValueError) as exc:
                    reason = str(exc)
                    result = None
                finally:
                    if process is not None:
                        await self.terminate(process)
                        self.probes.discard(process)
            if result is None:
                result = {"adapters": [{"id": "digital", "label": "Local digital text",
                    "available": False, "missing_reason": reason, "supports_ocr": False,
                    "version": None}]}
            result["cloud_enabled"] = False
            result["supported_actions"] = ["convert", "pause", "resume", "cancel", "recognize"]
            result["limits"] = {"upload_bytes": 256 * 1024 * 1024, "source_pages": 10000,
                                "result_bytes": MAX_RESULT_BYTES, "range_pages": 50,
                                "page_bytes": MAX_PAGE_BYTES}
            self.cached_capabilities[include_remote] = result
            self.capability_time[include_remote] = time.monotonic()
            return copy.deepcopy(result)

    async def engine_error(self, engine: str, *, fresh=True):
        capabilities = await self.capabilities(include_remote=engine == "omarchy", fresh=fresh)
        available = {a["id"] for a in capabilities["adapters"] if a["available"]}
        known = {"auto", "digital", "docling", "omarchy", "mineru_source"}
        if engine not in known:
            return {"code": "unsupported_engine", "message": "Unknown local adapter."}
        if engine not in available and not (engine == "auto" and "digital" in available):
            adapter = next((a for a in capabilities["adapters"] if a["id"] == engine), {})
            readiness = adapter.get("readiness", {})
            return {"code": readiness.get("code", "model_not_ready"),
                    "message": adapter.get("missing_reason") or (
                        "暂时无法确认 Omarchy 是否就绪，请重新检查或改用当前电脑。" if engine == "omarchy"
                        else "本机 PDF 处理组件尚未就绪，请准备好后重试。")}
        return None

    async def recover(self):
        """Stop verified orphan workers, retain publications, never resume implicitly."""
        for task in self.store.tasks():
            book = self.store.book(task["book_id"])
            interrupted = task["state"] in ACTIVE_STATES
            # Cancellation is persisted before termination. A service crash in
            # between must still stop its verified worker, never resume it.
            if task["pid"]:
                try:
                    command = await asyncio.to_thread(subprocess.run,
                        ["/bin/ps", "-p", str(task["pid"]), "-o", "command="],
                        capture_output=True, text=True, timeout=3)
                    expected = (str(CONVERTER), str(self.store.source(book)), str(self.store.output(task)))
                    if all(p in command.stdout for p in expected) and os.getpgid(task["pid"]) == task["pid"]:
                        await stop_process_group(task["pid"])
                except (ProcessLookupError, PermissionError, subprocess.TimeoutExpired):
                    pass
            if interrupted:
                self.store.update(task["id"], state="paused", pid=None, error={
                    "code": "service_interrupted", "message": "Local work was interrupted; resume explicitly. Completed pages retained."})
            elif task["pid"]:
                self.store.update(task["id"], pid=None)
            output = self.store.output(task)
            candidate = output / "result.json"
            try:
                if candidate.is_file() and interrupted:
                    # Recover only complete atomically saved units from the interrupted run.
                    # Cancelled/previously paused tasks do not adopt late output.
                    await asyncio.to_thread(self.publish, self.store.task(task["id"]), None, None, True)
                published = output / "published.json"
                if published.is_file():
                    self._restore_counts(self.store.task(task["id"]), book)
            except (ValueError, OSError, sqlite3.Error):
                self.store.update(task["id"], error={"code": "retained_result_unavailable",
                    "message": "Retained result could not be validated; original preserved."})
        self.store.recover_registry()

    def schedule(self, task_id: str, resume: bool = False):
        job = asyncio.create_task(self.run(task_id, resume))
        self.jobs[task_id] = job
        job.add_done_callback(lambda done, tid=task_id: self.jobs.pop(tid, None)
                              if self.jobs.get(tid) is done else None)

    async def start(self, book: dict, engine: str, start: int, end: int, force: bool = False):
        if type(start) is not int or type(end) is not int or not 1 <= start <= end <= book["page_count"]:
            return None, {"code": "invalid_page_range", "message": "Conversion range must use valid source pages."}
        if engine == "omarchy" and (start, end) != (1, book["page_count"]):
            return None, {"code": "omarchy_scope_unsupported",
                          "message": "Omarchy 目前只支持整书处理；局部重识别请选择当前电脑。"}
        error = await self.engine_error(engine)
        if error:
            return None, error
        configuration_identity = None
        if engine == 'mineru_source':
            caps = await self.capabilities(include_remote=False)
            configuration_identity = next((a.get('configuration_identity') for a in caps['adapters']
                                           if a['id'] == engine), None)
        async with self.lock:
            if self.closing:
                return None, {"code": "service_stopping", "message": "PDF service is stopping."}
            for old in reversed(self.store.tasks(book["id"])):
                same = (old["engine"], old["start_page"], old["end_page"]) == (engine, start, end)
                if old["state"] in ACTIVE_STATES:
                    if same and not force:
                        return old, None
                    return None, {"code": "task_conflict", "message": "This book already has an active local task."}
                if same and not force and old["state"] in {"paused", "cancelled", "completed"}:
                    if engine == 'mineru_source':
                        try:
                            previous_config = load_json(self.store.output(old) / 'result.json').get('configuration_identity')
                        except (ValueError, OSError):
                            previous_config = None
                        if not configuration_identity or previous_config != configuration_identity:
                            continue  # Keep the old edition; explicit conversion gets matching current settings.
                    if old["state"] == "completed":
                        try:
                            self._restore_counts(old, book)
                            if self.store.task(old["id"])["done_pages"] != old["total_pages"]:
                                raise ValueError("Retained range is incomplete.")
                        except (ValueError, OSError, sqlite3.Error):
                            self.store.update(old["id"], state="failed", error={
                                "code": "retained_result_unavailable", "message": "Prior result is unavailable; explicit conversion starts a new version."})
                            continue
                    self.store.select_task(book["id"], old["id"])
                    return self.store.task(old["id"]), None
            current_book = self.store.book(book["id"])
            initial = self.store.task(current_book["latest_task_id"])
            if not force and initial["state"] == "preparing" and (start, end) == (1, book["page_count"]):
                task = self.store.update(initial["id"], state="queued", engine=engine, error=None)
            else:
                task = self.store.new_task(book, engine, start, end)
            self.schedule(task["id"])
            return task, None

    @staticmethod
    def ready_pages(result):
        return sum(bool(p["text"].strip() or p["blocks"]) and p.get("quality_state") != "rejected"
                   for p in result["pages"])

    @staticmethod
    def save_publication(output, result):
        atomic_json(output / "published.json", result)

    def _header(self, task, book, refresh=False):
        if refresh or task["id"] not in self.headers:
            header = load_json(self.store.output(task) / "result.json")
            checked_header(header, task, book)
            # Page membership belongs to the SQLite index; keep no full text in cache.
            self.headers[task["id"]] = {k: v for k, v in header.items() if k != "pages"}
            return header
        return {**self.headers[task["id"]], "pages": []}

    def _restore_counts(self, task, book):
        output = self.store.output(task)
        header = load_json(output / "published.json")
        checked_header(header, task, book)
        if header["schema_version"] == 2 and header.get("publication_index") == PUBLICATION_DATABASE:
            with publication_connection(output) as db:
                row = db.execute("SELECT COUNT(*) AS done, COALESCE(SUM(ready), 0) AS ready FROM pages").fetchone()
            done, ready = row["done"], row["ready"]
        else:
            checked = checked_result(output / "published.json", task, book)
            done, ready = len(checked["pages"]), self.ready_pages(checked)
        return self.store.update(task["id"], done_pages=done, metrics={
            **task["metrics"], "ready_pages": ready, "quality_reviewed": False})

    def publish(self, task: dict, expected_page: int | None = None,
                page_path: str | None = None, recovery: bool = False, conversion_metrics: dict | None = None):
        """Publish real atomic units; run() serializes this with lifecycle controls."""
        current = self.store.task(task["id"])
        if not recovery and current["state"] != "running":
            return current
        book = self.store.book(task["book_id"])
        output = self.store.output(task)
        result = self._header(task, book, refresh=expected_page is None)
        if result["schema_version"] == 1:
            result = checked_result(output / "result.json", task, book)
            numbers = {p["page_number"] for p in result["pages"]}
            if expected_page is not None and expected_page not in numbers:
                raise ValueError("Progress notification arrived before its page was saved.")
            previous = output / "published.json"
            if previous.is_file():
                previous_result = checked_result(previous, task, book)
                if not {p["page_number"] for p in previous_result["pages"]} <= numbers:
                    raise ValueError("Converter removed a previously published page.")
            self.save_publication(output, result)
            done, ready = len(numbers), self.ready_pages(result)
        else:
            if expected_page is None:
                entries = result["pages"]
            else:
                if not task["start_page"] <= expected_page <= task["end_page"]:
                    raise ValueError("Out-of-scope completion notification.")
                expected_path = f"pages/p{expected_page:06d}.json"
                if page_path != expected_path:
                    raise ValueError("Completion notification has an invalid page path.")
                entries = [{"page_number": expected_page, "page_path": expected_path}]
            done = current["done_pages"]
            ready = current["metrics"].get("ready_pages", 0)
            with publication_connection(output, create=True) as db:
                for entry in entries:
                    number = entry.get("page_number") if isinstance(entry, dict) else None
                    if type(number) is not int or not task["start_page"] <= number <= task["end_page"]:
                        raise ValueError("Result has an invalid page index.")
                    if entry.get("page_path") != f"pages/p{number:06d}.json":
                        raise ValueError("Result page index has an invalid path.")
                    existing = db.execute("SELECT page_number FROM pages WHERE page_number = ?", (number,)).fetchone()
                    if existing:
                        continue  # A published immutable unit cannot be overwritten by late output.
                    source_page = registered_path(output, entry["page_path"])
                    page = checked_page(load_json(source_page, MAX_PAGE_BYTES), task, book, output, number)
                    checkpoint = page.get("checkpoint", {})
                    if (checkpoint.get("complete") is not True
                            or checkpoint.get("source_sha256") != book["file_sha256"]
                            or checkpoint.get("processing_identity") != result.get("processing_identity")):
                        raise ValueError("Page checkpoint does not match its original/settings identity.")
                    if entry.get("sha256") and hashlib.sha256(source_page.read_bytes()).hexdigest() != entry["sha256"]:
                        raise ValueError("Page checkpoint checksum does not match the conversion index.")
                    retain_assets(output, page)
                    retained = f"published-pages/p{number:06d}.json"
                    atomic_json(output / retained, page)
                    digest = hashlib.sha256((output / retained).read_bytes()).hexdigest()
                    page_ready = self.ready_pages({"pages": [page]})
                    db.execute("INSERT INTO pages VALUES (?, ?, ?, ?, ?)",
                        (number, retained, page_ready, digest, time.time()))
                    db.executemany("INSERT OR IGNORE INTO assets VALUES (?, ?)",
                        [(b["asset"], number) for b in asset_holders(page) if b.get("asset")])
                    done += 1
                    ready += page_ready
                if expected_page is None:
                    # Recovery/finalization reconciles a crash between index and registry.
                    counts = db.execute("SELECT COUNT(*) AS done, COALESCE(SUM(ready), 0) AS ready FROM pages").fetchone()
                    done, ready = counts["done"], counts["ready"]
            # Constant-size manifest; the growing page membership stays indexed in SQLite.
            manifest = {k: v for k, v in result.items() if k != "pages"}
            manifest.update(pages=[], publication_index=PUBLICATION_DATABASE)
            if expected_page is None or not (output / "published.json").is_file():
                self.save_publication(output, manifest)
        metrics = {**current["metrics"], "ready_pages": ready, "quality_reviewed": False}
        # Page events carry the current small metrics object. The cached header
        # intentionally avoids rereading a growing result index on every page.
        metrics["conversion_metrics"] = conversion_metrics if isinstance(conversion_metrics, dict) else result.get("metrics", {})
        if done and "first_range_published_ms" not in metrics:
            metrics["first_range_published_ms"] = round(
                (time.time() - metrics.get("conversion_started_at", current["created_at"])) * 1000, 3)
        return self.store.update(task["id"], done_pages=done, metrics=metrics)

    async def notify(self, task_id, number=None):
        try:
            callback = self.on_reconcile if number is None else self.on_publish
            if callback:
                value = callback(task_id) if number is None else callback(task_id, number)
                if inspect.isawaitable(value):
                    await value
        except Exception as exc:
            # A reading-bridge failure does not discard valid local conversion.
            # Recovery can rebuild it from the publication index without OCR.
            task = self.store.task(task_id)
            self.store.update(task_id, metrics={**task["metrics"], "publication_callback_error": {
                "page_number": number, "message": str(exc)[:500], "recorded_at": time.time()}})

    def dispatch_notification(self, task_id, number=None):
        callback = self.on_reconcile if number is None else self.on_publish
        if callback and not self.closing:
            job = asyncio.create_task(self.notify(task_id, number))
            self.notifications.add(job)
            job.add_done_callback(self.notifications.discard)

    async def run(self, task_id: str, resume: bool = False):
        async with self.capacity:
            task = self.store.task(task_id)
            if task["state"] != "queued" or self.closing:
                return
            # Queue admission is not execution admission. A different GPU
            # workload may have started while this task waited for capacity.
            readiness_error = await self.engine_error(task["engine"], fresh=True)
            async with self.lock:
                task = self.store.task(task_id)
                if task["state"] != "queued" or self.closing:
                    return
                if readiness_error:
                    self.store.update(task_id, state="paused", pid=None, error={**readiness_error,
                        "message": readiness_error["message"] + " 原件和已完成内容保留；恢复服务后可继续转换。"})
                    self.dispatch_notification(task_id)
                    return
            book = self.store.book(task["book_id"])
            output = self.store.output(task)
            command = [str(worker_python()), str(CONVERTER), "--source", str(self.store.source(book)),
                       "--output", str(output), "--engine", task["engine"], "--sharded",
                       "--start-page", str(task["start_page"]), "--end-page", str(task["end_page"])]
            if resume:
                command.append("--resume")
            if os.name == "posix" and Path("/usr/bin/nice").is_file():
                command = ["/usr/bin/nice", "-n", "10", *command]
            process, exit_job, failure, stderr_tail = None, None, None, []
            try:
                output.mkdir(mode=0o700, exist_ok=True)
                atomic_json(output / f"command-{time.time_ns()}.json", command)
                atomic_json(output / "command.json", command)
                async with self.lock:
                    task = self.store.task(task_id)
                    if task["state"] != "queued" or self.closing:
                        return
                    process = await asyncio.create_subprocess_exec(*command, cwd=ROOT,
                        env=local_environment(), stdin=asyncio.subprocess.DEVNULL,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                        start_new_session=True, limit=256 * 1024)
                    self.processes[task_id] = process
                    exit_job = asyncio.create_task(self.reap_on_exit(process))
                    now = time.time()
                    self.store.update(task_id, state="running", pid=process.pid, error=None, metrics={
                        **task["metrics"], "conversion_started_at": task["metrics"].get("conversion_started_at", now),
                        "last_started_at": now, "resume_count": task["metrics"].get("resume_count", 0) + int(resume),
                        "quality_reviewed": False})

                async def read_stderr():
                    written = 0
                    with (output / "stderr.log").open("ab") as log:
                        while chunk := await process.stderr.read(8192):
                            if written < 4 * 1024 * 1024:
                                log.write(chunk[:4 * 1024 * 1024 - written])
                                written += len(chunk)
                            stderr_tail.append(chunk.decode("utf-8", errors="replace")[-1000:])
                            del stderr_tail[:-4]

                stderr_job = asyncio.create_task(read_stderr())
                try:
                    written = 0
                    with (output / "stdout.jsonl").open("ab") as log:
                        while line := await process.stdout.readline():
                            if written < 16 * 1024 * 1024:
                                log.write(line[:16 * 1024 * 1024 - written])
                                log.flush()
                                written += len(line)
                            try:
                                event = json.loads(line)
                            except (ValueError, UnicodeDecodeError):
                                continue
                            if not isinstance(event, dict):
                                continue
                            if event.get("event") == "page_completed":
                                async with self.lock:
                                    current = self.store.task(task_id)
                                    if current["state"] == "running" and not self.closing:
                                        number = event.get("page_number")
                                        if type(number) is not int or event.get("result_path", "result.json") != "result.json":
                                            raise ValueError("Invalid page completion event.")
                                        updated = await asyncio.to_thread(self.publish, current, number, event.get("page_path"),
                                            conversion_metrics=event.get("metrics"))
                                        published = updated["done_pages"] > current["done_pages"]
                                    else:
                                        published = False
                                if published:
                                    # The bridge owns lifecycle/epoch checks. Never await it
                                    # while holding the worker lock (pause may hold its lock).
                                    self.dispatch_notification(task_id, number)
                            elif event.get("event") == "page_attempt" and event.get("status") == "failed":
                                async with self.lock:
                                    current = self.store.task(task_id)
                                    if current["state"] == "running" and not self.closing:
                                        self.store.update(task_id, metrics={**current["metrics"],
                                            "last_page_attempt_error": {key: event.get(key) for key in
                                                ("page_number", "attempt", "max_attempts", "elapsed_ms", "error", "retryable")}})
                            elif event.get("event") in {"error", "failed"}:
                                failure = {"code": event.get("category", event.get("code", "conversion_failed")),
                                           "message": str(event.get("message", event.get("error", "Conversion failed.")))[:1000]}
                    await process.wait()
                finally:
                    await self.terminate(process)
                    await stderr_job
                recovered_numbers = []
                async with self.lock:
                    current = self.store.task(task_id)
                    if current["state"] in {"cancelled", "paused"} or self.closing:
                        return
                    if process.returncode == 0:
                        before = set(self.published_numbers(current))
                        current = await asyncio.to_thread(self.publish, current)
                        recovered_numbers = [number for number in self.published_numbers(current) if number not in before]
                        if current["done_pages"] != current["total_pages"]:
                            raise ValueError("Converter exited without completing the requested range.")
                        metrics = {**current["metrics"], "range_completed_at": time.time(),
                                   "range_conversion_ms": round((time.time() - current["metrics"]["conversion_started_at"]) * 1000, 3),
                                   "exit_code": 0}
                        if (current["start_page"], current["end_page"]) == (1, book["page_count"]):
                            metrics["whole_book_conversion_finished_at"] = time.time()
                        self.store.update(task_id, state="completed", error=None, metrics=metrics)
                    else:
                        if not failure:
                            for line in reversed("".join(stderr_tail).splitlines()):
                                try:
                                    detail = json.loads(line)
                                    if isinstance(detail, dict) and "category" in detail:
                                        failure = {"code": str(detail["category"]),
                                                   "message": str(detail.get("error", "Conversion failed."))[:1000]}
                                        break
                                except ValueError:
                                    continue
                        self.store.update(task_id, state="partial" if current["done_pages"] else "failed",
                            error=failure or {"code": "conversion_failed", "message": "Local converter exited unsuccessfully."},
                            metrics={**current["metrics"], "exit_code": process.returncode,
                                     "stderr_tail": "".join(stderr_tail)[-2000:]})
                for number in recovered_numbers:
                    self.dispatch_notification(task_id, number)
                self.dispatch_notification(task_id)
            except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
                current = self.store.task(task_id)
                if current["state"] not in {"paused", "cancelled"}:
                    self.store.update(task_id, state="partial" if current["done_pages"] else "failed",
                        error={"code": "space_insufficient" if isinstance(exc, OSError) and exc.errno == 28 else "worker_contract_failed",
                               "message": str(exc)[:1000]})
                    if current['done_pages']:
                        self.dispatch_notification(task_id)
            finally:
                if process is not None:
                    await self.terminate(process)
                if exit_job is not None:
                    await exit_job
                if self.processes.get(task_id) is process:
                    self.processes.pop(task_id, None)
                self.store.update(task_id, pid=None)
                self.headers.pop(task_id, None)

    @staticmethod
    async def terminate(process):
        # stop(), run() and the exit watcher can converge on the same child.
        # One shielded cleanup prevents duplicate signals and cancellation leaks.
        cleanup = getattr(process, "_pdf_cleanup", None)
        if cleanup is None:
            async def reap():
                try:
                    await stop_process_group(process.pid)
                finally:
                    await process.wait()  # reap our direct child / drain its pipes
            cleanup = asyncio.create_task(reap())
            process._pdf_cleanup = cleanup
        await asyncio.shield(cleanup)

    @staticmethod
    async def reap_on_exit(process):
        # Process.wait() can wait for pipes inherited by grandchildren after
        # the leader dies. Observe its returncode independently of pipe EOF.
        while process.returncode is None:
            await asyncio.sleep(.05)
        await LocalWorkers.terminate(process)

    async def stop(self, task: dict, state: str, reason: str):
        async with self.lock:
            current = self.store.task(task["id"])
            if current is None:
                raise ValueError("Task is not registered.")
            if current["state"] in {"completed", "cancelled"} or (state == "paused" and current["state"] == "failed"):
                return current
            self.store.update(task["id"], state=state, error=None if state == "cancelled" else {
                "code": reason, "message": "Local work paused; completed pages retained. Resume explicitly."})
            process = self.processes.get(task["id"])
            job = self.jobs.get(task["id"])
            if job and not process:
                job.cancel()  # Remove a queued unit without waiting behind another book.
        if process:
            await self.terminate(process)
        if job:
            await asyncio.gather(job, return_exceptions=True)
        return self.store.task(task["id"])

    async def pause(self, task: dict, reason: str = "user_paused"):
        return await self.stop(task, "paused", reason)

    async def pause_book(self, book_id: str, reason: str = "processing_disabled"):
        paused = []
        for task in self.store.tasks(book_id):
            if task["state"] in ACTIVE_STATES | {"preparing", "partial"}:
                paused.append(await self.pause(task, reason))
        return paused

    async def cancel(self, task: dict):
        return await self.stop(task, "cancelled", "user_cancelled")

    async def resume(self, task: dict):
        current = self.store.task(task["id"])
        if current is None:
            return None, {"code": "task_not_found", "message": "Task is not registered."}
        if current["state"] in ACTIVE_STATES | {"completed"}:
            self.dispatch_notification(current['id'])
            return current, None
        if current["state"] == "cancelled":
            return None, {"code": "task_cancelled", "message": "Cancelled conversion cannot resume; explicitly recognize a new range."}
        if current["state"] not in {"paused", "partial", "failed", "preparing"}:
            return None, {"code": "task_not_resumable", "message": "Task is not resumable."}
        error = await self.engine_error(current["engine"])
        if error:
            return None, error
        old_job = self.jobs.get(current["id"])
        if old_job:
            await asyncio.gather(old_job, return_exceptions=True)
        async with self.lock:
            if self.closing:
                return None, {"code": "service_stopping", "message": "PDF service is stopping."}
            book = self.store.book(current["book_id"])
            for other in self.store.tasks(book["id"]):
                if other["id"] != current["id"] and other["state"] in ACTIVE_STATES:
                    return None, {"code": "task_conflict", "message": "This book already has an active local task."}
            current = self.store.task(current["id"])
            if current["state"] in ACTIVE_STATES | {"completed"}:
                return current, None
            if current["state"] == "cancelled":
                return None, {"code": "task_cancelled", "message": "Cancelled conversion cannot resume."}
            result = self.store.output(current) / "result.json"
            if result.is_file():
                try:
                    header = load_json(result)
                    if header.get("schema_version") != 2:
                        return None, {"code": "legacy_resume_unavailable", "message": "Legacy v1 content is retained; explicit recognition creates a new resumable version."}
                    checked_header(header, current, book)
                except (ValueError, OSError) as exc:
                    return None, {"code": "resume_identity_mismatch", "message": str(exc)[:300]}
            self.store.select_task(book["id"], current["id"])
            current = self.store.update(current["id"], state="queued", error=None, pid=None)
            self.schedule(current["id"], resume=True)
        self.dispatch_notification(current['id'])
        return current, None

    async def close(self):
        self.closing = True
        async with self.lock:
            probes = list(self.probes)
        await asyncio.gather(*(self.terminate(process) for process in probes))
        for task in self.store.tasks():
            if task["state"] in ACTIVE_STATES:
                await self.pause(task, "service_interrupted")
        await asyncio.gather(*list(self.jobs.values()), return_exceptions=True)
        notifications = list(self.notifications)
        for job in notifications:
            job.cancel()
        await asyncio.gather(*notifications, return_exceptions=True)

    def published_numbers(self, task: dict, start: int | None = None, end: int | None = None):
        output = self.store.output(task)
        path = output / "published.json"
        if not path.is_file():
            return []
        header = load_json(path)
        low, high = task["start_page"] if start is None else start, task["end_page"] if end is None else end
        if header.get("schema_version") == 2 and header.get("publication_index") == PUBLICATION_DATABASE:
            with publication_connection(output) as db:
                return [r[0] for r in db.execute(
                    "SELECT page_number FROM pages WHERE page_number BETWEEN ? AND ? ORDER BY page_number", (low, high))]
        return [p["page_number"] for p in header.get("pages", []) if low <= p["page_number"] <= high]

    def published_pages(self, task: dict):
        """Read only page numbers from the index, for bridge recovery."""
        return self.published_numbers(task)

    def asset_path(self, task: dict, asset: str):
        book = self.store.book(task["book_id"])
        if book is None:
            raise ValueError("Asset has no registered PDF.")
        output = self.store.output(task)
        path = safe_asset(output, asset)
        header = load_json(output / "published.json")
        checked_header(header, task, book)
        if header["schema_version"] == 2 and header.get("publication_index") == PUBLICATION_DATABASE:
            with publication_connection(output) as db:
                declared = db.execute("SELECT page_number FROM assets WHERE asset = ?", (asset,)).fetchone()
            if not declared:
                raise ValueError("Asset is not registered in a published page.")
        else:
            result = checked_result(output / "published.json", task, book)
            if not any(b.get("asset") == asset for p in result["pages"] for b in asset_holders(p)):
                raise ValueError("Asset is not registered in a published page.")
        return path

    def result(self, book: dict, start: int = 1, end: int | None = None,
               task_ids: set[str] | None = None):
        end = min(book["page_count"], start + 49) if end is None else end
        if type(start) is not int or type(end) is not int or not 1 <= start <= end <= book["page_count"] or end - start >= 50:
            raise ValueError("Result requests must cover 1–50 valid source pages.")
        pages, warnings, engines = {}, [], []
        for task in self.store.tasks(book["id"]):
            if task_ids is not None and task["id"] not in task_ids:
                continue
            if task["end_page"] < start or task["start_page"] > end:
                continue
            path = self.store.output(task) / "published.json"
            if not path.is_file():
                continue
            try:
                result = checked_result(path, task, book, start, end)
                engines.append(result.get("engine", task["engine"]))
                warnings.extend(result.get("warnings", []))
                for page in result["pages"]:
                    for block in asset_holders(page):
                        if block.get("asset") is not None:
                            block["asset_url"] = (f"{self.asset_prefix}/books/{book['id']}/assets/{task['id']}/"
                                                  + quote(block["asset"], safe="/"))
                    page["conversion_task_id"] = task["id"]
                    pages[page["page_number"]] = page
            except (ValueError, OSError, sqlite3.Error) as exc:
                warnings.append({"code": "retained_result_unavailable", "message": str(exc)[:300]})
        return {"schema_version": 1, "engine": engines[-1] if engines else None,
                "page_count": book["page_count"], "pages": [pages[n] for n in sorted(pages)],
                "metrics": {"quality_reviewed": False}, "warnings": warnings,
                "requested_range": {"start_page": start, "end_page": end},
                "next_start_page": end + 1 if end < book["page_count"] else None}
