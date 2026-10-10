"""Frozen /api/collections v1 routes; mounted by the normal plugin runtime."""
from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, StrictBool, model_validator
from starlette.concurrency import run_in_threadpool

from wise_reader.collections import Collections
from wise_reader.collections import migrate as migrate  # runtime migration hook
from wise_reader.collections_transfer import MAX_REQUEST_BYTES, cleanup, export_data, import_data, markdown
from wise_reader.collections_source import packed
from wise_reader.content import Anchor

PLUGIN_ID = "collections"


class Explanation(BaseModel):
    text: str = Field(default="", max_length=12000)
    source: str = Field(default="", max_length=2000)
    kind: str = Field(default="dictionary", max_length=80)
    assist_id: int | None = Field(default=None, ge=1)


class SaveIn(BaseModel):
    doc_id: int = Field(ge=1)
    kind: Literal["word", "excerpt"]
    anchor: Anchor
    explanation: Explanation | None = None


class PatchIn(BaseModel):
    my_meaning: str | None = Field(default=None, max_length=20000)
    adopt_assist_id: int | None = Field(default=None, ge=1)
    expected_revision: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def nonnull_meaning(self):
        if "my_meaning" in self.model_fields_set and self.my_meaning is None:
            raise ValueError("my_meaning must be text; use an empty string to clear")
        return self


class FeedbackIn(BaseModel):
    doc_id: int = Field(ge=1)
    anchor: Anchor
    understood: StrictBool | None = None
    retained: StrictBool | None = None
    note: str | None = Field(default=None, max_length=12000)
    detail: str | None = Field(default=None, max_length=12000)
    target: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def nonnull_fields(self):
        if any(k in self.model_fields_set and getattr(self, k) is None for k in ("retained", "note", "detail", "target")):
            raise ValueError("Only understood accepts null")
        return self


class UndoIn(BaseModel):
    token: str = Field(min_length=1, max_length=128)


class ResurfaceIn(BaseModel):
    action: Literal["next", "hide", "show", "snooze"]
    id: int | None = Field(default=None, ge=1)


class Scope(BaseModel):
    book_id: int | None = Field(default=None, ge=1)
    ids: list[int] | None = Field(default=None, max_length=500)
    collections: StrictBool = False
    notes: StrictBool = False
    feedback: StrictBool = False

    @model_validator(mode="after")
    def valid_ids(self):
        if self.ids is not None:
            if any(i < 1 for i in self.ids):
                raise ValueError("ids must be positive collection IDs")
            self.ids = list(dict.fromkeys(self.ids))
        return self


class ExportIn(Scope):
    collections: StrictBool = True
    format: Literal["json", "markdown"] = "json"


class CleanupIn(Scope):
    confirm: StrictBool = False


def register(app: FastAPI, ctx) -> None:
    service = Collections(ctx.store)

    def enabled(request: Request):
        # Same flag as require_plugin, without an import-time catalog dependency.
        if not request.app.state.store.is_plugin_enabled(PLUGIN_ID, True):
            raise HTTPException(404, "plugin collections is off")

    router = APIRouter(prefix="/api/collections", dependencies=[Depends(enabled)])

    @router.get("")
    def list_records(doc_id: int | None = Query(None, ge=1), book_id: int | None = Query(None, ge=1),
                     kind: Literal["word", "excerpt"] | None = None,
                     q: str = Query("", max_length=200), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0, le=1000000)):
        return service.list(doc_id, book_id, kind, q, limit, offset)

    @router.post("")
    def add_record(body: SaveIn):
        return service.save(body.doc_id, body.kind, body.anchor, body.explanation.model_dump(exclude_none=True) if body.explanation else None)

    @router.get("/state/{doc_id}")
    def state(doc_id: int):
        return service.state(doc_id)

    @router.post("/feedback")
    def feedback(body: FeedbackIn):
        fields = body.model_dump(exclude_unset=True, exclude={"doc_id", "anchor"})
        return service.feedback(body.doc_id, body.anchor, fields)

    @router.post("/undo")
    def undo(body: UndoIn):
        return service.undo(body.token)

    @router.get("/resurface")
    def resurface():
        return service.resurface()

    @router.post("/resurface")
    def change_resurface(body: ResurfaceIn):
        return service.resurface(body.action, body.id)

    @router.post("/export")
    def export(body: ExportIn):
        data = export_data(service, body.model_dump())
        if body.format == "json":
            # Use exactly the representation checked by export_data. The UI
            # accepts files up to 8 MiB and sends compact JSON inside {data:...}.
            raw, media, extension = packed(data), "application/json", "json"
        else:
            raw, media, extension = markdown(data), "text/markdown; charset=utf-8", "md"
        return Response(raw, media_type=media, headers={"Content-Disposition": f'attachment; filename="wise-reader-collections.{extension}"', "Cache-Control": "no-store"})

    @router.post("/import")
    async def restore(request: Request):
        size, chunks = 0, []
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_REQUEST_BYTES:
                raise HTTPException(413, "导入请求超过 8 MiB 数据及请求包裹上限")
            chunks.append(chunk)
        try:
            payload = json.loads(b"".join(chunks), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(422, "导入不是有效 JSON") from None
        if not isinstance(payload, dict) or "data" not in payload:
            raise HTTPException(422, "导入需要 data 字段")
        return await run_in_threadpool(import_data, service, payload["data"])

    @router.post("/cleanup")
    def remove_scoped(body: CleanupIn):
        return cleanup(service, body.model_dump())

    @router.get("/{record_id}/source")
    def source(record_id: int):
        with ctx.store.transaction():
            return service.source(record_id)

    @router.patch("/{record_id}")
    def patch(record_id: int, body: PatchIn):
        return service.patch(record_id, body.model_dump(exclude_unset=True))

    @router.delete("/{record_id}")
    def delete(record_id: int, revision: int | None = Query(None, ge=1)):
        return service.delete(record_id, revision)

    app.include_router(router)
