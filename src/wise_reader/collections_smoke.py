"""Reproducible isolated API walkthrough, always on disposable databases.

Run: PYTHONPATH=src .venv/bin/python -m wise_reader.collections_smoke
Failure classes are recorded in docs/parallel/v11-records-status.md before this
helper was written. This is API smoke evidence, not device/model acceptance.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import traceback
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from wise_reader import content
from wise_reader.collections import migrate
from wise_reader.collections_source import utf16
from wise_reader.plugins import collections as plugin
from wise_reader.plugins.notes import migrate as notes_migrate
from wise_reader.reading_assist import migrate as assist_migrate
from wise_reader.store import Store


def run():
    root = Path(tempfile.mkdtemp(prefix="wise-collections-api-"))
    evidence = root / "transcript.jsonl"
    checks = 0
    stores = []

    def log(value):
        with evidence.open("a") as handle:
            handle.write(json.dumps(value, ensure_ascii=False) + "\n")

    def setup(name):
        store = Store(root / (name + ".db"))
        stores.append(store)
        migrate(store)
        notes_migrate(store)
        assist_migrate(store)
        app = FastAPI()
        app.state.store = store
        plugin.register(app, SimpleNamespace(store=store, engine=SimpleNamespace(lexicon=None)))
        return store, TestClient(app)

    def request(client, method, path, body=None, expected=200):
        nonlocal checks
        result = client.request(method, "/api/collections" + path, json=body) if body is not None else client.request(method, "/api/collections" + path)
        try:
            response = result.json()
        except ValueError:
            response = result.text
        log({"method": method, "path": path, "request": body, "status": result.status_code, "response": response})
        assert result.status_code == expected, (path, result.status_code, response)
        checks += 1
        return response

    def doc(store, text, title="Chapter", book=None):
        doc_id = store.save_document(title, text, len(text.split()), hashlib.sha256("\n".join(line.rstrip() for line in text.replace("\r\n", "\n").split("\n")).encode()).hexdigest(), [], [])
        version, blocks = content.put_content(store, doc_id, text)
        if book:
            content.add_chapter(store, book, 0, title, doc_id)
        return doc_id, version, blocks

    try:
        store, client = setup("source")
        book = content.add_book(store, "A source book", "Reader")
        d, version, blocks = doc(store, "Alpha 😀 beta gamma delta epsilon zeta.\nSecond paragraph here.\nThird paragraph here.", book=book)

        def anchor(start, end, block=0):
            text = blocks[block]["text"]
            return {"version": version, "block_id": blocks[block]["id"], "start": utf16(text[:start]), "end": utf16(text[:end]), "quote": text[start:end]}

        def save(start, end, kind="excerpt"):
            return request(client, "POST", "", {"doc_id": d, "kind": kind, "anchor": anchor(start, end), "book_id": 999999})

        first = save(0, 5)
        assert first["item"]["book_id"] == book
        duplicate = save(0, 5)
        assert duplicate["item"]["id"] == first["item"]["id"] and duplicate["undo_token"] is None
        bad = anchor(0, 5)
        bad["quote"] = "forged"
        request(client, "POST", "", {"doc_id": d, "kind": "word", "anchor": bad}, 409)
        split = anchor(6, 7)
        split["end"] -= 1
        request(client, "POST", "", {"doc_id": d, "kind": "word", "anchor": split}, 400)
        stale = {**anchor(0, 5), "version": "missing-version"}
        request(client, "POST", "", {"doc_id": d, "kind": "word", "anchor": stale}, 409)
        word = save(0, 5, "word")["item"]
        edited = request(client, "PATCH", f"/{first['item']['id']}", {"my_meaning": "Original subrange meaning", "expected_revision": first["item"]["revision"]})
        second = save(8, 12)
        union = save(3, 10)
        assert union["item"]["quote"] == blocks[0]["text"][:12]
        assert second["item"]["id"] in union["merged_ids"]
        assert any(s.get("my_meaning") == "Original subrange meaning" for s in union["item"]["subranges"])
        state = request(client, "GET", f"/state/{d}")
        assert len(state["items"]) == 2 and not state["feedback"]
        request(client, "POST", "/undo", {"token": edited["undo_token"]}, 409)
        restored = request(client, "POST", "/undo", {"token": union["undo_token"]})
        assert len(restored["items"]) == 2
        request(client, "POST", "/undo", {"token": union["undo_token"]}, 409)
        touching = save(12, 18)
        assert touching["merged_ids"] == []
        union = save(3, 14)
        assert len(union["merged_ids"]) == 2
        assert request(client, "GET", "?kind=word")["total"] == 1
        assert request(client, "GET", f"?book_id={book}&limit=1")["total"] == 2

        # Continuous cross-paragraph anchor, plus discontinuous rejection.
        p0 = anchor(20, len(blocks[0]["text"]))
        p1 = anchor(0, 6, 1)
        cross = {**p0, "quote": p0["quote"] + "\n\n" + p1["quote"], "segments": [p0, p1]}
        multi = request(client, "POST", "", {"doc_id": d, "kind": "excerpt", "anchor": cross})
        invalid = {**cross, "segments": [p0, anchor(0, 6, 2)]}
        request(client, "POST", "", {"doc_id": d, "kind": "excerpt", "anchor": invalid}, 400)

        # Feedback omitted fields, independent legacy verdicts, and no-prior undo.
        store.set_verdict("alpha", "unknown", "smoke")
        f1 = request(client, "POST", "/feedback", {"doc_id": d, "anchor": anchor(0, 5), "retained": True, "note": "retained detail"})
        f2 = request(client, "POST", "/feedback", {"doc_id": d, "anchor": anchor(0, 5), "understood": True})
        assert f2["state"]["retained"] and f2["state"]["note"] == "retained detail"
        request(client, "POST", "/undo", {"token": f2["undo_token"]})
        feedback = request(client, "GET", f"/state/{d}")["feedback"][0]
        assert feedback["understood"] is None and feedback["retained"]
        assert store.query_one("SELECT verdict FROM word_verdict WHERE lemma='alpha'")["verdict"] == "unknown"
        fresh = request(client, "POST", "/feedback", {"doc_id": d, "anchor": anchor(8, 12), "understood": True})
        request(client, "POST", "/undo", {"token": fresh["undo_token"]})
        assert len(request(client, "GET", f"/state/{d}")["feedback"]) == 1

        # Valid persisted assist adoption; provider never invoked.
        target = {**word["anchor"], "ratio": 0.5}
        def assist(meaning, aid, doc_id=d):
            return store.execute("INSERT INTO wr_assist(doc_id,version,kind,identity,anchor,payload,source,created_at) VALUES(?,?,?,?,?,?,?,?)", (doc_id, version, "context", aid, json.dumps(target), json.dumps({"meaning": meaning, "explanation": "Persisted API smoke fixture"}), "synthetic stored assist", "2026-10-11")).lastrowid
        a1, a2 = assist("first meaning", "assist-one"), assist("second meaning", "assist-two")
        request(client, "PATCH", f"/{word['id']}", {"adopt_assist_id": a1})
        adopted = request(client, "PATCH", f"/{word['id']}", {"adopt_assist_id": a2})
        assert len(adopted["item"]["explanation_history"]) == 1 and adopted["item"]["quote"] == "Alpha"
        subset = request(client, "PATCH", f"/{union['item']['id']}", {"adopt_assist_id": a1})
        assert subset["item"]["explanation"] is None
        assert any(s.get("explanation", {}).get("assist_id") == a1 for s in subset["item"]["subranges"] if s.get("explanation"))
        request(client, "PATCH", f"/{multi['item']['id']}", {"adopt_assist_id": a1}, 409)
        request(client, "PATCH", f"/{word['id']}", {"expected_revision": 1, "my_meaning": "stale"}, 409)

        note_id = store.execute("INSERT INTO wr_note(doc_id,quote,body,created_at) VALUES(?,?,?,?)", (d, "Alpha", "Independent note", "2026-10-11")).lastrowid
        content.save_anchor(store, "note", note_id, d, content.Anchor.model_validate(target))
        removed = request(client, "DELETE", f"/{word['id']}")
        assert store.query_one("SELECT body FROM wr_note WHERE id=?", (note_id,))
        # Restart the real Store, remount routes, then undo.
        store.close()
        stores.remove(store)
        store = Store(root / "source.db")
        stores.append(store)
        migrate(store)
        app = FastAPI()
        app.state.store = store
        plugin.register(app, SimpleNamespace(store=store, engine=SimpleNamespace(lexicon=None)))
        client = TestClient(app)
        request(client, "POST", "/undo", {"token": removed["undo_token"]})
        source = request(client, "GET", f"/{word['id']}/source")
        assert source["available"] and source["doc_id"] == d
        export = request(client, "POST", "/export", {"book_id": book, "collections": True, "notes": True, "feedback": True})
        md = request(client, "POST", "/export", {"book_id": book, "format": "markdown", "notes": True})
        assert "Independent note" in md and "Original subrange meaning" in md
        same_import = request(client, "POST", "/import", {"data": export})
        assert same_import["duplicates"] == len(export["collections"]) + len(export["feedback"]) + len(export["notes"])
        assert store.query_one("SELECT COUNT(*) AS n FROM wr_note")["n"] == 1

        # Destination numeric IDs deliberately collide with unrelated text.
        other, dest = setup("destination")
        unrelated, _, _ = doc(other, "Unrelated source with the same numeric ID.")
        assert unrelated == d
        missing = request(dest, "POST", "/import", {"data": export})
        assert missing["unresolved"] == missing["imported"]
        imported = request(dest, "GET", "")["items"]
        for saved in imported:
            assert saved["doc_id"] is None
            assert not request(dest, "GET", f"/{saved['id']}/source")["available"]
        again = request(dest, "POST", "/import", {"data": export})
        assert again["imported"] == 0
        bad_export = json.loads(json.dumps(export))
        bad_export["collections"].append({"uid": "bad"})
        request(dest, "POST", "/import", {"data": bad_export}, 422)
        assert request(dest, "GET", "")["total"] == len(imported)
        exact, exact_client = setup("exact-destination")
        doc(exact, "unrelated first")
        copy_book = content.add_book(exact, "A source book", "Reader")
        copy_doc, _, _ = doc(exact, store.get_document(d)["text"], book=copy_book)
        imported_exact = request(exact_client, "POST", "/import", {"data": export})
        assert imported_exact["unresolved"] == 0
        for saved in request(exact_client, "GET", "")["items"]:
            assert saved["doc_id"] == copy_doc
            assert request(exact_client, "GET", f"/{saved['id']}/source")["available"]
        assert request(exact_client, "POST", "/import", {"data": export})["imported"] == 0

        # Unavailable restores still permit record-scoped export and independent cleanup.
        orphan_word = next(r for r in imported if r["kind"] == "word")
        orphan_export = request(dest, "POST", "/export", {"ids": [orphan_word["id"]], "notes": True, "feedback": True})
        assert len(orphan_export["notes"]) == 1 and len(orphan_export["feedback"]) == 1
        orphan_clean = request(dest, "POST", "/cleanup", {"ids": [orphan_word["id"]], "notes": True, "feedback": True, "confirm": True})
        assert orphan_clean["removed"] == {"collections": 0, "notes": 1, "feedback": 1}
        assert request(dest, "GET", "")["total"] == len(imported)

        # Same-ID / same-quote UID conflict must roll back earlier records in the batch.
        conflict = json.loads(json.dumps(export))
        conflict["notes"], conflict["feedback"] = [], []
        new = json.loads(json.dumps(conflict["collections"][0]))
        new["uid"] = "new-import-before-conflict"
        new["source_identity"]["document_title"] = "Different preserved source"
        conflict["collections"][0]["source_identity"]["document_title"] = "Forged conflicting origin"
        conflict["collections"].insert(0, new)
        before_count = request(exact_client, "GET", "")["total"]
        request(exact_client, "POST", "/import", {"data": conflict}, 409)
        assert request(exact_client, "GET", "")["total"] == before_count

        # Production engine hashes normalize trailing whitespace; source hashes do not.
        normalized, normalized_client = setup("normalized")
        nd, nv, nb = doc(normalized, "Trailing spaces here.  \nSecond line.\r\n", title="Whitespace")
        na = {"version": nv, "block_id": nb[0]["id"], "start": 0, "end": 8, "quote": "Trailing"}
        request(normalized_client, "POST", "", {"doc_id": nd, "kind": "word", "anchor": na})
        normalized_export = request(normalized_client, "POST", "/export", {})
        normalized_copy, normalized_copy_client = setup("normalized-copy")
        doc(normalized_copy, "unrelated")
        doc(normalized_copy, normalized.get_document(nd)["text"], title="Whitespace")
        assert request(normalized_copy_client, "POST", "/import", {"data": normalized_export})["unresolved"] == 0
        # A second indistinguishable source makes import conservatively unavailable.
        ambiguous, ambiguous_client = setup("ambiguous")
        for _ in range(2):
            doc(ambiguous, normalized.get_document(nd)["text"], title="Whitespace")
        assert request(ambiguous_client, "POST", "/import", {"data": normalized_export})["unresolved"] == 1

        # PDF revision fixtures exercise the real snapshot and resolution paths, not OCR.
        pdf, pdf_client = setup("pdf-revisions")
        pdf.executescript("""
        CREATE TABLE wr_pdf_book(book_id INTEGER PRIMARY KEY,source_sha256 TEXT,lifecycle TEXT);
        CREATE TABLE wr_pdf_revision(doc_id INTEGER,revision TEXT,title TEXT,text TEXT,blocks TEXT,retained_at TEXT,PRIMARY KEY(doc_id,revision));
        """)
        pb = content.add_book(pdf, "PDF fixture")
        pdf.execute("INSERT INTO wr_pdf_book VALUES(?,?,?)", (pb, "a" * 64, "active"))
        pd, pv, pblocks = doc(pdf, "Prefix alpha suffix.", title="PDF Chapter", book=pb)
        pa = {"version": pv, "block_id": pblocks[0]["id"], "start": 7, "end": 12, "quote": "alpha"}
        original = request(pdf_client, "POST", "", {"doc_id": pd, "kind": "word", "anchor": pa})
        pdf.execute("INSERT INTO wr_pdf_revision VALUES(?,?,?,?,?,?)", (pd, pv, "PDF Chapter", "Prefix alpha suffix.", json.dumps(pblocks), "2026-10-11"))
        new_text = "Prefix alpha suffix.\nNew recognized paragraph."
        pdf.execute("UPDATE document SET text=?,text_hash=? WHERE id=?", (new_text, hashlib.sha256(new_text.encode()).hexdigest(), pd))
        content.put_content(pdf, pd, new_text)
        historical = request(pdf_client, "GET", f"/{original['item']['id']}/source")
        assert historical["available"] and historical["historical"]
        retained_save = request(pdf_client, "POST", "", {"doc_id": pd, "kind": "excerpt", "anchor": pa})
        assert retained_save["item"]["anchor"]["version"] == pv
        repeated = "Prefix alpha suffix.\nPrefix alpha suffix."
        pdf.execute("UPDATE document SET text=?,text_hash=? WHERE id=?", (repeated, hashlib.sha256(repeated.encode()).hexdigest(), pd))
        content.put_content(pdf, pd, repeated)
        assert not request(pdf_client, "GET", f"/{original['item']['id']}/source")["available"]
        pdf.execute("UPDATE wr_pdf_book SET lifecycle='recycled'")
        assert not request(pdf_client, "GET", f"/{original['item']['id']}/source")["available"]

        # Delete/overlap and delete/recreate ABA cannot be overwritten by old undo.
        guard, guard_client = setup("guard")
        gd, gv, gb = doc(guard, "abcdefghij klmnopqrst uvwxyz")
        def ga(a, b):
            return {"version": gv, "block_id": gb[0]["id"], "start": a, "end": b, "quote": gb[0]["text"][a:b]}
        g = request(guard_client, "POST", "", {"doc_id": gd, "kind": "excerpt", "anchor": ga(0, 10)})
        deletion = request(guard_client, "DELETE", f"/{g['item']['id']}")
        request(guard_client, "POST", "", {"doc_id": gd, "kind": "excerpt", "anchor": ga(4, 15)})
        request(guard_client, "POST", "/undo", {"token": deletion["undo_token"]}, 409)
        gw = request(guard_client, "POST", "", {"doc_id": gd, "kind": "word", "anchor": ga(0, 3)})
        gm = request(guard_client, "PATCH", f"/{gw['item']['id']}", {"my_meaning": "Survives cancellation"})
        gone = request(guard_client, "DELETE", f"/{gw['item']['id']}")
        back = request(guard_client, "POST", "", {"doc_id": gd, "kind": "word", "anchor": ga(0, 3)})
        assert back["item"]["my_meaning"] == "Survives cancellation"
        request(guard_client, "POST", "/undo", {"token": gone["undo_token"]}, 409)
        request(guard_client, "POST", "/cleanup", {"ids": [gw["item"]["id"]], "collections": True, "confirm": True})
        request(guard_client, "POST", "/undo", {"token": gm["undo_token"]}, 409)
        assert guard.query_one("SELECT COUNT(*) AS n FROM wr_collection_undo_touch WHERE token=?", (gm["undo_token"],))["n"] == 0

        pick = request(client, "GET", "/resurface")
        assert pick["item"] == request(client, "GET", "/resurface")["item"]
        hidden = request(client, "POST", "/resurface", {"action": "hide"})
        assert not hidden["enabled"] and not request(client, "GET", "/resurface")["enabled"]
        store.close()
        stores.remove(store)
        store = Store(root / "source.db")
        stores.append(store)
        migrate(store)
        app = FastAPI()
        app.state.store = store
        plugin.register(app, SimpleNamespace(store=store, engine=SimpleNamespace(lexicon=None)))
        client = TestClient(app)
        assert not request(client, "GET", "/resurface")["enabled"]
        shown = request(client, "POST", "/resurface", {"action": "show"})
        assert shown["item"]["id"] == pick["item"]["id"]
        next_pick = request(client, "POST", "/resurface", {"action": "next"})
        assert next_pick["item"]["id"] != pick["item"]["id"]
        request(client, "POST", "/resurface", {"action": "snooze", "id": next_pick["item"]["id"]})
        assert store.query_one("SELECT snoozed_until FROM wr_collection_seen WHERE item_id=?", (next_pick["item"]["id"],))["snoozed_until"]
        store.set_plugin_enabled("collections", False)
        request(client, "GET", "", expected=404)
        store.set_plugin_enabled("collections", True)
        assert request(client, "GET", "")["total"] == 3
        request(client, "POST", "/cleanup", {"collections": True, "confirm": True}, 400)
        request(client, "POST", "/cleanup", {"book_id": book, "collections": True}, 400)
        clean = request(client, "POST", "/cleanup", {"ids": [word["id"]], "collections": True, "confirm": True})
        assert clean["removed"] == {"collections": 1, "notes": 0, "feedback": 0}
        assert store.query_one("SELECT body FROM wr_note WHERE id=?", (note_id,))
        assert len(request(client, "GET", f"/state/{d}")["feedback"]) == 1
        clean = request(client, "POST", "/cleanup", {"book_id": book, "feedback": True, "confirm": True})
        assert clean["removed"]["feedback"] == 2
        assert store.get_document(d)
        store.delete_document(d)
        assert not request(client, "GET", f"/{multi['item']['id']}/source")["available"]
        assert request(client, "GET", "")["total"] == 2
        log({"result": "passed", "api_checks": checks, "scope": "temporary SQLite, production collection routes, synthetic content/persisted assist; no provider/browser/device"})
        print(json.dumps({"result": "passed", "api_checks": checks, "evidence": str(evidence)}, indent=2))
    except BaseException:
        log({"result": "failed", "api_checks": checks, "traceback": traceback.format_exc()})
        print(json.dumps({"result": "failed", "api_checks": checks, "evidence": str(evidence)}, indent=2))
        raise
    finally:
        for store in stores:
            store.close()


if __name__ == "__main__":
    run()
