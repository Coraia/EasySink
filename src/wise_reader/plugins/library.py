"""书架：书 → 章节 → 已有 document 行。不改核心 document 表。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel

from wise_reader.content import add_book, add_chapter
from wise_reader.content import migrate as migrate
from wise_reader.plugins.runtime import PluginContext, require_plugin

PLUGIN_ID = "library"


class BookIn(BaseModel):
    title: str
    author: str = ""
    source: str = "manual"


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.get("/api/library/books")
    def list_books():
        books = ctx.store.query("SELECT * FROM wr_book ORDER BY id DESC")
        out = []
        for b in books:
            ch = ctx.store.query(
                "SELECT c.*, d.word_count FROM wr_chapter c"
                " JOIN document d ON d.id = c.doc_id"
                " WHERE c.book_id = ? ORDER BY c.idx",
                (b["id"],),
            )
            out.append({**b, "chapters": ch, "chapter_count": len(ch)})
        return out

    @router.get("/api/library/books/{book_id}")
    def get_book(book_id: int):
        b = ctx.store.query_one("SELECT * FROM wr_book WHERE id = ?", (book_id,))
        if not b:
            raise HTTPException(404, "not found")
        ch = ctx.store.query(
            "SELECT c.*, d.word_count FROM wr_chapter c"
            " JOIN document d ON d.id = c.doc_id"
            " WHERE c.book_id = ? ORDER BY c.idx",
            (book_id,),
        )
        return {**b, "chapters": ch}

    @router.post("/api/library/books")
    def create_book(body: BookIn):
        book_id = add_book(
            ctx.store, body.title.strip() or "untitled", body.author, body.source
        )
        return ctx.store.query_one("SELECT * FROM wr_book WHERE id = ?", (book_id,))

    @router.post("/api/library/books/{book_id}/adopt/{doc_id}")
    def adopt(book_id: int, doc_id: int):
        if not ctx.store.query_one("SELECT id FROM wr_book WHERE id = ?", (book_id,)):
            raise HTTPException(404, "book")
        doc = ctx.store.get_document(doc_id)
        if doc is None:
            raise HTTPException(404, "document")
        row = ctx.store.query_one(
            "SELECT COALESCE(MAX(idx), -1) AS m FROM wr_chapter WHERE book_id = ?",
            (book_id,),
        )
        idx = int(row["m"]) + 1 if row else 0
        add_chapter(ctx.store, book_id, idx, doc["title"], doc_id)
        return {"ok": True}

    @router.delete("/api/library/books/{book_id}")
    def delete_book(book_id: int):
        ch = ctx.store.query(
            "SELECT doc_id FROM wr_chapter WHERE book_id = ?", (book_id,)
        )
        ctx.store.execute("DELETE FROM wr_chapter WHERE book_id = ?", (book_id,))
        ctx.store.execute("DELETE FROM wr_book WHERE id = ?", (book_id,))
        for row in ch:
            ctx.store.delete_document(row["doc_id"])
        return {"ok": True}

    app.include_router(router)
