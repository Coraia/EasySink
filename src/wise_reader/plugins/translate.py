from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel

from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store
from wise_reader.reading_assist import SelectionIn, assist

PLUGIN_ID = "translate"


class TranslateIn(BaseModel):
    lang: str = "zh"
    body: str = ""
    generate: bool = False


def migrate(store: Store) -> None:
    store.executescript(
        """
        CREATE TABLE IF NOT EXISTS wr_translation (
            doc_id INTEGER NOT NULL,
            lang TEXT NOT NULL,
            body TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (doc_id, lang)
        );
        """
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


__all__ = ["migrate", "register"]


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.post("/api/documents/{doc_id}/translate-selection")
    async def translate_selection(doc_id: int, body: SelectionIn, request: Request):
        return await assist(app, ctx, request, doc_id, "translation", body.anchor, body.request_id)

    @router.get("/api/documents/{doc_id}/translation")
    def get_tr(doc_id: int, lang: str = "zh"):
        row = ctx.store.query_one(
            "SELECT * FROM wr_translation WHERE doc_id = ? AND lang = ?",
            (doc_id, lang),
        )
        return row or {"doc_id": doc_id, "lang": lang, "body": "", "source": None}

    @router.put("/api/documents/{doc_id}/translation")
    def put_tr(doc_id: int, body: TranslateIn):
        doc = ctx.store.get_document(doc_id)
        if doc is None:
            raise HTTPException(404, "not found")
        lang = (body.lang or "zh")[:8]
        source = "paste"
        text = body.body.strip()
        if body.generate:
            raise HTTPException(400, "请在阅读页选择文字后翻译，不再生成整章译文")
        if not text:
            raise HTTPException(400, "empty translation")
        ctx.store.execute(
            "INSERT INTO wr_translation(doc_id, lang, body, source, created_at)"
            " VALUES (?,?,?,?,?)"
            " ON CONFLICT(doc_id, lang) DO UPDATE SET body=excluded.body,"
            " source=excluded.source, created_at=excluded.created_at",
            (doc_id, lang, text, source, _now()),
        )
        return ctx.store.query_one(
            "SELECT * FROM wr_translation WHERE doc_id = ? AND lang = ?",
            (doc_id, lang),
        )

    @router.post("/api/translate/books/{book_id}")
    def translate_book(book_id: int):
        raise HTTPException(400, "请在阅读页选择文字后翻译，不提供整书翻译")

    app.include_router(router)
