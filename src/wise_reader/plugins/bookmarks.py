from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel

from wise_reader.content import Anchor, save_anchor, with_anchor
from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store

PLUGIN_ID = "bookmarks"


class BookmarkIn(BaseModel):
    anchor: Anchor | None = None
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
        sql = "SELECT b.*,d.title FROM wr_bookmark b LEFT JOIN document d ON d.id=b.doc_id"
        rows = ctx.store.query(
            sql
            + (" WHERE b.doc_id=?" if doc_id is not None else "")
            + " ORDER BY b.id DESC",
            (doc_id,) if doc_id is not None else (),
        )
        return [with_anchor(ctx.store, "bookmark", r) for r in rows]

    def matching(body):
        if not body.anchor or not body.anchor.block_id:
            return []
        return [
            b
            for b in list_bm(body.doc_id)
            if b.get("anchor") and b["anchor"].get("block_id") == body.anchor.block_id
        ]

    def remove(bm_id):
        ctx.store.execute("DELETE FROM wr_bookmark WHERE id=?", (bm_id,))
        ctx.store.execute(
            "DELETE FROM wr_anchor WHERE owner='bookmark' AND owner_id=?", (bm_id,)
        )

    @router.post("/api/bookmarks")
    def add_bm(body: BookmarkIn):
        with ctx.store.transaction():
            if ctx.store.get_document(body.doc_id) is None:
                raise HTTPException(404, "document")
            existing = matching(body)
            if existing:
                return existing[0]
            ratio = max(0.0, min(1.0, body.scroll_ratio))
            label = body.label.strip() or f"{int(ratio * 100)}%"
            cur = ctx.store.execute(
                "INSERT INTO wr_bookmark(doc_id,label,scroll_ratio,created_at) VALUES(?,?,?,?)",
                (body.doc_id, label, ratio, _now()),
            )
            save_anchor(ctx.store, "bookmark", cur.lastrowid, body.doc_id, body.anchor)
            return with_anchor(
                ctx.store,
                "bookmark",
                ctx.store.query_one(
                    "SELECT * FROM wr_bookmark WHERE id=?", (cur.lastrowid,)
                ),
            )

    @router.post("/api/bookmarks/toggle")
    def toggle(body: BookmarkIn):
        with ctx.store.transaction():
            if ctx.store.get_document(body.doc_id) is None:
                raise HTTPException(404, "document")
            if not body.anchor or not body.anchor.block_id:
                raise HTTPException(400, "请提供正文段落位置")
            existing = matching(body)
            if existing:
                for b in existing:
                    remove(b["id"])
            else:
                add_bm(body)
            return {"active": not bool(existing), "bookmarks": list_bm(body.doc_id)}

    @router.delete("/api/bookmarks/{bm_id}")
    def del_bm(bm_id: int):
        with ctx.store.transaction():
            remove(bm_id)
        return {"ok": True}

    app.include_router(router)
