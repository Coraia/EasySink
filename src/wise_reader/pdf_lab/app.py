"""Standalone loopback PDF lab HTTP interface, with no personal app imports."""

import asyncio
import hashlib
import json
import os
import shutil
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .storage import LabStore
from .worker import ROOT, LocalWorkers, checked_result, local_environment, safe_asset, worker_python

MAX_UPLOAD_BYTES = 256 * 1024 * 1024
MIN_FREE_BYTES = 512 * 1024 * 1024
MAX_PAGES = 10000


def problem(status: int, code: str, message: str):
    return HTTPException(status_code=status, detail={"code": code, "message": message})


class Operation(BaseModel):
    action: str
    engine: str = "auto"
    start_page: int = Field(default=1, ge=1)
    end_page: int | None = Field(default=None, ge=1)


class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        maximum = MAX_UPLOAD_BYTES + 2 * 1024 * 1024
        headers = dict(scope.get("headers", []))
        try:
            oversized = int(headers.get(b"content-length", b"0")) > maximum
        except ValueError:
            oversized = True
        if oversized:
            response = Response(content=json.dumps({"detail": {"code": "upload_too_large",
                "message": "Upload exceeds the isolated lab limit."}}),
                status_code=413, media_type="application/json")
            return await response(scope, receive, send)
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > maximum:
                raise problem(413, "upload_too_large", "Upload exceeds the isolated lab limit.")
            return message

        await self.app(scope, bounded_receive, send)


async def validate_original(path: Path):
    process = await asyncio.create_subprocess_exec(
        str(worker_python()), str(Path(__file__).with_name("validation.py")), str(path),
        cwd=ROOT, env=local_environment(), stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=25)
    except asyncio.TimeoutError:
        await LocalWorkers.terminate(process)
        raise problem(422, "validator_timeout", "Local PDF validation timed out.")
    if process.returncode or len(stdout) > 65536:
        raise problem(503, "validator_unavailable", "Local PDF validation is unavailable.")
    try:
        result = json.loads(stdout)
    except ValueError:
        raise problem(503, "validator_unavailable", "Local PDF validator returned an invalid response.")
    if not isinstance(result, dict):
        raise problem(503, "validator_unavailable", "Local PDF validator must return an object.")
    if result.get("error"):
        code = result["error"]
        status = 503 if code == "validator_unavailable" else 422
        raise problem(status, code, result.get("message", "PDF validation failed."))
    count = result.get("page_count")
    if type(count) is not int or count <= 0:
        raise problem(422, "format_unreadable", "PDF contains no readable source pages.")
    if count > MAX_PAGES:
        raise problem(413, "page_limit", "PDF exceeds the isolated lab page limit.")
    return result


def create_app(data_dir: str | Path | None = None):
    root = Path(data_dir or os.environ.get("PDF_LAB_DATA_DIR", ROOT / ".runtime/pdf-lab"))
    store = LabStore(root)
    workers = LocalWorkers(store)

    @asynccontextmanager
    async def lifespan(app):
        await workers.recover()
        yield
        await workers.close()

    app = FastAPI(title="Wise Reader isolated PDF lab", lifespan=lifespan)
    app.add_middleware(UploadLimitMiddleware)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @app.middleware("http")
    async def local_writes(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and origin:
            parsed = urlparse(origin)
            if parsed.scheme not in {"http", "https"} or parsed.netloc != request.headers.get("host"):
                return Response(status_code=403, media_type="application/json", content=json.dumps({
                    "detail": {"code": "origin_rejected", "message": "Use the local lab origin."}}))
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def require_book(book_id: str):
        book = store.book(book_id)
        if not book:
            raise problem(404, "book_not_found", "No registered PDF has this identity.")
        return book

    def require_task(task_id: str):
        task = store.task(task_id)
        if not task:
            raise problem(404, "task_not_found", "No registered task has this identity.")
        return task

    def public_task(task):
        return {k: v for k, v in task.items() if k != "pid"}

    def public_book(book):
        task = store.task(book["latest_task_id"])
        return {"id": book["id"], "title": book["title"], "file_sha256": book["file_sha256"],
                "source_url": f"/api/pdf-lab/books/{book['id']}/source",
                "page_count": book["page_count"], "byte_size": book["byte_size"],
                "status": task["state"], "created_at": book["created_at"]}

    def snapshot(book):
        return {"book": public_book(book), "task": public_task(store.task(book["latest_task_id"])),
                "reading_ready": any(t["metrics"].get("ready_pages", 0) > 0 and
                    (store.output(t) / "published.json").is_file() for t in store.tasks(book["id"])),
                "result_url": f"/api/pdf-lab/books/{book['id']}/result"}

    @app.get("/health")
    @app.get("/api/pdf-lab/health")
    async def health():
        return {"status": "ok", "service": "wise-reader-pdf-lab", "cloud_enabled": False}

    @app.get("/api/pdf-lab/capabilities")
    async def capabilities():
        return await workers.capabilities()

    @app.post("/api/pdf-lab/imports", status_code=202)
    async def import_pdf(response: Response, file: UploadFile = File(...)):
        started = time.monotonic()
        temporary = store.root / "incoming" / (uuid.uuid4().hex + ".upload")
        size, digest = 0, hashlib.sha256()
        try:
            if shutil.disk_usage(store.root).free < MIN_FREE_BYTES + MAX_UPLOAD_BYTES:
                raise problem(507, "space_insufficient", "Local space reserve cannot cover a lab upload.")
            with temporary.open("xb") as stream:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise problem(413, "upload_too_large", "PDF exceeds the 256 MiB lab limit.")
                    if shutil.disk_usage(store.root).free < MIN_FREE_BYTES + len(chunk):
                        raise problem(507, "space_insufficient", "Local space reserve would be exhausted.")
                    digest.update(chunk)
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            if not size:
                raise problem(422, "format_unreadable", "Uploaded PDF is empty.")
            with temporary.open("rb") as stream:
                if b"%PDF-" not in stream.read(1024):
                    raise problem(422, "format_unreadable", "Uploaded file has no PDF header.")
                stream.seek(max(0, size - 4096))
                if b"%%EOF" not in stream.read():
                    raise problem(422, "format_unreadable", "PDF is truncated or has no final PDF marker.")
            validation = await validate_original(temporary)
            filename = (file.filename or "PDF").replace("\\", "/").rsplit("/", 1)[-1]
            title = "".join(c for c in Path(filename).stem if c.isprintable()).strip()[:160] or "PDF"
            book, task, reused = await asyncio.to_thread(store.register, temporary, title,
                digest.hexdigest(), size, validation["page_count"], (time.monotonic() - started) * 1000)
            if not reused:
                task, error = await workers.start(book, "auto", 1, book["page_count"])
                if error:
                    task = store.update(book["latest_task_id"], state="preparing", error=error)
            else:
                response.status_code = 200
            return {**snapshot(store.book(book["id"])), "reused": reused,
                    "validation": {"validator": validation.get("validator")}}
        except OSError as exc:
            raise problem(507 if exc.errno == 28 else 500, "storage_failed", "Local PDF registration failed.")
        except sqlite3.Error:
            raise problem(500, "registration_failed", "Local PDF registry could not commit the import.")
        finally:
            temporary.unlink(missing_ok=True)
            await file.close()

    @app.get("/api/pdf-lab/books")
    async def books():
        return {"books": [public_book(b) for b in store.books()]}

    @app.get("/api/pdf-lab/books/{book_id}")
    async def book_details(book_id: str):
        return snapshot(require_book(book_id))

    @app.get("/api/pdf-lab/tasks/{task_id}")
    async def task_details(task_id: str):
        return public_task(require_task(task_id))

    @app.post("/api/pdf-lab/books/{book_id}/operations")
    async def operate(book_id: str, operation: Operation):
        book = require_book(book_id)
        if operation.action == "convert":
            end = operation.end_page or book["page_count"]
            if not 1 <= operation.start_page <= end <= book["page_count"]:
                raise problem(422, "invalid_range", "Requested source pages leave this PDF.")
            if not store.source(book).is_file():
                raise problem(409, "source_missing", "Registered original is missing.")
            task, error = await workers.start(book, operation.engine, operation.start_page, end)
            if error:
                status = 422 if error["code"] == "unsupported_engine" else (409 if error["code"] == "task_conflict" else 503)
                raise problem(status,
                              error["code"], error["message"])
        elif operation.action == "cancel":
            task = await workers.cancel(store.task(book["latest_task_id"]))
        elif operation.action in {"pause", "resume"}:
            raise problem(501, "operation_unavailable", "Pause/resume is not implemented in this lab iteration.")
        else:
            raise problem(422, "unknown_action", "Unknown PDF lab operation.")
        return {"book": public_book(store.book(book_id)), "task": public_task(task)}

    @app.get("/api/pdf-lab/books/{book_id}/result")
    async def result(book_id: str, start_page: int = 1, end_page: int | None = None):
        book = require_book(book_id)
        end = end_page if end_page is not None else min(book["page_count"], start_page + 49)
        if not 1 <= start_page <= end <= book["page_count"] or end - start_page + 1 > 50:
            raise problem(422, "invalid_range", "Result requests must cover 1–50 valid source pages.")
        return await asyncio.to_thread(workers.result, book, start_page, end)

    @app.get("/api/pdf-lab/books/{book_id}/source")
    async def source(book_id: str):
        book = require_book(book_id)
        path = store.source(book)
        if not path.is_file() or not path.resolve().is_relative_to((store.root / "originals").resolve()):
            raise problem(404, "source_missing", "Registered original is unavailable.")
        return FileResponse(path, media_type="application/pdf", filename=book["title"] + ".pdf",
                            content_disposition_type="inline", headers={"Cache-Control": "private, no-cache"})

    @app.get("/api/pdf-lab/books/{book_id}/assets/{task_id}/{asset:path}")
    async def asset(book_id: str, task_id: str, asset: str):
        book, task = require_book(book_id), require_task(task_id)
        if task["book_id"] != book_id:
            raise problem(404, "asset_not_found", "This asset does not belong to this PDF.")
        try:
            output = store.output(task)
            result = await asyncio.to_thread(checked_result, output / "published.json", task, book)
            declared = {b["asset"] for p in result["pages"] for b in p["blocks"] if b.get("asset")}
            if asset not in declared:
                raise ValueError("Asset is not registered in a published result.")
            path = safe_asset(output, asset)
        except (ValueError, OSError):
            raise problem(404, "asset_not_found", "No registered readable asset has this identity.")
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})

    app.mount("/static/prototypes/pdf-lab", StaticFiles(directory=ROOT / "web/prototypes/pdf-lab", check_dir=False), name="pdf-lab")
    return app
