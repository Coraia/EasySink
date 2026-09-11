from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from wise_reader.content import Anchor, save_anchor, with_anchor
from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store

PLUGIN_ID = "notes"


class NoteIn(BaseModel):
    anchor: Anchor | None = None
    doc_id: int
    client_id: str = Field(default="", max_length=80)
    quote: str = ""
    body: str = Field(min_length=1)


def migrate(store: Store) -> None:
    store.executescript(
        """
        CREATE TABLE IF NOT EXISTS wr_note_key(client_id TEXT PRIMARY KEY,note_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS wr_note (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL,
            quote TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.get("/api/notes")
    def list_notes(doc_id: int | None = None):
        if doc_id is None:
            rows = ctx.store.query(
                "SELECT n.*, d.title FROM wr_note n"
                " LEFT JOIN document d ON d.id = n.doc_id"
                " ORDER BY n.id DESC"
            )
        else:
            rows = ctx.store.query(
                "SELECT n.*, d.title FROM wr_note n"
                " LEFT JOIN document d ON d.id = n.doc_id"
                " WHERE n.doc_id = ? ORDER BY n.id DESC",
                (doc_id,),
            )
        return [with_anchor(ctx.store, "note", r) for r in rows]

    @router.post("/api/notes")
    def add_note(body: NoteIn):
        if ctx.store.get_document(body.doc_id) is None:
            raise HTTPException(404, "document")
        if not body.body.strip():
            raise HTTPException(400, "笔记不能为空")
        with ctx.store.transaction():
            existing = (
                ctx.store.query_one(
                    "SELECT note_id FROM wr_note_key WHERE client_id=?",
                    (body.client_id,),
                )
                if body.client_id
                else None
            )
            if existing:
                return update_note(existing["note_id"], body)
            cur = ctx.store.execute(
                "INSERT INTO wr_note(doc_id, quote, body, created_at) VALUES (?,?,?,?)",
                (body.doc_id, body.quote.strip(), body.body.strip(), _now()),
            )
            if body.client_id:
                ctx.store.execute(
                    "INSERT INTO wr_note_key VALUES(?,?)",
                    (body.client_id, cur.lastrowid),
                )
            save_anchor(ctx.store, "note", cur.lastrowid, body.doc_id, body.anchor)
            return with_anchor(
                ctx.store,
                "note",
                ctx.store.query_one(
                    "SELECT * FROM wr_note WHERE id = ?", (int(cur.lastrowid),)
                ),
            )

    @router.put("/api/notes/{note_id}")
    def update_note(note_id: int, body: NoteIn):
        if not body.body.strip():
            raise HTTPException(400, "笔记不能为空")
        old = ctx.store.query_one("SELECT * FROM wr_note WHERE id=?", (note_id,))
        if not old or old["doc_id"] != body.doc_id:
            raise HTTPException(404, "笔记不存在")
        ctx.store.execute(
            "UPDATE wr_note SET body=?,quote=? WHERE id=?",
            (body.body.strip(), body.quote, note_id),
        )
        save_anchor(ctx.store, "note", note_id, body.doc_id, body.anchor)
        return with_anchor(
            ctx.store,
            "note",
            ctx.store.query_one("SELECT * FROM wr_note WHERE id=?", (note_id,)),
        )

    @router.delete("/api/notes/{note_id}")
    def delete_note(note_id: int):
        ctx.store.execute("DELETE FROM wr_note WHERE id = ?", (note_id,))
        ctx.store.execute("DELETE FROM wr_note_key WHERE note_id=?", (note_id,))
        ctx.store.execute(
            "DELETE FROM wr_anchor WHERE owner='note' AND owner_id=?", (note_id,)
        )
        return {"ok": True}

    app.include_router(router)
