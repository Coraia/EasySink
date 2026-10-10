"""Bounded source context and durable receipts for explicit context explanations."""

from __future__ import annotations

import hashlib
import json
from bisect import bisect_left, bisect_right

from fastapi import HTTPException

PROTOCOL = "context-meaning-v7"
LIMIT = 6000


def units(text):
    return len(text.encode("utf-16-le")) // 2


def text_block(block):
    return bool(block.get("text", "").strip()) and not (
        block.get("asset_url") and block.get("type") in {"image", "image_fallback", "formula", "table"}
    )


def window(text, budget, start, end):
    """A source window centered on a selection, never splitting a UTF-16 pair."""
    offsets = [0]
    for char in text:
        offsets.append(offsets[-1] + units(char))
    total = offsets[-1]
    left = max(0, min(total - budget, (start + end - budget) // 2))
    a = bisect_left(offsets, left)
    b = bisect_right(offsets, offsets[a] + budget) - 1
    return offsets[a], offsets[b], text[a:b]


def selection_occurrences(ranges, parts):
    """Disambiguate the actual occurrence using only the approved context.

    Numeric offsets alone are easy for a language model to misread when the
    same spelling occurs twice. These short source fragments preserve the
    selected grammatical form without adding any neighboring source scope.
    """
    current = {r["block_id"]: r for r in ranges if r["role"] == "current"}
    result = []
    for part in parts:
        entry = current.get(part.block_id)
        if not entry:
            continue
        start, end = max(part.start, entry["start"]), min(part.end, entry["end"])
        if start >= end:
            continue
        raw = entry["text"].encode("utf-16-le")
        a, b = (start - entry["start"]) * 2, (end - entry["start"]) * 2
        before, after = raw[:a].decode("utf-16-le"), raw[b:].decode("utf-16-le")
        result.append({"block_id": part.block_id,
                       "before": window(before, 80, units(before), units(before))[2],
                       "selected": raw[a:b].decode("utf-16-le"),
                       "after": window(after, 80, 0, 0)[2],
                       "selection_truncated": start != part.start or end != part.end})
    return result


def build_context(blocks, target, previous=False, following=False):
    """Only selected paragraphs plus explicitly requested immediate neighbors.

    The separate selected source retains the existing 8000-unit limit. A larger
    selection is not shortened to fit the *context* budget; this is reported.
    """
    parts = target.segments or [target]
    indexes = {block["id"]: i for i, block in enumerate(blocks)}
    first, last = indexes[parts[0].block_id], indexes[parts[-1].block_id]
    current = blocks[first:last + 1]
    joined = "\n\n".join(block["text"] for block in current)
    end = units(joined) - units(current[-1]["text"]) + parts[-1].end
    candidates = {
        "previous": blocks[first - 1] if first > 0 and text_block(blocks[first - 1]) else None,
        "next": blocks[last + 1] if last + 1 < len(blocks) and text_block(blocks[last + 1]) else None,
    }
    wanted = [(role, candidates[role]) for role, use in (("previous", previous), ("next", following))
              if use and candidates[role] is not None]
    # When a neighbor is explicitly needed, a long current paragraph must not
    # swallow the entire allowance. Reserve up to 1000 units per neighbor while
    # keeping the selected span intact whenever it fits the overall budget.
    spare = max(0, LIMIT - (end - parts[0].start))
    reserve = min(spare, sum(min(1000, units(block["text"])) + 2 for _, block in wanted))
    start, stop, _ = window(joined, LIMIT - reserve, parts[0].start, end)
    ranges, omitted = [], []
    cursor = 0
    for block in current:
        size = units(block["text"])
        a, b = max(0, start - cursor), min(size, stop - cursor)
        if a < b:
            ranges.append({"block_id": block["id"], "role": "current", "start": a, "end": b,
                           "text": block["text"].encode("utf-16-le")[a * 2:b * 2].decode("utf-16-le"),
                           "source_utf16_length": size, "truncated": a != 0 or b != size})
        else:
            omitted.append({"block_id": block["id"], "role": "current", "reason": "context_limit"})
        cursor += size + 2
    remaining = LIMIT - units("\n\n".join(r["text"] for r in ranges))
    # Reserve separators, divide fairly, then give unused space to the other
    # neighbor. The selected source span has first claim on the budget.
    budget = max(0, remaining - 2 * len(wanted))
    allocations = {role: min(units(block["text"]), budget // len(wanted)) for role, block in wanted}
    extra = budget - sum(allocations.values())
    for role, block in wanted:
        gain = min(extra, units(block["text"]) - allocations[role])
        allocations[role] += gain
        extra -= gain
    for role, block in wanted:
        size = units(block["text"])
        point = size if role == "previous" else 0
        a, b, text = window(block["text"], allocations[role], point, point)
        if not text:
            omitted.append({"block_id": block["id"], "role": role, "reason": "context_limit"})
            continue
        entry = {"block_id": block["id"], "role": role, "start": a, "end": b, "text": text,
                 "source_utf16_length": size, "truncated": a != 0 or b != size}
        if role == "previous":
            ranges.insert(0, entry)
        else:
            ranges.append(entry)
    text = "\n\n".join(r["text"] for r in ranges)
    return {"protocol": PROTOCOL, "text": text, "utf16_length": units(text), "limit_utf16": LIMIT,
            "ranges": ranges, "omitted": omitted,
            "selected_occurrences": selection_occurrences(ranges, parts),
            "truncated": bool(omitted) or any(r["truncated"] for r in ranges),
            "selection_context_truncated": start > parts[0].start or stop < end,
            "requested_neighbors": {"previous": previous, "next": following},
            "available_neighbors": {role: block is not None for role, block in candidates.items()}}


def cache_identity(doc_id, target, source, context):
    value = [PROTOCOL, doc_id, target.version, source,
             [[s.block_id, s.start, s.end] for s in (target.segments or [target])],
             [[r["block_id"], r["start"], r["end"], r["text"]] for r in context["ranges"]]]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def migrate(store):
    store.executescript("""
    CREATE TABLE IF NOT EXISTS wr_context_attempt (
      id TEXT PRIMARY KEY, doc_id INTEGER NOT NULL, cache_key TEXT NOT NULL,
      request_id TEXT NOT NULL, regenerate INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, assist_id INTEGER, request TEXT NOT NULL,
      provider TEXT NOT NULL, response TEXT, error TEXT NOT NULL DEFAULT '',
      http_status INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(doc_id, request_id));
    CREATE INDEX IF NOT EXISTS wr_context_cache ON wr_context_attempt(cache_key, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS wr_context_pending ON wr_context_attempt(cache_key) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS wr_assist_source ON wr_assist(doc_id, version, kind);
    """)
    # A receipt is committed before transport. A process restart must not infer
    # that an absent response means the provider did not execute the request.
    store.execute("UPDATE wr_context_attempt SET state='unknown',error=?,http_status=409 WHERE state='pending'",
                  ("服务曾中断，无法确认上次解释结果。不会自动重发；重新解释可能再次计费。",))


def cached(store, identity):
    return store.query_one("""SELECT a.* FROM wr_assist a JOIN wr_context_attempt c ON c.assist_id=a.id
        WHERE c.cache_key=? AND c.state='succeeded' ORDER BY a.id DESC LIMIT 1""", (identity,))


def latest_attempt(store, identity):
    return store.query_one("SELECT * FROM wr_context_attempt WHERE cache_key=? ORDER BY rowid DESC LIMIT 1", (identity,))


def public_attempt(row):
    if not row:
        return None
    return {key: row[key] for key in ("id", "state", "assist_id", "error", "http_status", "created_at")}


def guard_error(row):
    state = row["state"]
    message = row["error"] or ("这处解释仍在处理中，请稍后查看。" if state == "pending" else
                               "上次解释没有可用结果。不会自动重发；可明确重新解释，可能再次计费。")
    return HTTPException(row["http_status"] or 409,
                         {"code": "context_" + state, "message": message, "attempt": public_attempt(row)})
