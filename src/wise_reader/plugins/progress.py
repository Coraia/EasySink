from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel

from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store

PLUGIN_ID = "progress"


class ProgressIn(BaseModel):
    scroll_ratio: float = 0.0


def migrate(store: Store) -> None:
    store.executescript(
        """
        CREATE TABLE IF NOT EXISTS wr_progress (
            doc_id INTEGER PRIMARY KEY,
            scroll_ratio REAL NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        """
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.get("/api/progress")
    def latest():
        return ctx.store.query(
            "SELECT p.*, d.title, d.word_count FROM wr_progress p"
            " JOIN document d ON d.id = p.doc_id"
            " ORDER BY p.updated_at DESC LIMIT 8"
        )

    @router.get("/api/documents/{doc_id}/progress")
    def get_one(doc_id: int):
        row = ctx.store.query_one("SELECT * FROM wr_progress WHERE doc_id = ?", (doc_id,))
        return row or {"doc_id": doc_id, "scroll_ratio": 0, "updated_at": None}

    @router.put("/api/documents/{doc_id}/progress")
    def put_one(doc_id: int, body: ProgressIn):
        if ctx.store.get_document(doc_id) is None:
            raise HTTPException(404, "document")
        ratio = max(0.0, min(1.0, body.scroll_ratio))
        ctx.store.execute(
            "INSERT INTO wr_progress(doc_id, scroll_ratio, updated_at) VALUES (?,?,?)"
            " ON CONFLICT(doc_id) DO UPDATE SET scroll_ratio=excluded.scroll_ratio,"
            " updated_at=excluded.updated_at",
            (doc_id, ratio, _now()),
        )
        return {"ok": True, "scroll_ratio": ratio}

    app.include_router(router)
