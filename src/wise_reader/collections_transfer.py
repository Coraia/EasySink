"""Versioned, bounded collection portability and explicitly scoped cleanup."""
from __future__ import annotations

import json
import re

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError

from wise_reader.collections import MAX_ROWS, TABLES, item, key, now
from wise_reader.collections_source import anchor_key, digest, exists, index, packed, resolve, resolve_document, utf16, validate
from wise_reader.content import Anchor, save_anchor

MAX_BYTES = 8 * 1024 * 1024
# The downloadable JSON/data budget excludes the HTTP {"data": ...} envelope.
# Keep a bounded allowance for that envelope; validate_import still caps data.
MAX_REQUEST_BYTES = MAX_BYTES + 1024
SCHEMA = "wise-reader-collections"


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="ignore")
    uid: str = Field(min_length=1, max_length=160)
    kind: str = Field(pattern=r"^(word|excerpt|feedback|note)$")
    anchor: Anchor | None = None
    quote: str = Field(default="", max_length=10000)
    context: str = Field(default="", max_length=10000)
    title: str = Field(default="", max_length=2000)
    book_title: str = Field(default="", max_length=2000)
    source_identity: dict
    explanation: dict | None = None
    explanation_history: list[dict] = Field(default_factory=list, max_length=MAX_ROWS)
    subranges: list[dict] = Field(default_factory=list, max_length=MAX_ROWS)
    my_meaning: str = Field(default="", max_length=20000)
    body: str = Field(default="", max_length=100000)
    understood: StrictBool | None = None
    retained: StrictBool = False
    note: str = Field(default="", max_length=12000)
    detail: str = Field(default="", max_length=12000)
    target: str = Field(default="", max_length=1000)
    created_at: str = Field(default="", max_length=80)


def checked_rows(store, sql, params=()):
    rows = store.query(sql + " LIMIT ?", (*params, MAX_ROWS + 1))
    if len(rows) > MAX_ROWS:
        raise HTTPException(413, "记录超过 2000 条，请按书或选定记录分批处理")
    return rows


def selected_collections(service, scope, *, deleted=False):
    clauses, params = ([] if deleted else ["deleted=0"]), []
    if scope.get("book_id") is not None:
        clauses.append("book_id=?")
        params.append(scope["book_id"])
    if scope.get("ids") is not None:
        if not scope["ids"]:
            return []
        clauses.append("id IN (" + ",".join("?" for _ in scope["ids"]) + ")")
        params.extend(scope["ids"])
    return checked_rows(service.store, "SELECT * FROM wr_collection" + (" WHERE " + " AND ".join(clauses) if clauses else "") + " ORDER BY id", tuple(params))


def contains(parent, doc_id, anchor, source=None):
    if not anchor or parent["doc_id"] != doc_id:
        return False
    data = json.loads(parent["data"])
    if doc_id is None and data["source_identity"] != source:
        return False
    saved = data["anchor"]
    if not anchor.get("version") or saved["version"] != anchor["version"]:
        return False
    ranges = {p["block_id"]: (p["start"], p["end"]) for p in saved.get("segments") or [saved]}
    return all(p["block_id"] in ranges and ranges[p["block_id"]][0] <= p["start"] < p["end"] <= ranges[p["block_id"]][1] for p in anchor.get("segments") or [anchor])


def scoped_feedback(service, scope, selections, *, deleted=False):
    conditions, params = ([] if deleted else ["deleted=0"]), []
    if scope.get("book_id") is not None:
        conditions.append("book_id=?")
        params.append(scope["book_id"])
    if scope.get("ids") is not None:
        ids = list({r["doc_id"] for r in selections if r["doc_id"] is not None})
        sources = list({packed(json.loads(r["data"])["source_identity"]) for r in selections if r["doc_id"] is None})
        if not ids and not sources:
            return []
        alternatives = []
        if ids:
            alternatives.append("doc_id IN (" + ",".join("?" for _ in ids) + ")")
            params.extend(ids)
        if sources:
            alternatives.append("(doc_id IS NULL AND json_extract(data,'$.source_identity') IN (" + ",".join("?" for _ in sources) + "))")
            params.extend(sources)
        conditions.append("(" + " OR ".join(alternatives) + ")")
    rows = checked_rows(service.store, "SELECT * FROM wr_collection_feedback WHERE " + (" AND ".join(conditions) or "1=1") + " ORDER BY id", tuple(params))
    if scope.get("ids") is not None:
        rows = [r for r in rows if any(contains(s, r["doc_id"], json.loads(r["data"])["anchor"], json.loads(r["data"])["source_identity"]) for s in selections)]
    return rows


def scoped_notes(service, scope, selections):
    if not exists(service.store, "wr_note"):
        return []
    conditions, params = [], []
    if scope.get("book_id") is not None:
        conditions.append("EXISTS(SELECT 1 FROM wr_chapter c WHERE c.doc_id=n.doc_id AND c.book_id=?)")
        params.append(scope["book_id"])
    if scope.get("ids") is not None:
        ids = list({r["doc_id"] for r in selections if r["doc_id"] is not None})
        if not ids:
            return []
        conditions.append("n.doc_id IN (" + ",".join("?" for _ in ids) + ")")
        params.extend(ids)
    rows = checked_rows(service.store, "SELECT n.*,a.payload AS anchor_json FROM wr_note n LEFT JOIN wr_anchor a ON a.owner='note' AND a.owner_id=n.id" + (" WHERE " + " AND ".join(conditions) if conditions else "") + " ORDER BY n.id", tuple(params))
    if scope.get("ids") is not None:
        rows = [r for r in rows if any(contains(s, r["doc_id"], json.loads(r["anchor_json"]) if r["anchor_json"] else None) for s in selections)]
    return rows


def scoped_orphan_notes(service, scope, selections):
    missing = "note_id IS NULL OR NOT EXISTS(SELECT 1 FROM wr_note n WHERE n.id=wr_collection_note_import.note_id)" if exists(service.store, "wr_note") else "1=1"
    sql, params = "SELECT * FROM wr_collection_note_import WHERE (" + missing + ")", []
    if scope.get("book_id") is not None:
        sql += " AND book_id=?"
        params.append(scope["book_id"])
    if scope.get("ids") is not None:
        sources = list({packed(json.loads(r["data"])["source_identity"]) for r in selections})
        if not sources:
            return []
        sql += " AND json_extract(data,'$.source_identity') IN (" + ",".join("?" for _ in sources) + ")"
        params.extend(sources)
    rows = checked_rows(service.store, sql, tuple(params))
    if scope.get("ids") is not None:
        rows = [r for r in rows if any(contains(s, None, json.loads(r["data"]).get("anchor"), json.loads(r["data"])["source_identity"]) for s in selections)]
    return rows


def note_snapshot(service, row):
    anchor = json.loads(row["anchor_json"]) if row["anchor_json"] else None
    snapshot = None
    if anchor and anchor.get("kind", "text") == "text":
        try:
            snapshot = validate(service.store, row["doc_id"], Anchor.model_validate(anchor))
        except (HTTPException, ValueError):
            pass
    if snapshot is None:
        from wise_reader.collections_source import content, identity
        try:
            doc, version, _ = content(service.store, row["doc_id"])
            source, book_id = identity(service.store, doc, version)
        except HTTPException:
            doc, source, book_id = {"title": "原文不可用"}, {"schema": 1, "unavailable": True}, None
        snapshot = {"doc_id": row["doc_id"], "book_id": book_id, "title": doc["title"],
                    "book_title": source.get("book_title", ""), "source_identity": source,
                    "anchor": anchor, "quote": row["quote"], "context": ""}
    prior = service.store.query_one("SELECT uid FROM wr_collection_note_import WHERE note_id=?", (row["id"],))
    # Legacy IDs are only salted identity material, never import binding targets.
    uid = prior["uid"] if prior else digest(["note", snapshot["source_identity"], row["id"], row["created_at"], row["quote"]])
    return {**snapshot, "uid": uid, "kind": "note", "body": row["body"], "created_at": row["created_at"]}


def export_data(service, scope):
    with service.store.transaction():
        selections = selected_collections(service, scope) if scope.get("collections") or scope.get("ids") is not None else []
        collections = [item(r) for r in selections] if scope.get("collections") else []
        feedback = [item(r) for r in scoped_feedback(service, scope, selections)] if scope.get("feedback") else []
        notes = [note_snapshot(service, r) for r in scoped_notes(service, scope, selections)] if scope.get("notes") else []
        if scope.get("notes"):
            notes.extend(json.loads(r["data"]) for r in scoped_orphan_notes(service, scope, selections))
        data = {"schema": SCHEMA, "version": 1, "exported_at": now(), "collections": collections, "notes": notes, "feedback": feedback}
        if sum(len(data[k]) for k in TABLES) + len(notes) > MAX_ROWS or len(packed(data).encode()) > MAX_BYTES:
            raise HTTPException(413, "导出超过上限，请按书或选定记录分批导出")
        return data


def markdown(data):
    def escape(text):
        # Source text remains readable without creating active HTML or links.
        return re.sub(r"([\\`*_{}\[\]()#+.!|>~-])", r"\\\1", str(text)).replace("<", "&lt;").replace(">", "&gt;")
    lines = ["# Wise Reader · 阅读资料", "", "导出时间：" + data["exported_at"], ""]
    for category, label in (("collections", "词句收藏"), ("notes", "笔记"), ("feedback", "语境反馈")):
        for entry in data[category]:
            lines.extend(["## " + label + " · " + escape(entry.get("title", "")), "", "来源：" + escape(entry.get("book_title", "") or entry.get("title", "")), ""])
            lines.extend("> " + escape(line) for line in entry.get("quote", "").splitlines())
            lines.extend(["", "语境：", "", escape(entry.get("context", "")), ""])
            if entry.get("my_meaning"):
                lines.extend(["我的释义：" + escape(entry["my_meaning"]), ""])
            if entry.get("explanation"):
                e = entry["explanation"]
                lines.extend(["解释（" + escape(e.get("source", "")) + "）：" + escape(e.get("text", "")), ""])
            for e in entry.get("explanation_history", []):
                lines.extend(["此前解释（" + escape(e.get("source", "")) + "）：" + escape(e.get("text", "")), ""])
            for sub in entry.get("subranges", []):
                if not (sub.get("my_meaning") or sub.get("explanation") or sub.get("explanation_history")):
                    continue
                lines.extend(["子范围：" + escape(sub.get("quote", "")), "", "我的释义：" + escape(sub.get("my_meaning", "")), ""])
                for e in ([sub["explanation"]] if sub.get("explanation") else []) + sub.get("explanation_history", []):
                    lines.extend(["子范围解释（" + escape(e.get("source", "")) + "）：" + escape(e.get("text", "")), ""])
            if category == "notes":
                lines.extend([escape(entry["body"]), ""])
            if category == "feedback":
                lines.extend(["已懂这里：" + str(entry.get("understood")), "保留注释：" + str(entry.get("retained")), escape(entry.get("note", "")), escape(entry.get("detail", "")), ""])
            lines.extend(["来源身份：`" + packed(entry["source_identity"]).replace("`", "\\u0060") + "`", ""])
    return "\n".join(lines)


def validate_import(data):
    if not isinstance(data, dict) or data.get("schema") != SCHEMA or type(data.get("version")) is not int or data["version"] != 1:
        raise HTTPException(422, "不支持的收藏导出格式")
    stack = [(data, 0)]
    while stack:
        value, depth = stack.pop()
        if depth > 24:
            raise HTTPException(422, "导入嵌套过深")
        if isinstance(value, dict):
            stack.extend((v, depth + 1) for v in value.values())
        elif isinstance(value, list):
            stack.extend((v, depth + 1) for v in value)
    if len(packed(data).encode()) > MAX_BYTES:
        raise HTTPException(413, "导入文件超过 8 MiB")
    output, count = {}, 0
    for category in ("collections", "notes", "feedback"):
        records = data.get(category, [])
        if not isinstance(records, list):
            raise HTTPException(422, "导入记录须为列表")
        count += len(records)
        if count > MAX_ROWS:
            raise HTTPException(413, "单次导入最多 2000 条记录")
        output[category] = []
        for raw in records:
            try:
                parsed = Snapshot.model_validate(raw)
            except (ValidationError, ValueError, TypeError) as exc:
                raise HTTPException(422, "导入记录结构无效") from exc
            if (category == "collections" and parsed.kind not in {"word", "excerpt"}) or (category != "collections" and parsed.kind != category.rstrip("s")):
                raise HTTPException(422, "记录种类与分组不一致")
            if category != "notes" and (not parsed.anchor or parsed.anchor.kind != "text" or parsed.quote != parsed.anchor.quote or not parsed.quote.strip()):
                raise HTTPException(422, "收藏或反馈缺少有效文字快照")
            if category == "notes" and not parsed.body.strip():
                raise HTTPException(422, "导入笔记不能为空")
            if category != "notes":
                parts = parsed.anchor.segments or [parsed.anchor]
                try:
                    valid = all(p.kind == "text" and p.end > p.start and utf16(p.quote) == p.end - p.start for p in parts)
                except UnicodeError:
                    valid = False
                if not valid or "\n\n".join(p.quote for p in parts) != parsed.quote:
                    raise HTTPException(422, "导入选区范围与文字快照不一致")
                if parsed.anchor.segments and (len(parts) < 2 or any(getattr(parsed.anchor, k) != getattr(parts[0], k) for k in ("block_id", "start", "end"))):
                    raise HTTPException(422, "导入选区起点不一致")
                if parsed.source_identity.get("version") != parsed.anchor.version:
                    raise HTTPException(422, "导入来源版本不一致")
            source = parsed.source_identity
            allowed = {"schema", "version", "text_sha256", "text_lookup_hash", "document_title", "book_title", "book_author", "chapter_index", "source_kind", "fingerprint", "unavailable"}
            if set(source) - allowed or len(packed(source)) > 10000:
                raise HTTPException(422, "来源身份结构无效")
            for field in ("version", "text_sha256", "text_lookup_hash", "fingerprint", "document_title", "book_title", "book_author", "source_kind"):
                if field in source and (not isinstance(source[field], str) or len(source[field]) > 2000):
                    raise HTTPException(422, "来源身份字段无效")
            if source.get("chapter_index") is not None and type(source["chapter_index"]) is not int:
                raise HTTPException(422, "章节身份无效")
            value = parsed.model_dump(mode="json")
            for sub in value["subranges"]:
                try:
                    sub_anchor = Anchor.model_validate(sub["anchor"])
                    if sub_anchor.version != parsed.anchor.version or sub_anchor.quote != sub["quote"]:
                        raise ValueError("subrange")
                    if not isinstance(sub.get("my_meaning", ""), str) or len(sub.get("my_meaning", "")) > 20000:
                        raise ValueError("meaning")
                    parents = {p.block_id: p for p in parsed.anchor.segments or [parsed.anchor]}
                    quotes = []
                    for part in sub_anchor.segments or [sub_anchor]:
                        parent = parents.get(part.block_id)
                        if not parent or not parent.start <= part.start < part.end <= parent.end:
                            raise ValueError("outside parent")
                        lo, hi = index(parent.quote, part.start - parent.start), index(parent.quote, part.end - parent.start)
                        quotes.append(parent.quote[lo:hi])
                    if "\n\n".join(quotes) != sub_anchor.quote:
                        raise ValueError("subrange quote")
                except (ValueError, KeyError, TypeError, HTTPException, AttributeError):
                    raise HTTPException(422, "子范围资料结构无效") from None
            # Imported assist IDs are provenance, never local database references.
            def provenance(explanation):
                if explanation is None:
                    return
                if not isinstance(explanation, dict) or not all(isinstance(explanation.get(k), str) for k in ("text", "source", "kind")):
                    raise HTTPException(422, "解释快照结构无效")
                if "assist_id" in explanation:
                    explanation["imported_assist_id"] = explanation.pop("assist_id")
            provenance(value["explanation"])
            for explanation in value["explanation_history"]:
                provenance(explanation)
            for sub in value["subranges"]:
                provenance(sub.get("explanation"))
                history = sub.get("explanation_history", [])
                if not isinstance(history, list) or len(history) > MAX_ROWS:
                    raise HTTPException(422, "子范围解释历史无效")
                for explanation in history:
                    provenance(explanation)
            output[category].append(value)
    return output


def merge_personal(local, incoming, *, restore_snapshot=False):
    """Preserve both records' range-specific material without replacing edits.

    A blank whole-range record can accept the imported snapshot, but its
    subranges may hold earlier personal work. They are always retained. Root
    equality never implies equality of the nested material.
    """
    fields = ("anchor", "quote", "explanation", "explanation_history", "my_meaning")
    result = dict(incoming if restore_snapshot else local)
    references = [*local.get("subranges", []), *incoming.get("subranges", [])]
    other = local if restore_snapshot else incoming
    reference = {k: other[k] for k in fields}
    if reference != {k: result[k] for k in fields}:
        references.append(reference)
    # Preserve distinct histories/meanings on the same range, but don't append
    # an identical snapshot again when a different import UID carries it.
    result["subranges"] = list({packed(s): s for s in references}.values())
    if len(result["subranges"]) > MAX_ROWS:
        raise HTTPException(413, "合并后的子范围资料过多，未覆盖本机资料")
    return result


def import_data(service, data):
    records = validate_import(data)
    counts = {"imported": 0, "duplicates": 0, "unresolved": 0}
    with service.store.transaction():
        for category, entries in records.items():
            for saved in entries:
                uid = saved["uid"]
                if category == "notes":
                    prior = service.store.query_one("SELECT * FROM wr_collection_note_import WHERE uid=?", (uid,))
                else:
                    prior = service.store.query_one("SELECT * FROM wr_collection_import WHERE category=? AND uid=?", (category, uid))
                    if prior is None:
                        direct = service.store.query_one(f"SELECT id FROM {TABLES[category]} WHERE uid=?", (uid,))
                        prior = {"local_id": direct["id"]} if direct else None
                if prior:
                    # Repeated restore is idempotent and never overwrites local edits.
                    if category == "notes":
                        previous = json.loads(prior["data"])
                    else:
                        previous = item(service.row(prior["local_id"], category, active=False))
                    if previous["quote"] != saved["quote"] or previous["source_identity"] != saved["source_identity"] or anchor_key(previous.get("anchor")) != anchor_key(saved.get("anchor")):
                        # A union may contain an imported occurrence as a retained subrange.
                        if not any(s.get("quote") == saved["quote"] and anchor_key(s.get("anchor")) == anchor_key(saved["anchor"]) for s in previous.get("subranges", [])):
                            raise HTTPException(409, "导入身份与现有记录冲突，未覆盖本机资料")
                    counts["duplicates"] += 1
                    continue
                bound = resolve(service.store, saved, imported=True) if saved.get("anchor") and saved.get("quote") else None
                if not bound and category == "notes" and not saved.get("anchor"):
                    bound = resolve_document(service.store, saved["source_identity"])
                saved["doc_id"] = bound["doc_id"] if bound else None
                saved["book_id"] = bound["book_id"] if bound else None
                saved["start_pos"] = bound["start_pos"] if bound else -1
                saved["end_pos"] = bound["end_pos"] if bound else -1
                # An old OCR snapshot must not masquerade as current-source feedback/highlighting.
                if bound and saved.get("anchor") and bound.get("anchor") and saved["anchor"]["version"] != bound["anchor"]["version"]:
                    saved["start_pos"], saved["end_pos"] = -1, -1
                if not bound:
                    counts["unresolved"] += 1
                if category == "notes":
                    note_id = None
                    if bound and exists(service.store, "wr_note"):
                        candidates = checked_rows(service.store, "SELECT n.*,a.payload AS anchor_json FROM wr_note n LEFT JOIN wr_anchor a ON a.owner='note' AND a.owner_id=n.id WHERE n.doc_id=? AND n.created_at=? AND n.quote=?", (bound["doc_id"], saved["created_at"], saved["quote"]))
                        original = next((r for r in candidates if note_snapshot(service, r)["uid"] == uid), None)
                        if original:
                            service.store.execute("INSERT INTO wr_collection_note_import VALUES(?,?,?,?)", (uid, original["id"], bound["book_id"], packed(saved)))
                            counts["duplicates"] += 1
                            continue
                        note_id = service.store.execute("INSERT INTO wr_note(doc_id,quote,body,created_at) VALUES(?,?,?,?)", (bound["doc_id"], saved["quote"], saved["body"], saved["created_at"] or now())).lastrowid
                        if bound.get("anchor"):
                            save_anchor(service.store, "note", note_id, bound["doc_id"], Anchor.model_validate(bound["anchor"]))
                    service.store.execute("INSERT INTO wr_collection_note_import VALUES(?,?,?,?)", (uid, note_id, saved["book_id"], packed(saved)))
                else:
                    duplicate = service.store.query_one(f"SELECT * FROM {TABLES[category]} WHERE dedupe=? AND deleted=0", (key(saved, saved["kind"]),))
                    if duplicate:
                        local = json.loads(duplicate["data"])
                        if category == "collections":
                            merged = merge_personal(local, saved)
                            if merged != local:
                                service._write(duplicate, data=merged)
                        elif any(local.get(k) != saved.get(k) for k in ("understood", "retained", "note", "detail", "target")):
                            # Imported feedback must not silently override a newer local declaration.
                            raise HTTPException(409, "导入反馈与本机状态不同，未覆盖任何资料")
                        counts["duplicates"] += 1
                        service.store.execute("INSERT INTO wr_collection_import VALUES(?,?,?)", (category, uid, duplicate["id"]))
                        continue
                    if category == "collections" and bound and saved["anchor"]["version"] == bound["anchor"]["version"]:
                        result = service.save(bound["doc_id"], saved["kind"], Anchor.model_validate(bound["anchor"]))
                        row = service.row(result["item"]["id"])
                        local = json.loads(row["data"])
                        same_range = local["anchor"] == bound["anchor"]
                        # A surviving ID and empty root fields do NOT mean this
                        # is a new record: save may have moved edits to subranges.
                        empty_root = not any(local.get(k) for k in ("my_meaning", "explanation", "explanation_history"))
                        local = merge_personal(local, {**saved, "anchor": bound["anchor"]},
                                               restore_snapshot=same_range and empty_root)
                        row = service._write(row, data=local)
                    else:
                        row = service._insert(saved, saved["kind"], category)
                    service.store.execute("INSERT INTO wr_collection_import VALUES(?,?,?)", (category, uid, row["id"]))
                counts["imported"] += 1
    return counts


def cleanup(service, scope):
    if not scope.get("confirm"):
        raise HTTPException(400, "永久清理需要 confirm=true")
    if scope.get("book_id") is None and not scope.get("ids"):
        raise HTTPException(400, "永久清理必须指定书籍或收藏记录")
    if not any(scope.get(k) for k in ("collections", "notes", "feedback")):
        raise HTTPException(400, "请选择要清理的资料类别")
    removed = {"collections": 0, "notes": 0, "feedback": 0}
    with service.store.transaction():
        selections = selected_collections(service, scope, deleted=True) if scope.get("collections") or scope.get("ids") is not None else []
        feedback = scoped_feedback(service, scope, selections, deleted=True) if scope.get("feedback") else []
        notes = scoped_notes(service, scope, selections) if scope.get("notes") else []
        orphan_notes = scoped_orphan_notes(service, scope, selections) if scope.get("notes") else []
        for category, rows in (("collections", selections if scope.get("collections") else []), ("feedback", feedback)):
            for row in rows:
                service.store.execute("DELETE FROM wr_collection_undo WHERE token IN (SELECT token FROM wr_collection_undo_touch WHERE category=? AND record_id=?)", (category, row["id"]))
                service.store.execute(f"DELETE FROM {TABLES[category]} WHERE id=?", (row["id"],))
                service.store.execute("DELETE FROM wr_collection_import WHERE category=? AND local_id=?", (category, row["id"]))
                if category == "collections":
                    service.store.execute("DELETE FROM wr_collection_seen WHERE item_id=?", (row["id"],))
                removed[category] += 1
        for note in notes:
            service.store.execute("DELETE FROM wr_note WHERE id=?", (note["id"],))
            service.store.execute("DELETE FROM wr_anchor WHERE owner='note' AND owner_id=?", (note["id"],))
            if exists(service.store, "wr_note_key"):
                service.store.execute("DELETE FROM wr_note_key WHERE note_id=?", (note["id"],))
            service.store.execute("DELETE FROM wr_collection_note_import WHERE note_id=?", (note["id"],))
            removed["notes"] += 1
        for note in orphan_notes:
            service.store.execute("DELETE FROM wr_collection_note_import WHERE uid=?", (note["uid"],))
            removed["notes"] += 1
    return {"removed": removed}
