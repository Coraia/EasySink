"""Contextual collections, independent feedback, persistent guarded undo.

No model calls and no mutations of legacy verdicts, notes, content or progress.
"""
from __future__ import annotations

import json
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException

from wise_reader.assist_context import public_payload
from wise_reader.collections_source import anchor_key, digest, exists, index, packed, resolve, union_anchor, validate
from wise_reader.content import Anchor

MAX_ROWS = 2000
TABLES = {"collections": "wr_collection", "feedback": "wr_collection_feedback"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def migrate(store):
    # Additive only. Prefix every new object to avoid ownership of old schemas.
    store.executescript("""
    CREATE TABLE IF NOT EXISTS wr_collection (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE,
      doc_id INTEGER, book_id INTEGER, kind TEXT NOT NULL,
      version TEXT NOT NULL, start_pos INTEGER NOT NULL, end_pos INTEGER NOT NULL,
      dedupe TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS wr_collection_active_key ON wr_collection(dedupe) WHERE deleted=0;
    CREATE INDEX IF NOT EXISTS wr_collection_doc_range ON wr_collection(doc_id,version,deleted,kind,start_pos,end_pos);
    CREATE INDEX IF NOT EXISTS wr_collection_book ON wr_collection(book_id,deleted,id);
    CREATE INDEX IF NOT EXISTS wr_collection_list ON wr_collection(deleted,kind,id);
    CREATE TABLE IF NOT EXISTS wr_collection_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE,
      doc_id INTEGER, book_id INTEGER, kind TEXT NOT NULL DEFAULT 'feedback',
      version TEXT NOT NULL, start_pos INTEGER NOT NULL, end_pos INTEGER NOT NULL,
      dedupe TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS wr_collection_feedback_key ON wr_collection_feedback(dedupe) WHERE deleted=0;
    CREATE INDEX IF NOT EXISTS wr_collection_feedback_doc ON wr_collection_feedback(doc_id,deleted,id);
    CREATE INDEX IF NOT EXISTS wr_collection_feedback_book ON wr_collection_feedback(book_id,deleted,id);
    CREATE INDEX IF NOT EXISTS wr_collection_feedback_source ON wr_collection_feedback(json_extract(data,'$.source_identity'),deleted);
    CREATE TABLE IF NOT EXISTS wr_collection_undo (
      token TEXT PRIMARY KEY, changes TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wr_collection_undo_touch (
      token TEXT NOT NULL, category TEXT NOT NULL, record_id INTEGER NOT NULL,
      PRIMARY KEY(token,category,record_id));
    CREATE INDEX IF NOT EXISTS wr_collection_undo_record ON wr_collection_undo_touch(category,record_id);
    CREATE TRIGGER IF NOT EXISTS wr_collection_undo_delete AFTER DELETE ON wr_collection_undo
    BEGIN DELETE FROM wr_collection_undo_touch WHERE token=OLD.token; END;
    CREATE TABLE IF NOT EXISTS wr_collection_import (
      category TEXT NOT NULL, uid TEXT NOT NULL, local_id INTEGER NOT NULL,
      PRIMARY KEY(category,uid));
    CREATE INDEX IF NOT EXISTS wr_collection_import_local ON wr_collection_import(category,local_id);
    CREATE TABLE IF NOT EXISTS wr_collection_resurface (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 1,
      day TEXT NOT NULL DEFAULT '', item_id INTEGER);
    INSERT OR IGNORE INTO wr_collection_resurface(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS wr_collection_seen (
      item_id INTEGER PRIMARY KEY, last_day TEXT, seen_count INTEGER NOT NULL DEFAULT 0,
      snoozed_until TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS wr_collection_seen_day ON wr_collection_seen(last_day);
    CREATE TABLE IF NOT EXISTS wr_collection_note_import (
      uid TEXT PRIMARY KEY, note_id INTEGER, book_id INTEGER, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS wr_collection_note_import_local ON wr_collection_note_import(note_id);
    CREATE INDEX IF NOT EXISTS wr_collection_note_import_book ON wr_collection_note_import(book_id);
    CREATE INDEX IF NOT EXISTS wr_collection_note_import_source ON wr_collection_note_import(json_extract(data,'$.source_identity'));
    CREATE INDEX IF NOT EXISTS wr_collection_source_hash ON document(text_hash);
    CREATE INDEX IF NOT EXISTS wr_collection_chapter_doc ON wr_chapter(doc_id,id);
    CREATE INDEX IF NOT EXISTS wr_collection_chapter_book ON wr_chapter(book_id,idx);
    """)
    from wise_reader.reading_learning import migrate as migrate_learning
    migrate_learning(store)
    store.execute("CREATE INDEX IF NOT EXISTS wr_feedback_preference_updated ON wr_collection_feedback(updated_at,id) WHERE deleted=0 AND json_extract(data,'$.annotation_preference') IS NOT NULL")
    if exists(store, "wr_note"):
        store.execute("CREATE INDEX IF NOT EXISTS wr_collection_note_scope ON wr_note(doc_id,created_at)")
    if exists(store, "wr_context_attempt"):
        store.execute("CREATE INDEX IF NOT EXISTS wr_collection_assist_state ON wr_context_attempt(assist_id,state)")


def normalize_subrange(value):
    """Supply optional personal fields without changing the saved source range."""
    return {"explanation": None, "explanation_history": [], "my_meaning": "", **value}


def item(row):
    value = json.loads(row["data"])
    if "subranges" in value:
        value["subranges"] = [normalize_subrange(sub) for sub in value["subranges"]]
    return {**value, **{k: row[k] for k in ("id", "uid", "doc_id", "book_id", "kind", "created_at", "updated_at", "revision")}}


def key(snapshot, kind):
    anchor = snapshot["anchor"]
    parts = anchor.get("segments") or [anchor]
    occurrence = [[p["block_id"], p["start"], p["end"]] for p in parts]
    # Local documents with identical text remain distinct occurrences.
    origin = [snapshot["doc_id"], anchor["version"]] if snapshot.get("doc_id") else snapshot["source_identity"]
    return digest([kind, origin, occurrence])


class Collections:
    def __init__(self, store, lexicon=None):
        self.store = store
        self.lexicon = lexicon

    def row(self, record_id, category="collections", active=True):
        row = self.store.query_one(f"SELECT * FROM {TABLES[category]} WHERE id=?" + (" AND deleted=0" if active else ""), (record_id,))
        if not row:
            raise HTTPException(404, "记录不存在")
        return row

    def _insert(self, snapshot, kind, category="collections", uid=None):
        data = {k: v for k, v in snapshot.items() if k not in {"start_pos", "end_pos"}}
        if len(packed(data).encode()) > 1024 * 1024:
            raise HTTPException(413, "单条记录超过 1 MiB，请导出整理")
        stamp = now()
        cur = self.store.execute(f"INSERT INTO {TABLES[category]}(uid,doc_id,book_id,kind,version,start_pos,end_pos,dedupe,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (uid or str(uuid.uuid4()), snapshot.get("doc_id"), snapshot.get("book_id"), kind,
             snapshot["anchor"]["version"], snapshot["start_pos"], snapshot["end_pos"], key(snapshot, kind), packed(data), stamp, stamp))
        return self.row(cur.lastrowid, category)

    def _write(self, row, data=None, deleted=None, snapshot=None, category="collections"):
        values = dict(row)
        if data is not None:
            values["data"] = packed(data)
            if len(values["data"].encode()) > 1024 * 1024:
                raise HTTPException(413, "单条记录超过 1 MiB，请导出整理")
        if deleted is not None:
            values["deleted"] = int(deleted)
        if snapshot:
            values.update({k: snapshot[k] for k in ("doc_id", "book_id", "start_pos", "end_pos")})
            values["version"] = snapshot["anchor"]["version"]
            values["dedupe"] = key(snapshot, row["kind"])
        values["revision"] += 1
        values["updated_at"] = now()
        fields = [k for k in values if k != "id"]
        self.store.execute(f"UPDATE {TABLES[category]} SET " + ",".join(k + "=?" for k in fields) + " WHERE id=?", tuple(values[k] for k in fields) + (row["id"],))
        return self.row(row["id"], category, active=False)

    def _undo_token(self, category, before, after, extra=()):
        changes = [{"category": category, "id": row["id"], "before": before.get(row["id"]), "after_revision": row["revision"]} for row in after]
        changes.extend(extra)
        if not changes:
            return None
        token = secrets.token_urlsafe(32)
        self.store.execute("INSERT INTO wr_collection_undo(token,changes,created_at) VALUES(?,?,?)", (token, packed(changes), now()))
        for change in changes:
            self.store.execute("INSERT INTO wr_collection_undo_touch VALUES(?,?,?)", (token, change["category"], change["id"]))
        return token

    @staticmethod
    def _subrange(snapshot, explanation=None):
        return normalize_subrange({"anchor": snapshot["anchor"], "quote": snapshot["quote"], "explanation": explanation})

    def explanation(self, supplied, snapshot):
        if not supplied:
            return None
        if supplied.get("assist_id"):
            return self.adopt(supplied["assist_id"], snapshot)
        if supplied.get("kind") not in {"dictionary", "gloss"}:
            raise HTTPException(422, "AI 解释须采用已保存的 assist_id")
        return {"text": supplied["text"], "source": supplied["source"], "kind": supplied["kind"]}

    def adopt(self, assist_id, snapshot):
        row = self.store.query_one("SELECT * FROM wr_assist WHERE id=?", (assist_id,)) if exists(self.store, "wr_assist") else None
        if not row or row["kind"] != "context":
            raise HTTPException(404, "已保存的语境解释不存在")
        if exists(self.store, "wr_context_attempt"):
            failed = self.store.query_one("SELECT 1 FROM wr_context_attempt WHERE assist_id=? AND state!='succeeded' LIMIT 1", (assist_id,))
            if failed:
                raise HTTPException(409, "解释状态未确认成功")
        if row["doc_id"] != snapshot.get("doc_id") or row["version"] != snapshot["anchor"]["version"]:
            raise HTTPException(409, "解释与收藏原文版本不一致")
        anchor = json.loads(row["anchor"])
        def range_key(value):
            return [(p["block_id"], p["start"], p["end"]) for p in (value.get("segments") or [value])]
        if range_key(anchor) != range_key(snapshot["anchor"]) or anchor.get("quote") != snapshot["quote"]:
            raise HTTPException(409, "解释与收藏的子范围不一致")
        payload = public_payload(json.loads(row["payload"]))
        meaning, explanation = payload.get("meaning"), payload.get("explanation")
        if not isinstance(meaning, str) or not isinstance(explanation, str) or not meaning.strip():
            raise HTTPException(409, "解释没有有效结果")
        return {"text": meaning + ("\n" + explanation if explanation else ""), "source": row["source"],
                "kind": "context", "assist_id": row["id"], "created_at": row["created_at"],
                "anchor": anchor, "payload": payload}

    def save(self, doc_id, kind, anchor, explanation=None):
        with self.store.transaction():
            snap = validate(self.store, doc_id, anchor)
            old = self.store.query_one("SELECT * FROM wr_collection WHERE dedupe=? AND deleted=0", (key(snap, kind),))
            if old:
                return {"item": item(old), "merged_ids": [], "undo_token": None}
            exp = self.explanation(explanation, snap)
            overlap, lo, hi = {}, snap["start_pos"], snap["end_pos"]
            if kind == "excerpt":
                while True:
                    rows = self.store.query("SELECT * FROM wr_collection WHERE doc_id=? AND version=? AND deleted=0 AND kind='excerpt' AND start_pos<? AND end_pos>? ORDER BY id LIMIT ?", (doc_id, snap["anchor"]["version"], hi, lo, MAX_ROWS + 1))
                    if len(rows) > MAX_ROWS:
                        raise HTTPException(413, "重叠记录过多，请分批整理")
                    unseen = [r for r in rows if r["id"] not in overlap]
                    if not unseen:
                        break
                    overlap.update({r["id"]: r for r in unseen})
                    lo, hi = min(lo, *(r["start_pos"] for r in unseen)), max(hi, *(r["end_pos"] for r in unseen))
            original = snap
            if overlap:
                snap = validate(self.store, doc_id, union_anchor(self.store, doc_id, snap["anchor"]["version"], lo, hi))
            data = {**snap, "explanation": exp if not overlap else None, "explanation_history": [], "my_meaning": "",
                    "subranges": [self._subrange(original, exp)]}
            before, changed = {}, []
            if overlap:
                rows = list(overlap.values())
                primary = rows[0]
                for row in rows:
                    before[row["id"]] = row
                    old_data = json.loads(row["data"])
                    data["subranges"].extend(old_data.get("subranges", []))
                    # Keep whole-record edits attached to their original range.
                    if old_data.get("my_meaning") or old_data.get("explanation") or old_data.get("explanation_history"):
                        data["subranges"].append({k: old_data.get(k) for k in ("anchor", "quote", "explanation", "explanation_history", "my_meaning")})
                # Deactivate absorbed keys before updating the surviving union.
                for row in rows[1:]:
                    changed.append(self._write(row, deleted=True))
                data["subranges"] = list({packed(s): s for s in data["subranges"]}.values())
                if len(data["subranges"]) > MAX_ROWS:
                    raise HTTPException(413, "子范围资料过多，请导出整理")
                result = self._write(primary, data=self.with_adoptions(data), snapshot=snap)
            else:
                previous = self.store.query_one("SELECT * FROM wr_collection WHERE dedupe=? AND deleted=1 ORDER BY id DESC LIMIT 1", (key(snap, kind),))
                if previous:
                    before[previous["id"]] = previous
                    data = json.loads(previous["data"])
                    result = self._write(previous, data=self.with_adoptions(data), deleted=False)
                else:
                    result = self._insert(self.with_adoptions(data), kind)
            changed.append(result)
            return {"item": item(result), "merged_ids": [i for i in overlap if i != result["id"]],
                    "undo_token": self._undo_token("collections", before, changed)}

    def patch(self, record_id, fields):
        with self.store.transaction():
            old = self.row(record_id)
            if fields.get("expected_revision") is not None and fields["expected_revision"] != old["revision"]:
                raise HTTPException(409, "记录已修改，请刷新后重试")
            data = json.loads(old["data"])
            adoption_changes = []
            if "my_meaning" in fields:
                data["my_meaning"] = fields["my_meaning"]
            if fields.get("adopt_assist_id") is not None:
                # Restored records may remain unbound until the original arrives.
                # Resolve for this operation, never rewrite the saved snapshot or
                # promote a historical OCR range to the current version.
                bound = resolve(self.store, item(old))
                if not bound or anchor_key(bound["anchor"]) != anchor_key(data["anchor"]):
                    raise HTTPException(409, "原文无法按收藏时的版本与范围可靠对应，未采用解释")
                destination = data
                aid = fields["adopt_assist_id"]
                assist = self.store.query_one("SELECT anchor FROM wr_assist WHERE id=?", (aid,)) if exists(self.store, "wr_assist") else None
                if assist:
                    target = json.loads(assist["anchor"])
                    if anchor_key(target) != anchor_key(data["anchor"]):
                        outer = {p["block_id"]: p for p in data["anchor"].get("segments") or [data["anchor"]]}
                        expected = []
                        for part in target.get("segments") or [target]:
                            parent = outer.get(part["block_id"])
                            if not parent or not parent["start"] <= part["start"] < part["end"] <= parent["end"]:
                                raise HTTPException(409, "解释不属于收藏的子范围")
                            a, b = index(parent["quote"], part["start"] - parent["start"]), index(parent["quote"], part["end"] - parent["start"])
                            expected.append(parent["quote"][a:b])
                        if "\n\n".join(expected) != target.get("quote") or target["version"] != data["anchor"]["version"]:
                            raise HTTPException(409, "解释与收藏快照不一致")
                        destination = next((sub for sub in data["subranges"] if anchor_key(sub["anchor"]) == anchor_key(target)), None)
                        if destination is None:
                            destination = self._subrange({"anchor": target, "quote": target["quote"]})
                            data["subranges"].append(destination)
                # Also repair optional fields in pre-normalization stored rows;
                # normalization is persisted only with a successful guarded edit.
                destination.update(normalize_subrange(destination))
                exp = self.adopt(aid, {**destination, "doc_id": bound["doc_id"]})
                if exp != destination.get("explanation"):
                    if destination.get("explanation"):
                        destination["explanation_history"].append(destination["explanation"])
                    if len(destination["explanation_history"]) > MAX_ROWS:
                        raise HTTPException(413, "解释历史过多，请先导出")
                    destination["explanation"] = exp
                # Apply to this occurrence independently of mastery/retention.
                # Collection and reading changes share one atomic undo receipt.
                snap = validate(self.store, bound["doc_id"], Anchor.model_validate(exp["anchor"]))
                _, adoption_changes = self._adopt_feedback(snap, exp)
            if data == json.loads(old["data"]):
                return {"item": item(old), "undo_token": self._undo_token("collections", {}, [], adoption_changes)}
            updated = self._write(old, data=data)
            return {"item": item(updated), "undo_token": self._undo_token("collections", {old["id"]: old}, [updated], adoption_changes)}

    def with_adoptions(self, value):
        """Project only adopted explanations into a collection, never preferences."""
        value = json.loads(packed(value))
        for part in [*value.get("subranges", []), value]:
            snapshot = {**value, "anchor": part["anchor"]}
            row = self.store.query_one("SELECT * FROM wr_collection_feedback WHERE dedupe=? AND deleted=0", (key(snapshot, "feedback"),))
            state = json.loads(row["data"]) if row else {}
            if not state.get("explanation"):
                continue
            history = [*part.get("explanation_history", [])]
            if part.get("explanation") and part["explanation"] != state["explanation"]:
                history.append(part["explanation"])
            history.extend(state.get("explanation_history", []))
            part["explanation_history"] = list({packed(exp): exp for exp in history}.values())
            if len(part["explanation_history"]) > MAX_ROWS:
                raise HTTPException(413, "解释历史过多，请先导出")
            part["explanation"] = state["explanation"]
        return value

    def _preserve_legacy_adoptions(self, row):
        """Before uncollecting, detach old adopted snapshots without rebinding them."""
        data = json.loads(row["data"])
        positions, cursor = {}, row["start_pos"]
        for part in data["anchor"].get("segments") or [data["anchor"]]:
            positions[part["block_id"]] = cursor - part["start"]
            cursor += part["end"] - part["start"] + 2
        candidates = {}
        for part in [*data.get("subranges", []), data]:
            exp = part.get("explanation")
            if exp and exp.get("kind") == "context" and exp.get("anchor") and anchor_key(exp["anchor"]) == anchor_key(part["anchor"]):
                candidates[packed(anchor_key(part["anchor"]))] = part
        changes = []
        for part in candidates.values():
            segments = part["anchor"].get("segments") or [part["anchor"]]
            snapshot = {k: data[k] for k in ("source_identity", "title", "book_title", "context", "context_truncated") if k in data}
            snapshot.update(doc_id=row["doc_id"], book_id=row["book_id"], anchor=part["anchor"], quote=part["quote"],
                            start_pos=positions[segments[0]["block_id"]] + segments[0]["start"],
                            end_pos=positions[segments[-1]["block_id"]] + segments[-1]["end"])
            existing = self.store.query_one("SELECT data FROM wr_collection_feedback WHERE dedupe=? AND deleted=0", (key(snapshot, "feedback"),))
            if existing and json.loads(existing["data"]).get("explanation"):
                continue
            _, adopted = self._adopt_feedback(snapshot, part["explanation"], part.get("explanation_history", []))
            changes.extend(adopted)
        return changes

    def _adopt_feedback(self, snapshot, explanation, prior_history=()):
        old = self.store.query_one("SELECT * FROM wr_collection_feedback WHERE dedupe=? AND deleted=0", (key(snapshot, "feedback"),))
        data = json.loads(old["data"]) if old else {**snapshot, "understood": None, "retained": False, "note": "", "detail": "", "target": ""}
        if data.get("explanation") == explanation:
            return old, []
        history = data.setdefault("explanation_history", [])
        history.extend(exp for exp in prior_history if exp not in history)
        if data.get("explanation"):
            history.append(data["explanation"])
        if len(history) > MAX_ROWS:
            raise HTTPException(413, "解释历史过多，请先导出")
        data["explanation"] = explanation
        updated = self._write(old, data=data, category="feedback") if old else self._insert(data, "feedback", "feedback")
        return updated, [{"category": "feedback", "id": updated["id"], "before": old, "after_revision": updated["revision"]}]

    def adopt_context(self, doc_id, anchor, assist_id, expected_feedback_revision, expected_collection_revision=0):
        with self.store.transaction():
            snap = validate(self.store, doc_id, anchor)
            saved = self.store.query_one("SELECT * FROM wr_collection WHERE dedupe=? AND deleted=0", (key(snap, "word"),))
            feedback = self.store.query_one("SELECT * FROM wr_collection_feedback WHERE dedupe=? AND deleted=0", (key(snap, "feedback"),))
            if (saved["revision"] if saved else 0) != expected_collection_revision or (feedback["revision"] if feedback else 0) != expected_feedback_revision:
                raise HTTPException(409, "此处记录已修改，请刷新后再采用")
            if saved:
                return self.patch(saved["id"], {"adopt_assist_id": assist_id, "expected_revision": expected_collection_revision})
            explanation = self.adopt(assist_id, snap)
            updated, changes = self._adopt_feedback(snap, explanation)
            return {"state": item(updated), "undo_token": self._undo_token("feedback", {}, [], changes)}

    def delete(self, record_id, revision=None):
        with self.store.transaction():
            old = self.row(record_id)
            if revision is not None and old["revision"] != revision:
                raise HTTPException(409, "记录已修改，请刷新后重试")
            adoption_changes = self._preserve_legacy_adoptions(old)
            updated = self._write(old, deleted=True)
            return {"undo_token": self._undo_token("collections", {old["id"]: old}, [updated], adoption_changes)}

    def usage_preview(self, doc_id, anchor):
        from wise_reader.usage_feedback import choices
        snap = validate(self.store, doc_id, anchor)
        return {"choices": choices(self.store, snap)}

    def usage_feedback(self, doc_id, anchor, action, scope_id, fields):
        from wise_reader.usage_feedback import selected_scope
        with self.store.transaction():
            from wise_reader.reading_learning import estimate, record_feedback
            before_model = estimate(self.store, self.lexicon, self.store.get_profile())
            snap = validate(self.store, doc_id, anchor)
            old = self.store.query_one("SELECT * FROM wr_collection_feedback WHERE dedupe=? AND deleted=0", (key(snap, "feedback"),))
            data = json.loads(old["data"]) if old else {**snap, "understood": None, "retained": False, "note": "", "detail": "", "target": ""}
            usage = selected_scope(self.store, snap, scope_id)
            data["usage"] = usage
            if action != "scope":
                if action == "need":
                    data["preference_note"] = fields.get("note", "").strip()
                data["annotation_preference"] = action
                data["understood"] = None
                if action == "known":
                    data["retained"] = False
            if data.get("annotation_preference") == "need":
                data["preference_note"] = data.get("preference_note", "").strip()
                if not data["preference_note"]:
                    raise HTTPException(422, "此处没有可复用的释义；取得语境解释后可仅在此处保留")
            if old and data == json.loads(old["data"]):
                return {"state": item(old), "undo_token": None, "model": before_model}
            updated = self._write(old, data=data, category="feedback") if old else self._insert(data, "feedback", "feedback")
            token = self._undo_token("feedback", {old["id"]: old} if old else {}, [updated])
            record_feedback(self.store, self.lexicon, item(updated), action, token, before_model)
            return {"state": item(updated), "undo_token": token, "model": estimate(self.store, self.lexicon, self.store.get_profile())}

    def feedback(self, doc_id, anchor, fields):
        with self.store.transaction():
            snap = validate(self.store, doc_id, anchor)
            old = self.store.query_one("SELECT * FROM wr_collection_feedback WHERE dedupe=? AND deleted=0", (key(snap, "feedback"),))
            data = json.loads(old["data"]) if old else {**snap, "understood": None, "retained": False, "note": "", "detail": "", "target": ""}
            data.update(fields)
            if data.get("retained"):
                data["note"] = data.get("note", "").strip()
                if not data["note"]:
                    raise HTTPException(422, "此处尚无可保留的释义；可先取得并采用语境解释")
            if old and data == json.loads(old["data"]):
                return {"state": item(old), "undo_token": None}
            updated = self._write(old, data=data, category="feedback") if old else self._insert(data, "feedback", "feedback")
            return {"state": item(updated), "undo_token": self._undo_token("feedback", {old["id"]: old} if old else {}, [updated])}

    def undo(self, token):
        with self.store.transaction():
            operation = self.store.query_one("SELECT * FROM wr_collection_undo WHERE token=?", (token,))
            if not operation or operation["used"]:
                raise HTTPException(409, "撤销已使用或已失效")
            changes = json.loads(operation["changes"])
            current = {}
            for change in changes:
                row = self.store.query_one(f"SELECT * FROM {TABLES[change['category']]} WHERE id=?", (change["id"],))
                if not row or row["revision"] != change["after_revision"]:
                    raise HTTPException(409, "记录已有后续修改，不能覆盖")
                current[(change["category"], change["id"])] = row
            for change in changes:
                before = change["before"]
                if not before or before["deleted"]:
                    continue
                table = TABLES[change["category"]]
                exclude = [c["id"] for c in changes if c["category"] == change["category"]]
                where = "id NOT IN (" + ",".join("?" for _ in exclude) + ") AND deleted=0 AND "
                if change["category"] == "collections" and before["kind"] == "excerpt":
                    query = "doc_id IS ? AND version=? AND kind='excerpt' AND start_pos<? AND end_pos>?"
                    params = (before["doc_id"], before["version"], before["end_pos"], before["start_pos"])
                else:
                    query, params = "dedupe=?", (before["dedupe"],)
                if self.store.query_one(f"SELECT id FROM {table} WHERE " + where + query + " LIMIT 1", (*exclude, *params)):
                    raise HTTPException(409, "原范围已有新记录，不能覆盖")
            # Temporarily deactivate every touched key; unique constraints remain valid.
            for change in changes:
                self.store.execute(f"UPDATE {TABLES[change['category']]} SET deleted=1 WHERE id=?", (change["id"],))
            restored = []
            for change in changes:
                row = current[(change["category"], change["id"])]
                before = change["before"]
                value = {**(before or row), "revision": row["revision"] + 1, "updated_at": now()}
                if before is None:
                    value["deleted"] = 1
                fields = [k for k in value if k != "id"]
                self.store.execute(f"UPDATE {TABLES[change['category']]} SET " + ",".join(k + "=?" for k in fields) + " WHERE id=?", tuple(value[k] for k in fields) + (row["id"],))
                if not value["deleted"]:
                    restored.append(item(value))
            self.store.execute("UPDATE wr_collection_undo SET used=1 WHERE token=?", (token,))
            from wise_reader.reading_learning import retract_feedback
            retract_feedback(self.store, token)
            return {"ok": True, "items": restored}

    def list(self, doc_id=None, book_id=None, kind=None, q="", limit=50, offset=0):
        conditions, params = ["deleted=0"], []
        for column, value in (("doc_id", doc_id), ("book_id", book_id), ("kind", kind)):
            if value is not None:
                conditions.append(column + "=?")
                params.append(value)
        if q:
            conditions.append("(json_extract(data,'$.quote') LIKE ? ESCAPE '\\' OR json_extract(data,'$.my_meaning') LIKE ? ESCAPE '\\')")
            pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            params.extend([pattern, pattern])
        where = " AND ".join(conditions)
        total = self.store.query_one("SELECT COUNT(*) AS n FROM wr_collection WHERE " + where, tuple(params))["n"]
        rows = self.store.query("SELECT * FROM wr_collection WHERE " + where + " ORDER BY id DESC LIMIT ? OFFSET ?", (*params, limit, offset))
        return {"items": [item(r) for r in rows], "total": total}

    def state(self, doc_id):
        collections = self.store.query("SELECT * FROM wr_collection WHERE doc_id=? AND deleted=0 ORDER BY id LIMIT ?", (doc_id, MAX_ROWS + 1))
        feedback = self.store.query("SELECT * FROM wr_collection_feedback WHERE doc_id=? AND deleted=0 ORDER BY id LIMIT ?", (doc_id, MAX_ROWS + 1))
        if len(collections) > MAX_ROWS or len(feedback) > MAX_ROWS:
            raise HTTPException(413, "本章记录过多，请使用分页收藏列表")
        from wise_reader.usage_feedback import project
        values = [item(r) for r in feedback]
        return {"items": [item(r) for r in collections], "feedback": values, "usage_matches": project(self.store, doc_id, values)}

    def source(self, record_id):
        saved = item(self.row(record_id))
        snap = resolve(self.store, saved)
        result = {k: saved[k] for k in ("doc_id", "anchor", "title", "book_title", "quote", "context")}
        if not snap:
            return {**result, "available": False, "doc_id": None, "reason": "原文已移走、回收或无法唯一可靠定位；仍保留收藏时的快照"}
        return {**result, "available": True, "doc_id": snap["doc_id"], "anchor": snap["anchor"],
                "historical": snap["anchor"]["version"] != saved["anchor"]["version"],
                "current_context": snap["context"]}

    def resurface(self, action=None, record_id=None):
        with self.store.transaction():
            today = date.today()
            day = today.isoformat()
            state = self.store.query_one("SELECT * FROM wr_collection_resurface WHERE id=1")
            if action in {"hide", "show"}:
                state["enabled"] = int(action == "show")
                self.store.execute("UPDATE wr_collection_resurface SET enabled=? WHERE id=1", (state["enabled"],))
            current = self.store.query_one("SELECT c.* FROM wr_collection c LEFT JOIN wr_collection_seen s ON s.item_id=c.id WHERE c.id=? AND c.deleted=0 AND COALESCE(s.snoozed_until,'')<=?", (state["item_id"], day))
            if action == "snooze":
                target = record_id if record_id is not None else state["item_id"]
                if target is None:
                    raise HTTPException(400, "没有可暂不推荐的收藏")
                self.row(target)
                until = (today + timedelta(days=30)).isoformat()
                self.store.execute("INSERT INTO wr_collection_seen(item_id,snoozed_until) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET snoozed_until=excluded.snoozed_until", (target, until))
                if target == state["item_id"]:
                    current = None
            if not state["enabled"]:
                return {"enabled": False, "item": None, "reason": "已关闭再次遇见"}
            if current and state["day"] == day and action != "next":
                return {"enabled": True, "item": item(current)}
            recent = (today - timedelta(days=7)).isoformat()
            exclude = state["item_id"] if action == "next" else -1
            choice = self.store.query_one("SELECT c.* FROM wr_collection c LEFT JOIN wr_collection_seen s ON s.item_id=c.id WHERE c.deleted=0 AND c.id!=? AND COALESCE(s.snoozed_until,'')<=? AND (s.last_day IS NULL OR s.last_day<=?) ORDER BY (s.last_day IS NOT NULL),s.last_day,c.id LIMIT 1", (exclude or -1, day, recent))
            self.store.execute("UPDATE wr_collection_resurface SET day=?,item_id=? WHERE id=1", (day, choice["id"] if choice else None))
            if not choice:
                return {"enabled": True, "item": None, "reason": "暂无未在近期展示的收藏"}
            self.store.execute("INSERT INTO wr_collection_seen(item_id,last_day,seen_count) VALUES(?,?,1) ON CONFLICT(item_id) DO UPDATE SET last_day=excluded.last_day,seen_count=wr_collection_seen.seen_count+1", (choice["id"], day))
            return {"enabled": True, "item": item(choice)}
