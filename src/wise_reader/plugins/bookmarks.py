from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel

from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store

PLUGIN_ID = "bookmarks"


class BookmarkIn(BaseModel):
    doc_id: int
    label: str = ""
    scroll_ratio: float = 0.0


def migrate(store: Store) -> None:
    store.executescript(
        """
        CREATE TABLE IF NOT EXISTS wr_bookmark (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            scroll_ratio REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        """
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.get("/api/bookmarks")
    def list_bm(doc_id: int | None = None):
        if doc_id is None:
            return ctx.store.query(
                "SELECT b.*, d.title FROM wr_bookmark b"
                " LEFT JOIN document d ON d.id = b.doc_id ORDER BY b.id DESC"
            )
        return ctx.store.query(
            "SELECT b.*, d.title FROM wr_bookmark b"
            " LEFT JOIN document d ON d.id = b.doc_id"
            " WHERE b.doc_id = ? ORDER BY b.id DESC",
            (doc_id,),
        )

    @router.post("/api/bookmarks")
    def add_bm(body: BookmarkIn):
        if ctx.store.get_document(body.doc_id) is None:
            raise HTTPException(404, "document")
        ratio = max(0.0, min(1.0, body.scroll_ratio))
        label = body.label.strip() or f"{int(ratio * 100)}%"
        cur = ctx.store.execute(
            "INSERT INTO wr_bookmark(doc_id, label, scroll_ratio, created_at) VALUES (?,?,?,?)",
            (body.doc_id, label, ratio, _now()),
        )
        return ctx.store.query_one("SELECT * FROM wr_bookmark WHERE id = ?", (int(cur.lastrowid),))

    @router.delete("/api/bookmarks/{bm_id}")
    def del_bm(bm_id: int):
        ctx.store.execute("DELETE FROM wr_bookmark WHERE id = ?", (bm_id,))
        return {"ok": True}

    app.include_router(router)
