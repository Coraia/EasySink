from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store

PLUGIN_ID = "notes"


class NoteIn(BaseModel):
    doc_id: int
    quote: str = ""
    body: str = Field(min_length=1)


def migrate(store: Store) -> None:
    store.executescript(
        """
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
        return rows

    @router.post("/api/notes")
    def add_note(body: NoteIn):
        if ctx.store.get_document(body.doc_id) is None:
            raise HTTPException(404, "document")
        cur = ctx.store.execute(
            "INSERT INTO wr_note(doc_id, quote, body, created_at) VALUES (?,?,?,?)",
            (body.doc_id, body.quote.strip(), body.body.strip(), _now()),
        )
        return ctx.store.query_one("SELECT * FROM wr_note WHERE id = ?", (int(cur.lastrowid),))

    @router.delete("/api/notes/{note_id}")
    def delete_note(note_id: int):
        ctx.store.execute("DELETE FROM wr_note WHERE id = ?", (note_id,))
        return {"ok": True}

    app.include_router(router)
