"""Explicit, source-verified scopes for annotation feedback; phrases stay independent.

Single words default to whole-word (lemma) cross-book scope; multi-word phrases
default to the selected phrase. Narrower collocations and occurrence-only scope
remain optional under manual scope adjustment.
"""
from __future__ import annotations

import json
import re

from fastapi import HTTPException

from wise_reader.collections_source import content, index, utf16
from wise_reader.lexicon import normalize_query
from wise_reader.source_urls import overlaps_url, url_ranges

WORD = re.compile(r"[A-Za-z]+(?:['’-][A-Za-z]+)*")
STOP = set("a an the of in on at to for from by with and or but as is are was were be been being it its this that these those he she they we i you his her their our my your not no can could may might will would shall should do does did have has had".split())
ASSET_BLOCK_TYPES = {"image", "image_fallback", "formula", "table"}


def lexeme_for(word: str, lexicon=None) -> str:
    normalized = normalize_query(word)
    if lexicon is None:
        return normalized
    lemma = normalize_query(lexicon.lemma(normalized))
    return lemma if WORD.fullmatch(lemma) else normalized


def scope_value(text, start, end, lo, hi):
    pattern = text[lo:hi]
    return {"protocol": "literal-context-v1", "pattern": pattern,
            "target_start": start - lo, "target_end": end - lo}


def _collocation_ranges(text, words, start, end):
    ranges = []
    following = next((w for w in words if w.start() >= end), None)
    previous = next((w for w in reversed(words) if w.end() <= start), None)
    if following and text[end:following.start()].isspace() and following.group().lower() not in STOP:
        ranges.append((start, following.end()))
    if previous and text[previous.end():start].isspace() and previous.group().lower() not in STOP:
        ranges.append((previous.start(), end))
    after = [w for w in words if w.start() >= end][:3]
    before = [w for w in words if w.end() <= start][-3:]
    for candidates, right in ((after, True), (list(reversed(before)), False)):
        edge = end if right else start
        for word in candidates:
            gap = text[edge:word.start()] if right else text[word.end():edge]
            if not gap.isspace():
                break
            edge = word.end() if right else word.start()
            if word.group().lower() not in STOP:
                candidate = (start, edge) if right else (edge, end)
                if candidate not in ranges:
                    ranges.append(candidate)
    return ranges


def choices(store, snap, lexicon=None):
    anchor = snap["anchor"]
    if anchor.get("segments") or len(snap["quote"]) > 96:
        return []
    _, _, blocks = content(store, snap["doc_id"], anchor["version"])
    text = next(b["text"] for b in blocks if b["id"] == anchor["block_id"])
    start, end = index(text, anchor["start"]), index(text, anchor["end"])
    if overlaps_url(url_ranges(text), start, end):
        return []
    if not re.fullmatch(r"[A-Za-z]+(?:['’ -][A-Za-z]+)*", text[start:end]):
        return []
    words = list(WORD.finditer(text))
    selected = [w for w in words if w.start() >= start and w.end() <= end]
    out = []
    if len(selected) == 1:
        lemma = lexeme_for(text[start:end], lexicon)
        out.append({
            "id": f"lexeme:{lemma}",
            "kind": "word",
            "label": f"整个词：{lemma}",
            "usage": {"protocol": "lexeme-v1", "lemma": lemma},
            "requires_confirmation": False,
        })
    elif len(selected) > 1 and end - start <= 160 and len(WORD.findall(text[start:end])) <= 6:
        out.append({
            "id": f"{utf16(text[:start])}:{utf16(text[:end])}",
            "kind": "phrase",
            "label": f"此短语：{text[start:end]}",
            "usage": scope_value(text, start, end, start, end),
            "requires_confirmation": False,
        })
    for lo, hi in _collocation_ranges(text, words, start, end):
        if (lo, hi) == (start, end):
            continue
        if hi - lo <= 160 and len(WORD.findall(text[lo:hi])) <= 6:
            out.append({
                "id": f"{utf16(text[:lo])}:{utf16(text[:hi])}",
                "kind": "collocation",
                "label": f"仅此搭配：{text[lo:hi]}",
                "usage": scope_value(text, start, end, lo, hi),
                "requires_confirmation": True,
            })
    return out


def selected_scope(store, snap, scope_id, lexicon=None):
    if scope_id == "pending":
        return None
    found = next((c for c in choices(store, snap, lexicon) if c["id"] == scope_id), None)
    if not found:
        raise HTTPException(409, "生效范围与当前原文不一致，请重新打开词卡")
    return found["usage"]


def valid_usage(value, quote):
    if not isinstance(value, dict):
        return False
    protocol = value.get("protocol")
    if protocol == "lexeme-v1":
        lemma = value.get("lemma")
        return (
            set(value) == {"protocol", "lemma"}
            and isinstance(lemma, str)
            and 0 < len(lemma) <= 96
            and lemma == normalize_query(lemma)
            and bool(WORD.fullmatch(lemma))
            and bool(WORD.fullmatch(quote))
        )
    if protocol != "literal-context-v1":
        return False
    pattern, start, end = value.get("pattern"), value.get("target_start"), value.get("target_end")
    return (isinstance(pattern, str) and 0 < len(pattern) <= 160 and
            type(start) is int and type(end) is int and 0 <= start < end <= len(pattern) and
            pattern[start:end] == quote and len(WORD.findall(pattern)) <= 6)


def _record_hit(hits, key, candidate):
    old = hits.get(key)
    if old and (old["preference_updated"], old["preference_id"]) > (
        candidate["preference_updated"], candidate["preference_id"]
    ):
        return
    hits[key] = candidate


def project(store, doc_id, local_feedback, lexicon=None):
    """Derive visible occurrence overlays; never create copied user records."""
    _, version, blocks = content(store, doc_id)
    rows = store.query("SELECT data,updated_at,id FROM wr_collection_feedback WHERE deleted=0 "
                       "AND json_extract(data,'$.annotation_preference') IS NOT NULL ORDER BY updated_at,id")
    prose_blocks = [
        b for b in blocks
        if not (b.get("asset_url") and b.get("type") in ASSET_BLOCK_TYPES)
    ]
    source_text_lower = "\n\n".join(b["text"] for b in prose_blocks).lower()
    lexeme_decls = {}
    literal_decls = {}
    for row in rows:
        value = json.loads(row["data"])
        usage = value.get("usage")
        if not valid_usage(usage, value["quote"]):
            continue
        entry = {**value, "preference_id": row["id"], "preference_updated": row["updated_at"]}
        if usage["protocol"] == "lexeme-v1":
            lexeme_decls[usage["lemma"]] = entry
        elif value["quote"].lower() in source_text_lower:
            key = (usage["pattern"].lower(), usage["target_start"], usage["target_end"])
            literal_decls[key] = entry

    hits = {}
    if lexeme_decls and (
        any(v.get("annotation_preference") != "auto" for v in lexeme_decls.values())
        or literal_decls
    ):
        block_words = []
        unique_words = set()
        for block in prose_blocks:
            matches = list(WORD.finditer(block["text"]))
            block_words.append((block, matches))
            for match in matches:
                unique_words.add(normalize_query(match.group()))
        if lexicon is not None and unique_words:
            lexicon.prefetch(unique_words)
        lemma_of = {w: lexeme_for(w, lexicon) for w in unique_words}
        for block, matches in block_words:
            text = block["text"]
            urls = url_ranges(text)
            for match in matches:
                lemma = lemma_of[normalize_query(match.group())]
                value = lexeme_decls.get(lemma)
                if not value:
                    continue
                start, end = match.start(), match.end()
                if overlaps_url(urls, start, end):
                    continue
                a, z = utf16(text[:start]), utf16(text[:end])
                _record_hit(
                    hits,
                    (block["id"], a, z),
                    {
                        **value,
                        "anchor": {
                            "version": version,
                            "block_id": block["id"],
                            "start": a,
                            "end": z,
                            "quote": text[start:end],
                            "segments": [],
                        },
                        "scope_id": f"lexeme:{lemma}",
                    },
                )

    for value in literal_decls.values():
        usage = value["usage"]
        pattern = re.compile(
            r"(?<![A-Za-z'’-])" + re.escape(usage["pattern"]) + r"(?![A-Za-z'’-])",
            re.IGNORECASE,
        )
        for block in prose_blocks:
            text = block["text"]
            urls = url_ranges(text)
            for match in pattern.finditer(text):
                start, end = match.start() + usage["target_start"], match.start() + usage["target_end"]
                if overlaps_url(urls, start, end):
                    continue
                a, z = utf16(text[:start]), utf16(text[:end])
                _record_hit(
                    hits,
                    (block["id"], a, z),
                    {
                        **value,
                        "anchor": {
                            "version": version,
                            "block_id": block["id"],
                            "start": a,
                            "end": z,
                            "quote": text[start:end],
                            "segments": [],
                        },
                        "scope_id": f"{utf16(text[:match.start()])}:{utf16(text[:match.end()])}",
                    },
                )

    # Pending (occurrence-only) feedback remains effective at the exact occurrence.
    for value in local_feedback:
        if value.get("annotation_preference") and not value.get("usage") and value["anchor"]["version"] == version:
            anchor = value["anchor"]
            _record_hit(
                hits,
                (anchor["block_id"], anchor["start"], anchor["end"]),
                {
                    **value,
                    "preference_id": value["id"],
                    "preference_updated": value["updated_at"],
                },
            )

    result = []
    for value in hits.values():
        action = value.get("annotation_preference")
        if action == "auto":
            continue
        result.append({
            **value,
            "understood": action == "known",
            "retained": action == "need" and bool(value.get("preference_note")),
            "note": value.get("preference_note", ""),
            "detail": "",
            "target": value["quote"],
            "usage_preference": True,
            "annotation_preference": action,
        })
    return result


def engine_preferences(store, doc_id, document, blocks, lexicon=None):
    from wise_reader.collections import item
    from wise_reader.models import Annotation, Kind
    from wise_reader.collections_source import exists
    if not exists(store, 'wr_collection_feedback') or not store.is_plugin_enabled('collections', True):
        return [], [], []
    local = [item(row) for row in store.query('SELECT * FROM wr_collection_feedback WHERE doc_id=? AND deleted=0', (doc_id,))]
    projected = project(store, doc_id, local, lexicon=lexicon)
    by_id = {b['id']: b for b in blocks}
    starts = {t.start: t.id for t in document.tokens}
    ends = {t.end: t.id for t in document.tokens}
    hidden_words, hidden_spans, forced = [], [], []
    for value in projected:
        anchor = value['anchor']
        block = by_id.get(anchor['block_id'])
        if not block:
            continue
        start = block['start'] + index(block['text'], anchor['start'])
        end = block['start'] + index(block['text'], anchor['end'])
        usage = value.get('usage')
        is_lexeme = isinstance(usage, dict) and usage.get('protocol') == 'lexeme-v1'
        if value['annotation_preference'] == 'known':
            (hidden_words if is_lexeme else hidden_spans).append((start, end))
        elif value['annotation_preference'] == 'need' and value.get('note') and start in starts and end in ends:
            lemma = usage['lemma'] if is_lexeme else value['quote']
            forced.append(Annotation(first_token=starts[start], last_token=ends[end],
                kind=Kind.WORD if starts[start] == ends[end] else Kind.PHRASE,
                note=value['note'], surface=document.text[start:end], lemma=lemma,
                forced=True, source='usage-preference'))
    return hidden_words, hidden_spans, forced
