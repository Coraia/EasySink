"""PDF import and source controls; retained reading survives processing disable."""

import asyncio
import json
from typing import Literal
from urllib.parse import urlparse

from fastapi import APIRouter, FastAPI, File, Form, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from wise_reader.pdf import PDFModule
from wise_reader.pdf.uploads import PDFUploadLimit, error
from wise_reader.plugins.runtime import PluginContext


class Operation(BaseModel):
    action: str
    engine: str = "auto"
    start_page: int | None = Field(default=None, ge=1)
    end_page: int | None = Field(default=None, ge=1)
    region: dict | list | None = None


class Lifecycle(BaseModel):
    action: str


class FormulaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    formula_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class EnhancementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    page_number: int = Field(ge=1)
    region: list[float] | None = Field(default=None, min_length=4, max_length=4)
    service_id: str = Field(min_length=16, max_length=128)
    intent_id: str = Field(min_length=16, max_length=128)


class EnhancementAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["replay", "regenerate", "cancel"]
    intent_id: str | None = Field(default=None, min_length=16, max_length=128)
    service_id: str | None = Field(default=None, min_length=16, max_length=128)


def register(app: FastAPI, ctx: PluginContext):
    module = PDFModule(ctx)
    app.state.pdf = module
    app.add_middleware(PDFUploadLimit)
    router = APIRouter()

    def local_operation(request):
        origin = request.headers.get("origin")
        expected = urlparse(str(request.base_url))
        supplied = urlparse(origin) if origin else None
        if (request.headers.get("sec-fetch-site") == "cross-site" or
                (supplied and (supplied.scheme, supplied.netloc) != (expected.scheme, expected.netloc))):
            raise error(403, "origin_rejected", "Use the reader's origin for PDF operations.")

    async def enhancement_body(request, schema=None):
        local_operation(request)
        # Validate here so framework errors cannot echo a submitted credential.
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 16 * 1024:
                raise error(413, "enhancement_request_too_large", "Enhancement settings or scope are too large.")
        try:
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError("object_required")
            return schema.model_validate(value) if schema else value
        except (ValueError, ValidationError):
            raise error(422, "invalid_enhancement_request", "Check the selected service, original page and region.") from None

    @router.post("/api/pdf/documents/{doc_id}/resume-position")
    async def resume_position(doc_id: int, request: Request):
        # Read-only and PDF-specific: this endpoint cannot adopt a quotation.
        local_operation(request)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 16 * 1024:
                raise error(413, "position_too_large", "Reading position is too large.")
        try:
            body = json.loads(raw)
            if not isinstance(body, dict) or not isinstance(body.get('anchor'), dict) or not isinstance(body.get('version'), str):
                raise ValueError()
        except (ValueError, TypeError):
            raise error(422, "invalid_position", "Reading position is invalid.") from None
        return {"anchor": module.resume_position(doc_id, body['anchor'], body['version'])}

    @router.get("/api/pdf/enhancement/config")
    async def enhancement_config(response: Response):
        response.headers["Cache-Control"] = "no-store"
        await module.enhancements.start()
        return await asyncio.to_thread(module.enhancements.config)

    @router.put("/api/pdf/enhancement/config")
    async def save_enhancement_config(request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return await module.enhancements.update_config(await enhancement_body(request))

    @router.post("/api/pdf/enhancement/test")
    async def test_enhancement_config(request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return await module.enhancements.update_config(await enhancement_body(request), test=True)

    @router.get("/api/pdf/books/{book_id}/enhancements")
    async def enhancement_history(book_id: int, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return await asyncio.to_thread(module.enhancements.history, book_id)

    @router.post("/api/pdf/books/{book_id}/enhancements", status_code=202)
    async def enhance_page(book_id: int, request: Request, response: Response):
        body = await enhancement_body(request, EnhancementRequest)
        job = await module.enhancements.submit(book_id, **body.model_dump())
        response.headers["Cache-Control"] = "no-store"
        if job["status"] not in {"queued", "running"}:
            response.status_code = 200
        return job

    @router.get("/api/pdf/books/{book_id}/enhancements/{job_id}")
    async def enhancement_status(book_id: int, job_id: str, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return await asyncio.to_thread(module.enhancements.status, book_id, job_id)

    @router.post("/api/pdf/books/{book_id}/enhancements/{job_id}/actions")
    async def enhancement_action(book_id: int, job_id: str, request: Request, response: Response):
        body = await enhancement_body(request, EnhancementAction)
        response.headers["Cache-Control"] = "no-store"
        return await module.enhancements.action(book_id, job_id, **body.model_dump())

    @router.get("/api/pdf/capabilities")
    async def capabilities():
        return await module.capabilities()

    @router.get("/api/pdf/recycle")
    def recycled_books():
        return {"books": module.recycled_books()}

    @router.post("/api/pdf/imports", status_code=202)
    async def import_pdf(request: Request, response: Response, file: UploadFile = File(...),
                         engine: str = Form(default="auto")):
        local_operation(request)
        payload, reused = await module.import_file(file, engine=engine)
        if reused:
            response.status_code = 200
        return payload

    @router.get("/api/pdf/books/{book_id}")
    def book(book_id: int):
        return module.book_payload(book_id)

    @router.get("/api/pdf/books/{book_id}/source")
    def source(book_id: int):
        _, book = module.source_book(book_id)
        path = module.originals.source(book)
        if not path.is_file() or not path.resolve().is_relative_to((module.originals.root / "originals").resolve()):
            raise error(404, "source_missing", "Registered PDF original is unavailable.")
        return FileResponse(path, media_type="application/pdf", filename=book["title"] + ".pdf",
                            content_disposition_type="inline", headers={"Cache-Control": "private, no-cache"})

    @router.get("/api/pdf/books/{book_id}/assets/{task_id}/{asset:path}")
    async def asset(book_id: int, task_id: str, asset: str):
        _, book = module.source_book(book_id)
        task = module.originals.task(task_id)
        if not task or task["book_id"] != book["id"]:
            raise error(404, "asset_not_found", "No registered asset belongs to this book.")
        try:
            path = await asyncio.to_thread(module.workers.asset_path, task, asset)
        except (OSError, ValueError):
            raise error(404, "asset_not_found", "Registered PDF asset is unavailable.")
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})

    @router.post("/api/pdf/books/{book_id}/operations")
    async def operation(book_id: int, body: Operation, request: Request):
        local_operation(request)
        return await module.operate(book_id, body.action, body.engine, body.start_page, body.end_page, body.region)

    @router.post("/api/pdf/books/{book_id}/formulas", status_code=202)
    async def recognize_formula(book_id: int, body: FormulaRequest, request: Request, response: Response):
        local_operation(request)
        job = await module.formulas.submit(book_id, body.task_id, body.formula_id)
        if job["status"] == "completed":
            response.status_code = 200
        return job

    @router.get("/api/pdf/books/{book_id}/formulas")
    async def formula_cache(book_id: int, task_id: str, formula_id: str):
        return {"job": await module.formulas.lookup(book_id, task_id, formula_id)}

    @router.get("/api/pdf/books/{book_id}/formulas/{job_id}")
    async def formula_status(book_id: int, job_id: str):
        return await module.formulas.status(book_id, job_id)

    @router.post("/api/pdf/books/{book_id}/lifecycle")
    async def lifecycle(book_id: int, body: Lifecycle, request: Request):
        local_operation(request)
        return await module.lifecycle(book_id, body.action)

    app.include_router(router)
