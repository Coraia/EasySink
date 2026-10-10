from __future__ import annotations

from datetime import datetime, timezone
import json
import secrets

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from wise_reader.content import Anchor, save_anchor, with_anchor
from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store
from wise_reader.note_sources import migrate as migrate_sources
from wise_reader.note_sources import source_snapshot

PLUGIN_ID = "notes"


class NoteIn(BaseModel):
    anchor: Anchor | None = None
    doc_id: int
    client_id: str = Field(default="", max_length=80)
    quote: str = ""
    body: str = Field(min_length=1)


class UndoIn(BaseModel):
    token: str = Field(min_length=1, max_length=100)


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
    migrate_sources(store)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.get("/api/notes")
    def list_notes(doc_id: int | None = None, book_id: int | None = None):
        # Pick one membership even if an older library adopted a document twice.
        sql = (
            "SELECT n.*, COALESCE(d.title,json_extract(NULLIF(n.source_snapshot,''),'$.title')) AS title,"
            " (d.id IS NOT NULL) AS source_available, c.book_id, c.idx AS chapter_idx,"
            " c.title AS chapter_title FROM wr_note n"
            " LEFT JOIN document d ON d.id = n.doc_id"
            " LEFT JOIN wr_chapter c ON c.id ="
            " (SELECT MIN(id) FROM wr_chapter WHERE doc_id = n.doc_id)"
        )
        params = ()
        if book_id is not None:
            sql += " WHERE EXISTS (SELECT 1 FROM wr_chapter b WHERE b.doc_id=n.doc_id AND b.book_id=?)"
            params = (book_id,)
        elif doc_id is not None:
            sql += " WHERE n.doc_id = ?"
            params = (doc_id,)
        rows = ctx.store.query(sql + " ORDER BY n.id DESC", params)
        return [{**with_anchor(ctx.store, "note", r), "source_available": bool(r["source_available"])} for r in rows]

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
        with ctx.store.transaction():
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
        with ctx.store.transaction():
            row = ctx.store.query_one("SELECT * FROM wr_note WHERE id=?", (note_id,))
            if not row:
                raise HTTPException(404, "笔记不存在")
            saved = with_anchor(ctx.store, "note", row)
            saved["source_snapshot"] = source_snapshot(ctx.store, saved)
            chapter = ctx.store.query_one("SELECT book_id FROM wr_chapter WHERE doc_id=? ORDER BY id LIMIT 1", (row["doc_id"],))
            snapshot = json.loads(saved["source_snapshot"])
            token = secrets.token_urlsafe(32)
            ctx.store.execute("INSERT INTO wr_note_undo VALUES(?,?,?,?,?)", (token, row["doc_id"],
                chapter["book_id"] if chapter else snapshot.get("book_id"), json.dumps(saved, ensure_ascii=False), _now()))
            ctx.store.execute("DELETE FROM wr_note WHERE id=?", (note_id,))
            ctx.store.execute("DELETE FROM wr_note_key WHERE note_id=?", (note_id,))
        return {"ok": True, "undo_token": token}

    @router.post("/api/notes/undo")
    def undo_note(body: UndoIn):
        with ctx.store.transaction():
            receipt = ctx.store.query_one("SELECT * FROM wr_note_undo WHERE token=?", (body.token,))
            if not receipt:
                raise HTTPException(409, "这次删除已恢复或已清理")
            saved = json.loads(receipt["payload"])
            if ctx.store.query_one("SELECT id FROM wr_note WHERE id=?", (saved["id"],)):
                raise HTTPException(409, "笔记已变化，不能覆盖")
            ctx.store.execute("INSERT INTO wr_note(id,doc_id,quote,body,created_at,source_snapshot) VALUES(?,?,?,?,?,?)",
                tuple(saved[k] for k in ("id", "doc_id", "quote", "body", "created_at")) + (saved.get("source_snapshot", ""),))
            # The receipt owns the exact pre-delete reference, including no anchor.
            ctx.store.execute("DELETE FROM wr_anchor WHERE owner='note' AND owner_id=?", (saved["id"],))
            if saved.get("anchor") is not None:
                save_anchor(ctx.store, "note", saved["id"], saved["doc_id"], Anchor.model_validate(saved["anchor"]))
            ctx.store.execute("DELETE FROM wr_note_undo WHERE token=?", (body.token,))
            return with_anchor(ctx.store, "note", ctx.store.query_one("SELECT * FROM wr_note WHERE id=?", (saved["id"],)))

    app.include_router(router)
