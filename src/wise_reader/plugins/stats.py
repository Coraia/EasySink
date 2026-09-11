from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store

PLUGIN_ID = "stats"


class HeartbeatIn(BaseModel):
    doc_id: int
    seconds: int = Field(ge=1, le=120)


def migrate(store: Store) -> None:
    store.executescript(
        """
        CREATE TABLE IF NOT EXISTS wr_session_time (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL,
            seconds INTEGER NOT NULL,
            at TEXT NOT NULL
        );
        """
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.post("/api/stats/heartbeat")
    def heartbeat(body: HeartbeatIn):
        if ctx.store.get_document(body.doc_id) is None:
            raise HTTPException(404, "document")
        ctx.store.execute(
            "INSERT INTO wr_session_time(doc_id, seconds, at) VALUES (?,?,?)",
            (body.doc_id, body.seconds, _now()),
        )
        return {"ok": True}

    @router.get("/api/stats")
    def summary():
        total = ctx.store.query_one("SELECT COALESCE(SUM(seconds),0) AS s FROM wr_session_time")
        docs = ctx.store.query_one("SELECT COUNT(*) AS n FROM document")
        unknown = ctx.store.query_one(
            "SELECT COUNT(*) AS n FROM word_verdict WHERE verdict = 'unknown'"
        )
        known = ctx.store.query_one(
            "SELECT COUNT(*) AS n FROM word_verdict WHERE verdict = 'known'"
        )
        by_doc = ctx.store.query(
            "SELECT d.title, SUM(s.seconds) AS seconds FROM wr_session_time s"
            " JOIN document d ON d.id = s.doc_id"
            " GROUP BY s.doc_id ORDER BY seconds DESC LIMIT 12"
        )
        return {
            "seconds": int(total["s"]) if total else 0,
            "document_count": int(docs["n"]) if docs else 0,
            "known_count": int(known["n"]) if known else 0,
            "unknown_count": int(unknown["n"]) if unknown else 0,
            "by_document": by_doc,
        }

    app.include_router(router)
