from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI
from fastapi.responses import PlainTextResponse

from wise_reader.plugins.runtime import PluginContext, require_plugin

PLUGIN_ID = "export"


def migrate(_store) -> None:
    return


def _csv_escape(s: str) -> str:
    s = s.replace('"', '""')
    if any(c in s for c in ",\n\r"):
        return f'"{s}"'
    return s


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.get("/api/export/vocab.csv")
    def vocab_csv():
        rows = ctx.store.query(
            "SELECT lemma, verdict, source, updated_at FROM word_verdict ORDER BY verdict, lemma"
        )
        lines = ["lemma,verdict,source,updated_at"]
        for r in rows:
            lines.append(
                ",".join(_csv_escape(str(r[k])) for k in ("lemma", "verdict", "source", "updated_at"))
            )
        return PlainTextResponse("\n".join(lines) + "\n", media_type="text/csv")

    @router.get("/api/export/notes.md")
    def notes_md():
        try:
            rows = ctx.store.query(
                "SELECT n.*, d.title FROM wr_note n"
                " LEFT JOIN document d ON d.id = n.doc_id ORDER BY n.id"
            )
        except Exception:
            rows = []
        parts = ["# Wise Reader 笔记\n"]
        for r in rows:
            parts.append(f"## {r.get('title') or '#' + str(r['doc_id'])}\n")
            if r.get("quote"):
                parts.append(f"> {r['quote']}\n")
            parts.append(f"{r['body']}\n")
        return PlainTextResponse("\n".join(parts), media_type="text/markdown")

    app.include_router(router)
