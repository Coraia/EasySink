"""全书搜索：FTS5 文档粗筛 + 单书兜底扫描 + 按需块级游标分页定位。"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from starlette.concurrency import run_in_threadpool

from wise_reader import content
from wise_reader.collections_source import utf16
from wise_reader.plugins.runtime import PluginContext, require_plugin

PLUGIN_ID = "search"
_CJK_RE = re.compile(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_ASCII_TOKEN_RE = re.compile(r"[0-9A-Za-z]+")
_CURSOR_RE = re.compile(r"[0-9]+:[0-9]+:[0-9]+")
_WS_RE = re.compile(r"\s+")
_BEFORE_CHARS = 42
_AFTER_CHARS = 56


def migrate(store) -> None:
    existed = bool(
        store.query_one(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wr_doc_fts'"
        )
    )
    store.executescript(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS wr_doc_fts USING fts5(
            text,
            content='document', content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS wr_doc_fts_ai AFTER INSERT ON document BEGIN
            INSERT INTO wr_doc_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS wr_doc_fts_ad AFTER DELETE ON document BEGIN
            INSERT INTO wr_doc_fts(wr_doc_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS wr_doc_fts_au AFTER UPDATE OF text ON document BEGIN
            INSERT INTO wr_doc_fts(wr_doc_fts, rowid, text) VALUES ('delete', old.id, old.text);
            INSERT INTO wr_doc_fts(rowid, text) VALUES (new.id, new.text);
        END;
        """
    )
    if not existed:
        store.execute("INSERT INTO wr_doc_fts(wr_doc_fts) VALUES('rebuild')")


def _parse_cursor(cursor: str | None) -> tuple[int, int, int] | None:
    if cursor is None:
        return None
    if not _CURSOR_RE.fullmatch(cursor):
        raise HTTPException(422, "invalid cursor")
    chapter_idx, block_index, offset_cp = (int(part) for part in cursor.split(":"))
    return chapter_idx, block_index, offset_cp


def _build_fts_query(query: str) -> str | None:
    if _CJK_RE.search(query):
        return None
    folded = "".join(
        ch
        for ch in unicodedata.normalize("NFKD", query)
        if unicodedata.category(ch) != "Mn"
    )
    tokens = _ASCII_TOKEN_RE.findall(folded)
    if not tokens:
        return None
    if len(tokens) == 1:
        return f'"{tokens[0]}"*'
    parts = [*(f'"{t}"' for t in tokens[:-1]), f'"{tokens[-1]}"*']
    return " + ".join(parts)


def _candidate_chapters(store, book_id: int, query: str) -> list[dict]:
    fts_query = _build_fts_query(query)
    if fts_query:
        rows = store.query(
            "SELECT c.idx, c.doc_id, c.title FROM wr_doc_fts "
            "JOIN wr_chapter c ON c.doc_id = wr_doc_fts.rowid "
            "WHERE c.book_id = ? AND wr_doc_fts MATCH ? "
            "ORDER BY c.idx",
            (book_id, fts_query),
        )
        if rows:
            return rows

    if query.isascii():
        return store.query(
            "SELECT c.idx, c.doc_id, c.title FROM wr_chapter c "
            "JOIN document d ON d.id = c.doc_id "
            "WHERE c.book_id = ? AND instr(lower(d.text), ?) > 0 "
            "ORDER BY c.idx",
            (book_id, query.lower()),
        )

    if query.lower() == query.upper():
        return store.query(
            "SELECT c.idx, c.doc_id, c.title FROM wr_chapter c "
            "JOIN document d ON d.id = c.doc_id "
            "WHERE c.book_id = ? AND instr(d.text, ?) > 0 "
            "ORDER BY c.idx",
            (book_id, query),
        )

    needle = query.casefold()
    rows = store.query(
        "SELECT c.idx, c.doc_id, c.title, d.text FROM wr_chapter c "
        "JOIN document d ON d.id = c.doc_id "
        "WHERE c.book_id = ? ORDER BY c.idx",
        (book_id,),
    )
    return [
        {"idx": r["idx"], "doc_id": r["doc_id"], "title": r["title"]}
        for r in rows
        if needle in r["text"].casefold()
    ]


def _chapter_blocks(store, doc_id: int) -> tuple[str | None, list[dict]]:
    row = store.query_one(
        "SELECT version, blocks FROM wr_content WHERE doc_id = ?", (doc_id,)
    )
    if row is not None:
        return row["version"], json.loads(row["blocks"])
    doc = store.query_one("SELECT text FROM document WHERE id = ?", (doc_id,))
    if doc is None:
        return None, []
    version = hashlib.sha256(doc["text"].encode()).hexdigest()
    return version, content.blocks_from_text(doc["text"])


def _snippet(text: str, start: int, end: int) -> tuple[str, str, str]:
    raw_before = text[max(0, start - _BEFORE_CHARS) : start]
    before = _WS_RE.sub(" ", raw_before).lstrip()
    if start > _BEFORE_CHARS:
        before = "…" + before
    match_text = _WS_RE.sub(" ", text[start:end])
    raw_after = text[end : end + _AFTER_CHARS]
    after = _WS_RE.sub(" ", raw_after).rstrip()
    if end + _AFTER_CHARS < len(text):
        after = after + "…"
    return before, match_text, after


def _pdf_coverage(store, book: dict, pdf) -> dict | None:
    if book["source"] != "pdf" or pdf is None:
        return None
    mapping = pdf.mapping(book["id"])
    if not mapping:
        return None
    source = pdf.originals.book(mapping["source_id"])
    if not source:
        return None
    totals = store.query_one(
        "SELECT COALESCE(SUM(ready_count), 0) AS ready_count "
        "FROM wr_pdf_range WHERE book_id = ?",
        (book["id"],),
    )
    return {
        "ready_pages": int(totals["ready_count"] if totals else 0),
        "page_count": int(source["page_count"]),
    }


def search_book(
    store,
    book_id: int,
    query: str,
    *,
    limit: int = 30,
    cursor: str | None = None,
    headings_only: bool = False,
    pdf=None,
) -> dict:
    book = store.query_one("SELECT id, source FROM wr_book WHERE id = ?", (book_id,))
    if not book:
        raise HTTPException(404, "not found")
    if book["source"] == "pdf" and pdf is not None and not pdf.visible(book_id):
        raise HTTPException(404, "not found")

    parsed_cursor = _parse_cursor(cursor)
    q = query.strip()
    coverage = _pdf_coverage(store, book, pdf)
    if not q:
        return {
            "book_id": book_id,
            "query": "",
            "hits": [],
            "has_more": False,
            "next_cursor": None,
            "matched_chapters": 0,
            "coverage": coverage,
        }

    candidates = _candidate_chapters(store, book_id, q)
    pattern = re.compile(re.escape(q), re.IGNORECASE)
    hits: list[dict] = []
    has_more = False
    next_cursor: str | None = None

    for ch in candidates:
        if parsed_cursor is not None and ch["idx"] < parsed_cursor[0]:
            continue
        version, blocks = _chapter_blocks(store, ch["doc_id"])
        if version is None or not blocks:
            continue
        on_cursor_chapter = parsed_cursor is not None and ch["idx"] == parsed_cursor[0]
        start_block = parsed_cursor[1] if on_cursor_chapter else 0

        for block_index, block in enumerate(blocks):
            if block_index < start_block:
                continue
            block_type = block.get("type", "paragraph")
            text = block.get("text")
            if block_type in {"image", "image_fallback"} or not isinstance(text, str) or not text:
                continue
            is_heading = block_type == "heading"
            if headings_only and not is_heading:
                continue
            on_cursor_block = on_cursor_chapter and block_index == start_block
            min_offset = parsed_cursor[2] if on_cursor_block else 0

            for match in pattern.finditer(text):
                m_start = match.start()
                if m_start < min_offset:
                    continue
                if len(hits) >= limit:
                    next_cursor = f"{ch['idx']}:{block_index}:{m_start}"
                    has_more = True
                    break
                m_end = match.end()
                start_u16 = utf16(text[:m_start])
                end_u16 = utf16(text[:m_end])
                quote = text[m_start:m_end]
                anchor = {
                    "version": version,
                    "block_id": block["id"],
                    "start": start_u16,
                    "end": end_u16,
                    "quote": quote,
                    "prefix": text[max(0, m_start - 32) : m_start],
                    "suffix": text[m_end : m_end + 32],
                }
                source = block.get("source")
                if source:
                    anchor["pdf_source"] = source
                before, match_text, after = _snippet(text, m_start, m_end)
                page_number = block.get("source_page") or (source or {}).get("page_number")
                hits.append(
                    {
                        "doc_id": ch["doc_id"],
                        "chapter_idx": ch["idx"],
                        "chapter_title": ch["title"],
                        "page_number": page_number,
                        "block_id": block["id"],
                        "block_type": block_type,
                        "is_heading": is_heading,
                        "snippet_before": before,
                        "snippet_match": match_text,
                        "snippet_after": after,
                        "anchor": anchor,
                    }
                )
            if has_more:
                break
        if has_more:
            break

    return {
        "book_id": book_id,
        "query": q,
        "hits": hits,
        "has_more": has_more,
        "next_cursor": next_cursor,
        "matched_chapters": len(candidates),
        "coverage": coverage,
    }


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.get("/api/library/books/{book_id}/search")
    async def search_book_route(
        book_id: int,
        q: str = Query(min_length=1, max_length=120),
        limit: int = Query(default=30, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=64),
        headings_only: bool = Query(default=False),
    ):
        pdf = getattr(app.state, "pdf", None)
        return await run_in_threadpool(
            search_book,
            ctx.store,
            book_id,
            q,
            limit=limit,
            cursor=cursor,
            headings_only=headings_only,
            pdf=pdf,
        )

    app.include_router(router)
