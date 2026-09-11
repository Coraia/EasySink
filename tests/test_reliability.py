"""Review regressions: transactional imports, typed feedback, selectors and durable jobs."""

import io
import json
import zipfile
from pathlib import Path
from unittest.mock import Mock
import pytest
from fastapi.testclient import TestClient
from wise_reader.app import create_app
from wise_reader.content import html_blocks, Anchor
from wise_reader.engine import Engine, text_hash
from wise_reader.jobs import Jobs, chunks
from wise_reader.l1 import validate
from wise_reader.store import Store
from wise_reader.tokenize import parse
from wise_reader.plugins.importer import parse_epub, MAX_EXPANDED


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setenv("WR_USER_DB", str(tmp_path / "user.db"))
    monkeypatch.setenv("WR_LLM_ENABLED", "false")
    with TestClient(create_app()) as client:
        yield client


def epub(
    count=81,
    href="../Text/chapter.xhtml",
    text="<h1>Heading</h1><p>A short chapter.</p>",
):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "META-INF/container.xml",
            '<container><rootfile full-path="OPS/Package/content.opf"/></container>',
        )
        z.writestr(
            "OPS/Package/content.opf",
            "<package><metadata><title>Full Book</title></metadata><manifest>"
            + "".join(f'<item id="c{i}" href="{href}"/>' for i in range(count))
            + "</manifest><spine>"
            + "".join(f'<itemref idref="c{i}"/>' for i in range(count))
            + "</spine></package>",
        )
        z.writestr("OPS/Text/chapter.xhtml", text)
    return out.getvalue()


def test_epub_81_chapters_relative_paths_and_structure(c):
    payload = epub()
    assert len(parse_epub(payload)[2]) == 81
    response = c.post("/api/import", files={"file": ("book.epub", payload)})
    assert response.status_code == 200, response.text
    assert len(response.json()["chapters"]) == 81
    d = c.get("/api/documents/" + str(response.json()["chapters"][0]["doc_id"])).json()
    assert d["blocks"][0]["type"] == "heading"
    assert d["blocks"][1]["text"] == "A short chapter."


def test_invalid_import_is_explicit_and_atomic(c, monkeypatch):
    assert (
        c.post("/api/import", files={"file": ("broken.epub", b"bad zip")}).status_code
        == 400
    )
    assert (
        c.post("/api/import", files={"file": ("binary.txt", b"\xff\xfe")}).status_code
        == 400
    )
    assert (
        c.post("/api/import", files={"file": ("huge.epub", epub(501))}).status_code
        == 400
    )
    original = c.app.state.engine.ingest
    calls = 0

    def fail(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ValueError("simulated parser failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(c.app.state.engine, "ingest", fail)
    with pytest.raises(ValueError):
        c.post("/api/import", files={"file": ("book.epub", epub(2))})
    assert c.get("/api/documents").json() == []
    assert c.get("/api/library/books").json() == []


def test_library_plugin_can_be_physically_unregistered(tmp_path, monkeypatch):
    import wise_reader.plugins.runtime as runtime

    monkeypatch.setenv("WR_USER_DB", str(tmp_path / "fresh.db"))
    monkeypatch.setenv("WR_LLM_ENABLED", "false")
    monkeypatch.setattr(
        runtime, "PLUGINS", tuple(p for p in runtime.PLUGINS if p.id != "library")
    )
    with TestClient(create_app()) as c:
        r = c.post(
            "/api/import",
            files={"file": ("works.txt", b"An independent importer works.")},
        )
        assert r.status_code == 200, r.text
        assert (
            c.get(
                "/api/documents/" + str(r.json()["chapters"][0]["doc_id"])
            ).status_code
            == 200
        )


def test_model_invalid_difficulty_does_not_crash_and_failed_cache_retries(
    lexicon, tmp_path
):
    d = parse("A grain of salt.")
    kept, raw, dropped = validate(
        {
            "annotations": [
                {
                    "first_token": 0,
                    "last_token": 3,
                    "kind": "phrase",
                    "note": "保留态度",
                    "difficulty": "hard",
                }
            ]
        },
        d,
    )
    assert kept == [] and dropped == 1
    llm = Mock()
    llm.model = "test-v1"
    llm.complete.side_effect = [TimeoutError(), {"annotations": []}]
    store = Store(tmp_path / "cache.db")
    engine = Engine(lexicon, store, llm, True)
    _, first = engine._l1(d, "same")
    _, second = engine._l1(d, "same")
    _, third = engine._l1(d, "same")
    assert first["failed"] and not second["cache_hit"] and third["cache_hit"]
    assert llm.complete.call_count == 2
    llm.model = "test-v2"
    llm.complete.side_effect = None
    llm.complete.return_value = {"annotations": []}
    assert not engine._l1(d, "same")[1]["cache_hit"]
    store.close()


def test_punctuation_semantic_rules_and_expression_feedback(c):
    assert ", " in parse("Let's eat, Grandma!").numbered_sentences()[0]
    assert (
        parse("Let's eat, Grandma!").numbered_sentences()
        != parse("Let's eat Grandma!").numbered_sentences()
    )
    c.patch("/api/profile", json={"density": 15, "vocab_size": 500})
    text = "Take this with a grain of salt. The election redistricting has raised concerns about voters."
    d = c.post("/api/documents", json={"text": text}).json()
    annos = [f for b in d["blocks"] for f in b["fragments"] if f["type"] == "anno"]
    phrase = next(a for a in annos if a["kind"] == "phrase")
    assert phrase["target"].startswith("phrase:")
    assert (
        c.post(
            "/api/feedback", json={"target": phrase["target"], "verdict": "known"}
        ).status_code
        == 200
    )
    after = c.get("/api/documents/" + str(d["id"])).json()
    assert not any(
        f.get("target") == phrase["target"]
        for b in after["blocks"]
        for f in b["fragments"]
    )
    assert (
        c.post("/api/feedback", json={"lemma": "", "verdict": "known"}).status_code
        == 400
    )
    assert (
        c.post(
            "/api/feedback", json={"target": "redistricting", "verdict": "unknown"}
        ).status_code
        == 200
    )
    d = c.get("/api/documents/" + str(d["id"])).json()
    assert any(f.get("note") == "重划选区" for b in d["blocks"] for f in b["fragments"])


def test_forced_function_word_and_zero_density(c):
    c.post("/api/feedback", json={"lemma": "be", "verdict": "unknown"})
    d = c.post("/api/documents", json={"text": "This is a short sentence."}).json()
    assert any(f.get("lemma") == "be" for b in d["blocks"] for f in b["fragments"])
    d = c.get("/api/documents/" + str(d["id"]), params={"density": 0}).json()
    assert d["forced_count"] >= 1


def test_stable_blocks_shared_anchors_and_archive_keeps_notes(c):
    d = c.post(
        "/api/documents", json={"text": "First paragraph.\n\nSecond paragraph."}
    ).json()
    anchor = {
        "version": d["version"],
        "block_id": d["blocks"][1]["id"],
        "start": 0,
        "end": 6,
        "quote": "Second",
        "ratio": 0.4,
    }
    note = c.post(
        "/api/notes",
        json={
            "doc_id": d["id"],
            "body": "An idea",
            "quote": "Second",
            "anchor": anchor,
        },
    ).json()
    assert note["anchor"]["block_id"] == anchor["block_id"]
    c.put(
        f"/api/documents/{d['id']}/progress",
        json={"scroll_ratio": 0.4, "anchor": anchor},
    )
    assert (
        c.get(f"/api/documents/{d['id']}/progress").json()["anchor"]["quote"]
        == "Second"
    )
    c.patch("/api/plugins/progress", json={"enabled": False})
    b = c.post("/api/bookmarks", json={"doc_id": d["id"], "anchor": anchor}).json()
    assert b["anchor"]["block_id"] == anchor["block_id"]
    c.post(f"/api/documents/{d['id']}/archive")
    assert c.get("/api/documents").json()[0]["archived"]
    assert c.get("/api/notes").json()[0]["body"] == "An idea"
    c.post(f"/api/documents/{d['id']}/restore")
    assert not c.get("/api/documents").json()[0]["archived"]


def test_vocab_rejects_fake_and_duplicate_is_idempotent(c):
    q = c.post("/api/vocab-test/start").json()
    body = {"session": q["session"], "word": "not-the-question", "known": True}
    assert c.post("/api/vocab-test/answer", json=body).status_code == 409
    body["word"] = q["question"]["word"]
    first = c.post("/api/vocab-test/answer", json=body).json()
    second = c.post("/api/vocab-test/answer", json=body).json()
    assert first == second


def test_jobs_resume_only_unfinished_chunks(c):
    store = c.app.state.store
    engine = c.app.state.engine
    engine.l1_enabled = True
    # Worker isolated from the lifecycle's queue by stopping it before deterministic process calls.
    c.app.state.jobs.close()
    jobs = Jobs(store, engine)
    llm = Mock()
    engine.llm = llm
    text = "long paragraph " * 400
    parts = list(chunks(text))
    assert max(map(len, parts)) <= 1400
    d = c.post("/api/documents", json={"text": text}).json()
    llm.chat.side_effect = ["first translated chunk", TimeoutError()]
    row = jobs.enqueue([d["id"]])
    jobs.process(store.query_one("SELECT * FROM wr_job WHERE id=?", (row["id"],)))
    failed = store.query_one("SELECT * FROM wr_job WHERE id=?", (row["id"],))
    assert failed["status"] == "failed" and failed["cursor"] == 1
    jobs.control(row["id"], "retry")
    llm.chat.side_effect = None
    llm.chat.return_value = "next translated chunk"
    jobs.process(store.query_one("SELECT * FROM wr_job WHERE id=?", (row["id"],)))
    done = store.query_one("SELECT * FROM wr_job WHERE id=?", (row["id"],))
    assert done["status"] == "complete"
    assert llm.chat.call_count == len(parts) + 1
    tr = c.get(f"/api/documents/{d['id']}/translation").json()
    assert tr["body"].startswith("first translated chunk")
    pending = jobs.enqueue([d["id"]])
    jobs.control(pending["id"], "cancel")
    jobs.process(store.query_one("SELECT * FROM wr_job WHERE id=?", (pending["id"],)))
    assert (
        store.query_one("SELECT * FROM wr_job WHERE id=?", (pending["id"],))["status"]
        == "cancelled"
    )


def test_untrusted_html_is_inert_and_retains_semantic_blocks():
    blocks = html_blocks(
        "<head><title>secret</title></head><h1>Title</h1><p>Hello <strong>world</strong>.</p><script>alert(1)</script><ul><li>One</li></ul><pre>x = 1\nprint(x)</pre>"
    )
    assert [b["type"] for b in blocks] == ["heading", "paragraph", "list-item", "code"]
    assert "alert" not in str(blocks)
    assert blocks[-1]["text"] == "x = 1\nprint(x)"


def test_note_retry_is_idempotent(c):
    doc = c.post("/api/documents", json={"text": "Read and remember."}).json()
    body = {"doc_id": doc["id"], "body": "First draft", "client_id": "unique-draft"}
    first = c.post("/api/notes", json=body).json()
    body["body"] = "Newest draft"
    second = c.post("/api/notes", json=body).json()
    assert first["id"] == second["id"]
    notes = c.get("/api/notes").json()
    assert len(notes) == 1 and notes[0]["body"] == "Newest draft"
