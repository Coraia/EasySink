from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel

from wise_reader.jobs import chunks as _chunks
from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store

PLUGIN_ID = "translate"
SYS = "将下面英文译为流畅中文。只输出译文，不要解释，不要加标题。"


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


__all__ = ["_chunks", "migrate", "register"]


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

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
            if not ctx.l1_on:
                raise HTTPException(
                    400, "未配置 LLM。可粘贴译文，或在 .env 开启 WR_LLM。"
                )
            return app.state.jobs.enqueue([doc_id])
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
        ids = [
            r["doc_id"]
            for r in ctx.store.query(
                "SELECT doc_id FROM wr_chapter WHERE book_id=? ORDER BY idx", (book_id,)
            )
        ]
        return app.state.jobs.enqueue(ids)

    app.include_router(router)
