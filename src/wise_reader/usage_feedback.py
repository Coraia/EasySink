"""Explicit, source-verified expression scopes; never infer senses from glosses.

A literal collocation is a conservative reusable scope the reader can inspect
and correct. It is not a dictionary sense ID or an automatic WSD claim.
"""
from __future__ import annotations

import json
import re

from fastapi import HTTPException

from wise_reader.collections_source import content, index, utf16
from wise_reader.source_urls import overlaps_url, url_ranges

WORD = re.compile(r"[A-Za-z]+(?:['’-][A-Za-z]+)*")
STOP = set("a an the of in on at to for from by with and or but as is are was were be been being it its this that these those he she they we i you his her their our my your not no can could may might will would shall should do does did have has had".split())


def scope_value(text, start, end, lo, hi):
    pattern = text[lo:hi]
    return {"protocol": "literal-context-v1", "pattern": pattern,
            "target_start": start - lo, "target_end": end - lo}


def choices(store, snap):
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
    ranges = []
    if len(selected) > 1:
        ranges.append((start, end))
    following = next((w for w in words if w.start() >= end), None)
    previous = next((w for w in reversed(words) if w.end() <= start), None)
    if following and text[end:following.start()].isspace() and following.group().lower() not in STOP:
        ranges.append((start, following.end()))
    if previous and text[previous.end():start].isspace() and previous.group().lower() not in STOP:
        ranges.append((previous.start(), end))
    immediate = set(ranges)
    # Offer longer literal context for the reader to confirm (for example
    # "dogmatic or systematic theology"). These are source ranges, not a
    # guessed sense or a default expansion across conjunctions.
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
    return [{"id": f"{utf16(text[:lo])}:{utf16(text[:hi])}",
             "usage": scope_value(text, start, end, lo, hi),
             "requires_confirmation": (lo, hi) not in immediate} for lo, hi in ranges
            if hi - lo <= 160 and len(WORD.findall(text[lo:hi])) <= 6]


def selected_scope(store, snap, scope_id):
    if scope_id == "pending":
        return None
    found = next((c for c in choices(store, snap) if c["id"] == scope_id), None)
    if not found:
        raise HTTPException(409, "适用表达与当前原文不一致，请重新打开词卡")
    return found["usage"]


def valid_usage(value, quote):
    if not isinstance(value, dict) or value.get("protocol") != "literal-context-v1":
        return False
    pattern, start, end = value.get("pattern"), value.get("target_start"), value.get("target_end")
    return (isinstance(pattern, str) and 0 < len(pattern) <= 160 and
            type(start) is int and type(end) is int and 0 <= start < end <= len(pattern) and
            pattern[start:end] == quote and len(WORD.findall(pattern)) <= 6)


def project(store, doc_id, local_feedback):
    """Derive visible occurrence overlays; never create copied user records."""
    _, version, blocks = content(store, doc_id)
    rows = store.query("SELECT data,updated_at,id FROM wr_collection_feedback WHERE deleted=0 "
                       "AND json_extract(data,'$.annotation_preference') IS NOT NULL ORDER BY updated_at,id")
    source_text = "\n\n".join(b["text"] for b in blocks)
    declarations = {}
    for row in rows:
        value = json.loads(row["data"])
        usage = value.get("usage")
        if value["quote"] not in source_text or not valid_usage(usage, value["quote"]):
            continue
        key = (usage["pattern"], usage["target_start"], usage["target_end"])
        declarations[key] = {**value, "preference_id": row["id"], "preference_updated": row["updated_at"]}
    hits = {}
    for value in declarations.values():
        usage = value["usage"]
        pattern = re.compile(r"(?<![A-Za-z'’-])" + re.escape(usage["pattern"]) + r"(?![A-Za-z'’-])")
        for block in blocks:
            if block.get("asset_url") and block.get("type") in {"image", "image_fallback", "formula", "table"}:
                continue
            text = block["text"]
            urls = url_ranges(text)
            for match in pattern.finditer(text):
                start, end = match.start() + usage["target_start"], match.start() + usage["target_end"]
                if overlaps_url(urls, start, end):
                    continue
                a, z = utf16(text[:start]), utf16(text[:end])
                key = (block["id"], a, z)
                old = hits.get(key)
                if old and (old["preference_updated"], old["preference_id"]) > (value["preference_updated"], value["preference_id"]):
                    continue
                hits[key] = {**value, "anchor": {"version": version, "block_id": block["id"], "start": a, "end": z, "quote": text[start:end], "segments": []},
                             "scope_id": f"{utf16(text[:match.start()])}:{utf16(text[:match.end()])}"}
    # Pending feedback remains effective at the exact occurrence. Old mastery
    # declarations never become cross-book preferences just because they exist.
    for value in local_feedback:
        if value.get("annotation_preference") and not value.get("usage") and value["anchor"]["version"] == version:
            anchor = value["anchor"]
            hits[(anchor["block_id"], anchor["start"], anchor["end"])] = value
    result = []
    for value in hits.values():
        action = value.get("annotation_preference")
        result.append({**value, "understood": action == "known", "retained": action == "need" and bool(value.get("preference_note")),
                       "note": value.get("preference_note", ""), "detail": "", "target": value["quote"],
                       "usage_preference": True, "annotation_preference": action})
    return result


def engine_preferences(store, doc_id, document, blocks):
    from wise_reader.collections import item
    from wise_reader.models import Annotation, Kind
    from wise_reader.collections_source import exists
    if not exists(store, 'wr_collection_feedback') or not store.is_plugin_enabled('collections', True):
        return [], []
    local = [item(row) for row in store.query('SELECT * FROM wr_collection_feedback WHERE doc_id=? AND deleted=0', (doc_id,))]
    projected = project(store, doc_id, local)
    by_id = {b['id']: b for b in blocks}
    starts = {t.start: t.id for t in document.tokens}
    ends = {t.end: t.id for t in document.tokens}
    hidden, forced = [], []
    for value in projected:
        anchor = value['anchor']
        block = by_id.get(anchor['block_id'])
        if not block:
            continue
        start = block['start'] + index(block['text'], anchor['start'])
        end = block['start'] + index(block['text'], anchor['end'])
        if value['annotation_preference'] == 'known':
            hidden.append((start, end))
        elif value['annotation_preference'] == 'need' and value.get('note') and start in starts and end in ends:
            forced.append(Annotation(first_token=starts[start], last_token=ends[end],
                kind=Kind.WORD if starts[start] == ends[end] else Kind.PHRASE,
                note=value['note'], surface=document.text[start:end], lemma=value['quote'],
                forced=True, source='usage-preference'))
    return hidden, forced
