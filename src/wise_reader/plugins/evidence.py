"""Always-readable evidence controls. Enabling the plugin is not consent."""
from __future__ import annotations

import json
import sqlite3
from typing import Literal
from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from starlette.concurrency import run_in_threadpool
from wise_reader.reading_evidence import Evidence, identity, packed


class Control(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["enable", "disable", "clear"]
    epoch: str = Field(max_length=128)
    confirm: StrictBool = False


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    event_id: str = Field(max_length=128)
    session_id: str = Field(max_length=128)
    session_seq: int = Field(ge=1, le=2147483647)
    operation_id: str | None = Field(default=None, max_length=128)
    event_type: Literal["presentation", "word_card", "operation", "session_opened", "session_closed", "gap", "activity", "document_open", "activity_segment", "activity_gap"]
    status: Literal["observed", "started", "succeeded", "failed", "unknown", "cancelled", "conflict", "cache_hit", "gap"]
    evidence_class: Literal["fact", "declaration"] = "fact"
    observer: Literal["client"] = "client"
    client_time: str = Field(max_length=64)
    details: dict = Field(default_factory=dict)
    snapshot: dict | None = None


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    epoch: str = Field(max_length=128)
    events: list[Event] = Field(min_length=1, max_length=64)


def register(app: FastAPI, ctx):
    service = app.state.evidence = Evidence(ctx.store)
    original_lifespan = app.router.lifespan_context

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(application):
        try:
            async with original_lifespan(application) as state:
                yield state
        finally:
            await run_in_threadpool(service.close)

    app.router.lifespan_context = lifespan
    router = APIRouter(prefix="/api/evidence")

    @router.get("/status")
    def status():
        return service.status()

    @router.post("/control")
    def control(body: Control):
        if body.action in ("enable", "clear") and not body.confirm:
            raise HTTPException(422, "需要明确确认采集范围或清除范围")
        return service.control(body.action, body.epoch)

    @router.post("/batch")
    async def batch(request: Request):
        size, chunks = 0, []
        async for chunk in request.stream():
            size += len(chunk)
            if size > 256 * 1024:
                raise HTTPException(413, "批次超过256KiB")
            chunks.append(chunk)
        try:
            body = Batch.model_validate_json(b"".join(chunks))
            events = [e.model_dump(exclude_none=True) for e in body.events]
            ids = set()
            for event in events:
                identity(event["event_id"])
                identity(event["session_id"])
                if event.get("operation_id"):
                    identity(event["operation_id"])
                if event["event_id"] in ids:
                    raise ValueError("duplicate event in batch")
                ids.add(event["event_id"])
                if len(packed(event["details"]).encode()) > 4096:
                    raise ValueError("event details too large")
        except (ValueError, TypeError):
            raise HTTPException(422, "无效或超额的采集事件") from None
        return await run_in_threadpool(service.append, body.epoch, events)

    @router.get("/events")
    def events(after: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=200)):
        return {"events": service.events(after, limit)}

    @router.get("/contexts/{key}")
    def context(key: str):
        if len(key) != 64:
            raise HTTPException(422, "context hash")
        return service.context(key)

    @router.get("/export")
    def export(confirm: bool = False):
        if not confirm:
            raise HTTPException(422, "导出包含原文与阅读行为，须明确确认")
        # Independent read transaction: consistent point-in-time export, bounded
        # row memory, no Store lock held while the browser downloads.
        def lines():
            con = sqlite3.connect(f"file:{service.store.path}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            try:
                con.execute("BEGIN")
                control = dict(con.execute("SELECT * FROM wr_evidence_control WHERE id=1").fetchone())
                yield packed({"record": "manifest", "schema_version": 1, "control": control,
                              "index": "context.hash -> event.context_hash; events ordered by server ordinal, not client clocks",
                              "limitations": "Text replay only. Server queue is not durable: unacknowledged tail is unknown/gap even if no session row exists. Unclosed sessions also have an unknown tail; no capability inference. Exported files are not removed by clear."}) + "\n"
                for row in con.execute("SELECT * FROM wr_evidence_context ORDER BY hash"):
                    yield packed({"record": "context", "hash": row["hash"], "snapshot": json.loads(row["payload"])}) + "\n"
                for row in con.execute("SELECT * FROM wr_evidence_event ORDER BY ordinal"):
                    yield packed({"record": "event", "ordinal": row["ordinal"], "collection_epoch": row["epoch"], "received_time": row["received"], **json.loads(row["payload"])}) + "\n"
                for row in con.execute("SELECT * FROM wr_evidence_session ORDER BY first_seen"):
                    yield packed({"record": "session_index", **dict(row), "tail": "closed" if row["closed"] else "unknown/gap"}) + "\n"
            finally:
                con.close()
        return StreamingResponse(lines(), media_type="application/x-ndjson",
                                 headers={"Content-Disposition": 'attachment; filename="wise-reader-evidence-v1.jsonl"', "Cache-Control": "no-store"})

    app.include_router(router)
