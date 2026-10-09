"""Bounded original receipt before any short user-library transaction."""

import asyncio
import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path

from fastapi import HTTPException, Response, UploadFile

from wise_reader.pdf_lab.worker import ROOT, LocalWorkers, local_environment, worker_python

MAX_UPLOAD_BYTES = 256 * 1024 * 1024
MIN_FREE_BYTES = 512 * 1024 * 1024
MAX_PAGES = 10000


def error(status, code, message):
    return HTTPException(status, {"code": code, "message": message})


class PDFUploadLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/api/pdf/imports":
            return await self.app(scope, receive, send)
        maximum = MAX_UPLOAD_BYTES + 2 * 1024 * 1024
        try:
            length = int(dict(scope.get("headers", [])).get(b"content-length", b"0"))
        except ValueError:
            length = maximum + 1
        if length > maximum:
            return await Response(status_code=413, media_type="application/json",
                content=json.dumps({"detail": {"code": "upload_too_large", "message": "PDF exceeds the 256 MiB limit."}}))(scope, receive, send)
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > maximum:
                raise error(413, "upload_too_large", "PDF exceeds the 256 MiB limit.")
            return message

        await self.app(scope, bounded_receive, send)


async def receive_original(file: UploadFile, root: Path):
    temporary = root / "incoming" / (uuid.uuid4().hex + ".upload")
    digest, size = hashlib.sha256(), 0
    try:
        if shutil.disk_usage(root).free < MIN_FREE_BYTES + MAX_UPLOAD_BYTES:
            raise error(507, "space_insufficient", "Not enough reserved local space to receive a PDF.")
        with temporary.open("xb") as stream:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise error(413, "upload_too_large", "PDF exceeds the 256 MiB limit.")
                if shutil.disk_usage(root).free < MIN_FREE_BYTES + len(chunk):
                    raise error(507, "space_insufficient", "Reserved local storage would be exhausted.")
                digest.update(chunk)
                stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        if not size:
            raise error(422, "format_unreadable", "Uploaded PDF is empty.")
        with temporary.open("rb") as stream:
            if b"%PDF-" not in stream.read(1024):
                raise error(422, "format_unreadable", "Uploaded file has no PDF header.")
            stream.seek(max(0, size - 4096))
            if b"%%EOF" not in stream.read():
                raise error(422, "format_unreadable", "PDF is truncated.")
        process = await asyncio.create_subprocess_exec(str(worker_python()),
            str(ROOT / "src/wise_reader/pdf_lab/validation.py"), str(temporary), cwd=ROOT,
            env=local_environment(), stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, start_new_session=True)
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=25)
        except asyncio.TimeoutError:
            raise error(422, "validator_timeout", "Local PDF validation timed out.")
        finally:
            # Request/service cancellation must also stop and reap the owned
            # validator (including native parser children) before cleanup.
            await LocalWorkers.terminate(process)
        try:
            validation = json.loads(stdout) if not process.returncode and len(stdout) < 65536 else None
        except ValueError:
            validation = None
        if not isinstance(validation, dict):
            raise error(503, "validator_unavailable", "Local PDF validation is unavailable.")
        if validation.get("error"):
            raise error(503 if validation["error"] == "validator_unavailable" else 422,
                        validation["error"], validation.get("message", "PDF validation failed."))
        count = validation.get("page_count")
        if type(count) is not int or count <= 0:
            raise error(422, "format_unreadable", "PDF has no readable source pages.")
        if count > MAX_PAGES:
            raise error(413, "page_limit", "PDF exceeds 10,000 source pages.")
        filename = (file.filename or "PDF").replace("\\", "/").rsplit("/", 1)[-1]
        title = "".join(c for c in Path(filename).stem if c.isprintable()).strip()[:160] or "PDF"
        return temporary, title, digest.hexdigest(), size, count
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
