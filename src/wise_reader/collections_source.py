"""Verified collection snapshots and conservative, read-only source resolution."""
from __future__ import annotations

import hashlib
import json

from fastapi import HTTPException

from wise_reader.content import Anchor, AnchorSegment, PDFSource, blocks_from_text

MAX_QUOTE = 8000
MAX_CONTEXT = 6000
MAX_CANDIDATES = 32


def packed(value):
    try:
        result = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        result.encode("utf-8")
        return result
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise HTTPException(422, "记录包含无效文字或结构") from None


def digest(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def index(text, offset):
    raw = text.encode("utf-16-le")
    if offset < 0 or offset * 2 > len(raw):
        raise HTTPException(400, "选区超出原文范围")
    try:
        return len(raw[:offset * 2].decode("utf-16-le"))
    except UnicodeDecodeError:
        raise HTTPException(400, "选区不是完整字符，请重新选择") from None


def exists(store, table):
    return bool(store.query_one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)))


def content(store, doc_id, version=""):
    doc = store.get_document(doc_id)
    if not doc:
        raise HTTPException(404, "原文不存在")
    row = store.query_one("SELECT version,blocks FROM wr_content WHERE doc_id=?", (doc_id,))
    current = row["version"] if row else hashlib.sha256(doc["text"].encode()).hexdigest()
    blocks = json.loads(row["blocks"]) if row else blocks_from_text(doc["text"])
    if version and version != current:
        old = store.query_one("SELECT * FROM wr_pdf_revision WHERE doc_id=? AND revision=?", (doc_id, version)) if exists(store, "wr_pdf_revision") else None
        if not old:
            raise HTTPException(409, "原文版本已变化，请重新选择")
        doc = {**doc, "title": old["title"], "text": old["text"]}
        return doc, version, json.loads(old["blocks"])
    return doc, current, blocks


def identity(store, doc, version):
    chapter = store.query_one("SELECT c.*,b.title AS book_title,b.author,b.source FROM wr_chapter c JOIN wr_book b ON b.id=c.book_id WHERE c.doc_id=? ORDER BY c.id LIMIT 1", (doc["id"],))
    book_id = chapter["book_id"] if chapter else None
    fingerprint, source_kind = "", "text"
    if book_id and exists(store, "wr_pdf_book"):
        pdf = store.query_one("SELECT source_sha256 FROM wr_pdf_book WHERE book_id=?", (book_id,))
        if pdf:
            fingerprint, source_kind = pdf["source_sha256"], "pdf"
    if book_id and not fingerprint and exists(store, "wr_import_source"):
        source = store.query_one("SELECT fingerprint FROM wr_import_source WHERE book_id=? ORDER BY fingerprint LIMIT 1", (book_id,))
        if source:
            fingerprint, source_kind = source["fingerprint"], "epub"
    return {
        "schema": 1, "version": version,
        "text_sha256": hashlib.sha256(doc["text"].encode()).hexdigest(),
        "text_lookup_hash": hashlib.sha256("\n".join(line.rstrip() for line in doc["text"].replace("\r\n", "\n").split("\n")).encode()).hexdigest(),
        "document_title": doc["title"], "book_title": chapter["book_title"] if chapter else "",
        "book_author": chapter["author"] if chapter else "",
        "chapter_index": chapter["idx"] if chapter else None,
        "source_kind": source_kind, "fingerprint": fingerprint,
    }, book_id


def validate(store, doc_id, anchor):
    """Same continuous UTF-16 range rules as reading_assist.selected; no writes."""
    doc, version, blocks = content(store, doc_id, anchor.version)
    parts = anchor.segments or [anchor]
    if anchor.segments and (len(parts) < 2 or any(getattr(anchor, k) != getattr(parts[0], k) for k in ("block_id", "start", "end"))):
        raise HTTPException(400, "选区起点不一致")
    positions, cursor = {}, 0
    for number, block in enumerate(blocks):
        positions[block["id"]] = (number, cursor)
        cursor += utf16(block["text"]) + 2
    resolved, previous, bounds = [], None, []
    for number, part in enumerate(parts):
        pos = positions.get(part.block_id)
        if pos is None or (previous is not None and pos[0] != previous + 1):
            raise HTTPException(400, "请选择连续的原文")
        previous = pos[0]
        block = blocks[pos[0]]
        if part.kind != "text" or (block.get("asset_url") and block.get("type") in {"image", "image_fallback", "formula", "table"}):
            raise HTTPException(422, "收藏文字需要已识别的原文选区")
        text = block["text"]
        start, end = index(text, part.start), index(text, part.end)
        quote = text[start:end]
        if end <= start or not quote.strip():
            raise HTTPException(400, "请先选择原文")
        if len(parts) > 1 and ((number > 0 and start != 0) or (number < len(parts) - 1 and end != len(text))):
            raise HTTPException(400, "跨段选区不连续")
        # A root's quote is the entire selection, not its first segment.
        supplied = part.quote if anchor.segments else anchor.quote
        if supplied and supplied != quote:
            raise HTTPException(409, "选区与原文不一致")
        pdf = PDFSource.model_validate(block["source"]) if block.get("source", {}).get("page_number") else None
        resolved.append(AnchorSegment(block_id=part.block_id, start=part.start, end=part.end,
            quote=quote, prefix=text[max(0, start - 40):start], suffix=text[end:end + 40], pdf_source=pdf))
        bounds.append((pos[1] + part.start, pos[1] + part.end))
    quote = "\n\n".join(p.quote for p in resolved)
    if anchor.quote and anchor.quote != quote:
        raise HTTPException(409, "选区与原文不一致")
    if utf16(quote) > MAX_QUOTE:
        raise HTTPException(400, "本次收藏或合并超过 8000 个字符，请缩短选区")
    out = Anchor(**{**resolved[0].model_dump(), "version": version, "quote": quote,
        "segments": resolved if len(resolved) > 1 else []})
    # Snapshot context never includes personal records or a whole long chapter.
    first, last = positions[parts[0].block_id][0], positions[parts[-1].block_id][0]
    before = blocks[first]["text"][:index(blocks[first]["text"], parts[0].start)]
    after = blocks[last]["text"][index(blocks[last]["text"], parts[-1].end):]
    before = ((blocks[first - 1]["text"] + "\n\n") if first else "") + before
    after += ("\n\n" + blocks[last + 1]["text"]) if last + 1 < len(blocks) else ""
    raw_context = before + quote + after
    budget = max(0, (MAX_CONTEXT - utf16(quote)) // 2)
    def clip(text, size, tail=False):
        data = text.encode("utf-16-le")
        return (data[-size * 2:] if tail and size else data[:size * 2]).decode("utf-16-le", errors="ignore") if size else ""
    context_text = clip(before, budget, True) + clip(quote, MAX_CONTEXT) + clip(after, budget)
    source, book_id = identity(store, doc, version)
    return {"doc_id": doc_id, "book_id": book_id, "title": doc["title"],
        "book_title": source["book_title"], "anchor": out.model_dump(mode="json"),
        "quote": quote, "context": context_text, "context_truncated": context_text != raw_context,
        "source_identity": source, "start_pos": bounds[0][0], "end_pos": bounds[-1][1]}


def union_anchor(store, doc_id, version, start, end):
    _, _, blocks = content(store, doc_id, version)
    cursor, parts = 0, []
    for block in blocks:
        length = utf16(block["text"])
        lo, hi = max(0, start - cursor), min(length, end - cursor)
        if lo < hi:
            parts.append(AnchorSegment(block_id=block["id"], start=lo, end=hi))
        cursor += length + 2
    if not parts or len(parts) > 256:
        raise HTTPException(400, "合并范围过大或不存在")
    return Anchor(**{**parts[0].model_dump(), "version": version, "segments": parts if len(parts) > 1 else []})


def same_origin(saved, current):
    if saved.get("fingerprint"):
        return (saved.get("source_kind"), saved["fingerprint"], saved.get("chapter_index")) == (current.get("source_kind"), current.get("fingerprint"), current.get("chapter_index"))
    keys = ("text_sha256", "document_title", "book_title", "book_author", "chapter_index")
    return all(saved.get(k) == current.get(k) for k in keys)


def candidate_ids(store, source):
    fingerprint = source.get("fingerprint")
    if fingerprint and source.get("source_kind") == "pdf" and exists(store, "wr_pdf_book"):
        rows = store.query("SELECT c.doc_id FROM wr_pdf_book p JOIN wr_chapter c ON c.book_id=p.book_id WHERE p.source_sha256=? AND c.idx=? LIMIT ?", (fingerprint, source.get("chapter_index"), MAX_CANDIDATES + 1))
    elif fingerprint and source.get("source_kind") == "epub" and exists(store, "wr_import_source"):
        rows = store.query("SELECT c.doc_id FROM wr_import_source p JOIN wr_chapter c ON c.book_id=p.book_id WHERE p.fingerprint=? AND c.idx=? LIMIT ?", (fingerprint, source.get("chapter_index"), MAX_CANDIDATES + 1))
    else:
        rows = store.query("SELECT id AS doc_id FROM document WHERE text_hash=? LIMIT ?", (source.get("text_lookup_hash", source.get("text_sha256", "")), MAX_CANDIDATES + 1))
    return list(dict.fromkeys(r["doc_id"] for r in rows)) if len(rows) <= MAX_CANDIDATES else []


def unique_quote(store, doc_id, saved, version, blocks):
    """Exact continuous quote, with saved edge context, in a verified origin only."""
    quote = saved["quote"]
    old = saved["anchor"]
    parts = old.get("segments") or [old]
    prefix, suffix = parts[0].get("prefix", ""), parts[-1].get("suffix", "")
    if len(quote.strip()) < 12 and not (prefix or suffix):
        return None
    text = "\n\n".join(b["text"] for b in blocks)
    # Bound work to this document and stop as soon as a second reliable match exists.
    offset, hits = 0, []
    while True:
        pos = text.find(quote, offset)
        if pos < 0:
            break
        offset = pos + 1
        if prefix and not text[:pos].endswith(prefix):
            continue
        if suffix and not text[pos + len(quote):].startswith(suffix):
            continue
        hits.append(pos)
        if len(hits) > 1:
            return None
    if len(hits) != 1:
        return None
    start = utf16(text[:hits[0]])
    try:
        snap = validate(store, doc_id, union_anchor(store, doc_id, version, start, start + utf16(quote)))
    except HTTPException:
        return None
    return snap if snap["quote"] == quote else None


def resolve(store, saved, *, imported=False):
    source = saved["source_identity"]
    ids = candidate_ids(store, source) if imported or not saved.get("doc_id") else [saved["doc_id"]]
    matches = []
    for doc_id in ids:
        try:
            doc, version, blocks = content(store, doc_id)
            current, _ = identity(store, doc, version)
            if not same_origin(source, current):
                continue
            if store.query_one("SELECT 1 FROM wr_archive WHERE doc_id=?", (doc_id,)):
                continue
            if current["source_kind"] == "pdf" and exists(store, "wr_pdf_book"):
                pdf = store.query_one("SELECT lifecycle FROM wr_pdf_book WHERE source_sha256=?", (current["fingerprint"],))
                if not pdf or pdf["lifecycle"] != "active":
                    continue
            snap = None
            if version == source.get("version"):
                try:
                    snap = validate(store, doc_id, Anchor.model_validate(saved["anchor"]))
                except (HTTPException, ValueError):
                    pass
            if snap is None:
                snap = unique_quote(store, doc_id, saved, version, blocks)
            if snap:
                matches.append(snap)
        except HTTPException:
            continue
    if len(matches) != 1:
        if not imported and saved.get("doc_id"):
            # A local ID is only a hint after removal/reimport. Reuse the bounded
            # stable-origin search and its ambiguity checks; never guess a new ID.
            return resolve(store, saved, imported=True)
        return None
    return matches[0]


def resolve_document(store, source):
    """For unanchored notes only: bind a unique whole-source identity, not an ID."""
    matches = []
    for doc_id in candidate_ids(store, source):
        try:
            doc, version, _ = content(store, doc_id)
            current, book_id = identity(store, doc, version)
        except HTTPException:
            continue
        if not same_origin(source, current) or current["text_sha256"] != source.get("text_sha256"):
            continue
        if store.query_one("SELECT 1 FROM wr_archive WHERE doc_id=?", (doc_id,)):
            continue
        if current["source_kind"] == "pdf" and exists(store, "wr_pdf_book"):
            pdf = store.query_one("SELECT lifecycle FROM wr_pdf_book WHERE source_sha256=?", (current["fingerprint"],))
            if not pdf or pdf["lifecycle"] != "active":
                continue
        matches.append({"doc_id": doc_id, "book_id": book_id, "anchor": None, "start_pos": -1, "end_pos": -1})
    return matches[0] if len(matches) == 1 else None


def anchor_key(anchor):
    if not anchor:
        return None
    return [anchor.get("version"), [[p.get("block_id"), p.get("start"), p.get("end"), p.get("quote")] for p in anchor.get("segments") or [anchor]]]
