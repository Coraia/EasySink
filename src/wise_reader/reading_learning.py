"""Conservative assistance calibration and auditable first-exposure statistics.

Only explicit current declarations calibrate. Exposure is observed presentation,
not proof of reading/comprehension; silence is never a positive training label.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from dataclasses import replace

from fastapi import HTTPException

from wise_reader.collections_source import content, exists, index, packed, utf16
from wise_reader.tokenize import parse

ALGORITHM = "explicit-lexeme-map-v1"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def migrate(store):
    store.executescript("""
    CREATE TABLE IF NOT EXISTS wr_learning_visit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE,
      doc_id INTEGER NOT NULL, book_id INTEGER, version TEXT NOT NULL,
      dwell_ms INTEGER NOT NULL, at TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wr_learning_word (
      id INTEGER PRIMARY KEY AUTOINCREMENT, visit_id INTEGER NOT NULL,
      doc_id INTEGER NOT NULL, book_id INTEGER, version TEXT NOT NULL,
      block_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
      annotated INTEGER NOT NULL, automatic INTEGER NOT NULL, baseline INTEGER NOT NULL,
      vocab_size INTEGER NOT NULL, baseline_vocab_size INTEGER NOT NULL,
      UNIQUE(doc_id,version,block_id,start,end));
    CREATE INDEX IF NOT EXISTS wr_learning_word_scope ON wr_learning_word(book_id,doc_id,id);
    CREATE TABLE IF NOT EXISTS wr_learning_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, book_id INTEGER,
      feedback_id INTEGER NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL,
      read_words INTEGER NOT NULL, at TEXT NOT NULL, before_model TEXT NOT NULL,
      after_model TEXT NOT NULL, undo_token TEXT, retracted INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS wr_learning_feedback_scope ON wr_learning_feedback(book_id,doc_id,id);
    CREATE INDEX IF NOT EXISTS wr_learning_feedback_undo ON wr_learning_feedback(undo_token);
    """)


def estimate(store, lexicon, profile):
    base = max(500, min(50000, profile.vocab_size))
    result = {"algorithm": ALGORITHM, "baseline_vocab_size": base, "vocab_size": base,
              "sample_lexemes": 0, "known_evidence": 0, "need_evidence": 0,
              "basis": "仅明确反馈；同词条合计最多一个样本，不代表标准词汇量测定"}
    if not lexicon or not exists(store, "wr_collection_feedback") or not store.is_plugin_enabled("collections", True):
        return result
    stamp = store.query_one("SELECT updated_at,id FROM wr_collection_feedback WHERE deleted=0 AND json_extract(data,'$.annotation_preference') IS NOT NULL ORDER BY updated_at DESC,id DESC LIMIT 1")
    cache_key = (base, tuple(stamp.values()) if stamp else None)
    cached = getattr(store, "_learning_model_cache", None)
    if cached and cached[0] == cache_key:
        return dict(cached[1])
    rows = store.query("SELECT data FROM wr_collection_feedback WHERE deleted=0 "
                       "AND json_extract(data,'$.annotation_preference') IS NOT NULL ORDER BY updated_at,id")
    # Latest declaration per scope wins. A reset removes that scope's evidence.
    groups = {}
    for row in rows:
        value = json.loads(row["data"])
        usage = value.get("usage")
        scope = [value["quote"], usage] if usage else [value["doc_id"], value["anchor"]]
        groups[packed(scope)] = value
    lexemes = {}
    for value in groups.values():
        action, quote = value.get("annotation_preference"), value["quote"]
        if action not in {"known", "need"} or not re.fullmatch(r"[A-Za-z]+(?:['’-][A-Za-z]+)*", quote):
            continue
        lemma = lexicon.lemma(quote)
        entry = lexicon.lookup(lemma)
        if not entry or not 0 < entry.rank <= 100000:
            continue
        lexemes.setdefault(lemma, {"rank": entry.rank, "labels": []})["labels"].append(int(action == "known"))
    observations = [(math.log(v["rank"]), sum(v["labels"]) / len(v["labels"])) for v in lexemes.values()]
    # A regularized logistic threshold, not an unbounded increment/decrement.
    # Multiple senses of the same lexeme share unit weight rather than becoming
    # multiple independent vocabulary claims. Manual setting remains the prior.
    prior = math.log(base)
    theta = prior
    for _ in range(12):
        gradient, curvature = 12 * (theta - prior), 12.0
        for log_rank, label in observations:
            probability = 1 / (1 + math.exp(max(-30, min(30, log_rank - theta))))
            gradient += probability - label
            curvature += probability * (1 - probability)
        next_theta = max(math.log(500), min(math.log(50000), theta - gradient / curvature))
        if abs(next_theta - theta) < 1e-7:
            break
        theta = next_theta
    result.update(vocab_size=round(math.exp(theta)), sample_lexemes=len(observations),
                  known_evidence=sum(y for _, y in observations), need_evidence=sum(1-y for _, y in observations))
    store._learning_model_cache = (cache_key, dict(result))
    return result


def effective_profile(store, lexicon, profile):
    model = estimate(store, lexicon, profile)
    return replace(profile, vocab_size=model["vocab_size"]), model


def document_scope(store, doc_id):
    chapter = store.query_one("SELECT book_id FROM wr_chapter WHERE doc_id=? ORDER BY id LIMIT 1", (doc_id,))
    book_id = chapter["book_id"] if chapter else None
    if book_id is not None:
        rows = store.query("SELECT d.id,d.word_count FROM wr_chapter c JOIN document d ON d.id=c.doc_id WHERE c.book_id=? ORDER BY c.idx", (book_id,))
        title = store.query_one("SELECT title FROM wr_book WHERE id=?", (book_id,))["title"]
    else:
        row = store.get_document(doc_id)
        if not row:
            raise HTTPException(404, "原文不存在")
        rows, title = [row], row["title"]
    return book_id, rows, title


def scope_clause(book_id, doc_id):
    return ("book_id=?", (book_id,)) if book_id is not None else ("book_id IS NULL AND doc_id=?", (doc_id,))


def record_feedback(store, lexicon, saved, action, token, before):
    if not exists(store, "wr_learning_feedback"):
        return
    clause, args = scope_clause(saved.get("book_id"), saved["doc_id"])
    read_words = store.query_one("SELECT COUNT(*) AS n FROM wr_learning_word WHERE " + clause, args)["n"]
    after = estimate(store, lexicon, store.get_profile())
    store.execute("INSERT INTO wr_learning_feedback(doc_id,book_id,feedback_id,revision,action,read_words,at,before_model,after_model,undo_token) VALUES(?,?,?,?,?,?,?,?,?,?)",
                  (saved["doc_id"], saved.get("book_id"), saved["id"], saved["revision"], action, read_words, now(), packed(before), packed(after), token))


def retract_feedback(store, token):
    if exists(store, "wr_learning_feedback"):
        store.execute("UPDATE wr_learning_feedback SET retracted=1 WHERE undo_token=?", (token,))


def capture(store, body):
    """Store only source-verified, first-presented words; repeated visits dedupe."""
    doc, version, blocks = content(store, body.doc_id, body.version)
    if version != body.version:
        raise HTTPException(409, "展示版本已改变，请重新打开正文")
    book_id, _, _ = document_scope(store, body.doc_id)
    by_id = {b["id"]: b for b in blocks}
    ranges = []
    for value in body.ranges:
        block = by_id.get(value.block_id)
        if not block or (block.get("asset_url") and block.get("type") in {"image", "image_fallback", "formula", "table"}):
            raise HTTPException(422, "展示范围不是可核对的文字正文")
        lo, hi = index(block["text"], value.start), index(block["text"], value.end)
        if hi <= lo:
            raise HTTPException(422, "展示范围为空")
        ranges.append((block, lo, hi))
    if sum(hi-lo for _,lo,hi in ranges) > 30000:
        raise HTTPException(413, "单次展示范围过大")
    def annotations(values):
        output = {}
        for value in values:
            block = by_id.get(value.block_id)
            if not block:
                raise HTTPException(422, "词注不属于展示正文")
            lo, hi = index(block["text"], value.start), index(block["text"], value.end)
            if hi <= lo:
                raise HTTPException(422, "词注范围为空")
            output.setdefault(value.block_id, []).append((lo, hi, getattr(value, "automatic", True)))
        return output
    shown, baseline = annotations(body.annotations), annotations(body.baseline_annotations)
    model = body.model.model_dump()
    tokens_by_block = {block["id"]: parse(block["text"]).tokens for block, _, _ in ranges}
    with store.transaction():
        existing = store.query_one("SELECT id FROM wr_learning_visit WHERE uid=?", (body.visit_id,))
        if existing:
            return {"ok": True, "new_words": 0, "duplicate_visit": True}
        visit = store.execute("INSERT INTO wr_learning_visit(uid,doc_id,book_id,version,dwell_ms,at,snapshot) VALUES(?,?,?,?,?,?,?)",
                              (body.visit_id, body.doc_id, book_id, body.version, body.dwell_ms, now(), packed(body.model_dump(mode="json")))).lastrowid
        count = 0
        for block, lo, hi in ranges:
            for token in tokens_by_block[block["id"]]:
                if token.start < lo or token.end > hi:
                    continue
                # A phrase counts as one annotation at its first source word.
                hits = [a for a in shown.get(block["id"], []) if token.start <= a[0] < token.end]
                base = any(token.start <= a[0] < token.end for a in baseline.get(block["id"], []))
                row = store.execute("INSERT OR IGNORE INTO wr_learning_word(visit_id,doc_id,book_id,version,block_id,start,end,annotated,automatic,baseline,vocab_size,baseline_vocab_size) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (visit, body.doc_id, book_id, body.version, block["id"], utf16(block["text"][:token.start]), utf16(block["text"][:token.end]),
                     int(bool(hits)), int(any(a[2] for a in hits)), int(base), model["vocab_size"], model["baseline_vocab_size"]))
                count += row.rowcount
        return {"ok": True, "new_words": count, "visit_id": visit}


def summary(store, lexicon, doc_id, bucket_words=500, offset=0):
    book_id, docs, title = document_scope(store, doc_id)
    clause, args = scope_clause(book_id, doc_id)
    totals = store.query_one("SELECT COUNT(*) AS words,COALESCE(SUM(annotated),0) AS annotations,COALESCE(SUM(automatic),0) AS automatic,COALESCE(SUM(baseline),0) AS baseline FROM wr_learning_word WHERE " + clause, args)
    groups = store.query("WITH ordered AS (SELECT *,ROW_NUMBER() OVER(ORDER BY id)-1 AS ordinal FROM wr_learning_word WHERE " + clause + ") "
        "SELECT CAST(ordinal / ? AS INTEGER) AS bucket,COUNT(*) AS words,SUM(annotated) AS annotations,SUM(automatic) AS automatic,SUM(baseline) AS baseline,ROUND(AVG(vocab_size)) AS mean_vocab_size,MIN(id) AS first_exposure,MAX(id) AS last_exposure FROM ordered GROUP BY bucket ORDER BY bucket LIMIT 40 OFFSET ?", (*args, bucket_words, offset))
    feedback = store.query("SELECT id,action,read_words,at,before_model,after_model FROM wr_learning_feedback WHERE " + clause + " AND retracted=0 ORDER BY id", args)
    for row in groups:
        start = row["bucket"] * bucket_words
        end = start + row["words"]
        # Attribute behavior to the amount presented when the action occurred,
        # not the physical page/anchor where the feedback points.
        events = [f for f in feedback if f["read_words"] > 0 and max(0, f["read_words"] - 1) // bucket_words == row["bucket"]]
        row.update(start_word=start + 1, end_word=end,
                   plus=sum(f["action"] == "need" for f in events), minus=sum(f["action"] == "known" for f in events),
                   corrections=sum(f["action"] in {"known", "need"} for f in events))
        for name in ("annotations", "automatic", "baseline", "corrections"):
            row[name + "_per_100"] = round(100 * row[name] / max(1, row["words"]), 2)
    current_words = 0
    for d in docs:
        _, current_version, _ = content(store, d["id"])
        current_words += store.query_one("SELECT COUNT(*) AS n FROM wr_learning_word WHERE doc_id=? AND version=?", (d["id"], current_version))["n"]
    available = sum(d["word_count"] for d in docs)
    early_cutoff = math.ceil(available * .2)
    milestones = []
    for percent in (20, 30):
        threshold = math.ceil(available * percent / 100)
        milestones.append({"percent": percent, "threshold_words": threshold, "reached": current_words >= threshold and available > 0})
    early = [f for f in feedback if 0 < f["read_words"] <= early_cutoff and f["action"] in {"need", "known"}]
    later = [f for f in feedback if f["read_words"] > early_cutoff and f["action"] in {"need", "known"}]
    first_presentations = store.query("SELECT v.doc_id,v.version,v.at,v.dwell_ms,d.title,MIN(w.id) AS first_word,COUNT(w.id) AS new_words,json_extract(v.snapshot,'$.trigger') AS trigger FROM wr_learning_visit v JOIN wr_learning_word w ON w.visit_id=v.id JOIN document d ON d.id=v.doc_id WHERE " + clause.replace('book_id','w.book_id').replace('doc_id','w.doc_id') + " GROUP BY v.id ORDER BY first_word LIMIT 8", args)
    return {"title": title, "book_id": book_id, "doc_id": doc_id, "model": estimate(store, lexicon, store.get_profile()),
            "totals": totals, "available_words": available, "current_version_words": current_words,
            "coverage_percent": round(100 * current_words / max(1, available), 2), "coverage_basis": "当前可读原文，不把未就绪部分当作已读",
            "bucket_words": bucket_words, "offset": offset, "total_buckets": math.ceil(totals["words"] / bucket_words),
            "buckets": groups, "milestones": milestones, "first_presentations": first_presentations,
            "historical_version_words": max(0, totals["words"]-current_words),
            "comparison": {"comparable": totals["words"] == current_words, "cutoff_percent": 20, "early_words": min(totals["words"], early_cutoff), "later_words": max(0, totals["words"]-early_cutoff), "early_corrections": len(early), "later_corrections": len(later)},
            "unattributed_feedback": sum(f["read_words"] == 0 for f in feedback),
            "feedback_events": [{**f, "before_model": json.loads(f["before_model"]), "after_model": json.loads(f["after_model"])} for f in feedback],
            "limitations": ["按稳定展示或主动反馈的先后记录，不代表已经阅读或理解；重读不重复增加新词分母。", "无反馈仍为未知，纠偏频率不等同准确率或因果证明。", "采集启用前的展示顺序没有回填；不同原文版本保留独立历史；版本变化后不把历史词次冒充当前版本覆盖。"]}
