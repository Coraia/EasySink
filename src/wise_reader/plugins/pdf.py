"""PDF import and source controls; retained reading survives processing disable."""

import asyncio
from urllib.parse import urlparse

from fastapi import APIRouter, FastAPI, File, Form, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

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


def register(app: FastAPI, ctx: PluginContext):
    module = PDFModule(ctx)
    app.state.pdf = module
    app.add_middleware(PDFUploadLimit)
    router = APIRouter()

    def local_operation(request):
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            raise error(403, "origin_rejected", "Use the reader's origin for PDF operations.")

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

    @router.post("/api/pdf/books/{book_id}/lifecycle")
    async def lifecycle(book_id: int, body: Lifecycle, request: Request):
        local_operation(request)
        return await module.lifecycle(book_id, body.action)

    app.include_router(router)
