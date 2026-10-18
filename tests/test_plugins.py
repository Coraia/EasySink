"""插件开关、导入、笔记、登录门闩。"""

from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from wise_reader.app import create_app
from wise_reader.settings import Settings


def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("WR_USER_DB", str(tmp_path / "user.db"))
    monkeypatch.setenv("WR_LLM_ENABLED", "false")
    return TestClient(create_app())


def tiny_epub() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>""",
        )
        z.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="u" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Demo Book</dc:title>
    <dc:creator>Anon</dc:creator>
    <dc:identifier id="u">demo</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>""",
        )
        z.writestr(
            "OEBPS/c1.xhtml",
            """<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>The ubiquitous serendipity of photosynthesis is rare in ordinary life around us.</p>
</body></html>""",
        )
    return buf.getvalue()


def test_current_plugin_catalog(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    data = c.get("/api/plugins").json()
    ids = [p["id"] for p in data["plugins"]]
    assert ids == [
        "auth", "library", "importer", "pdf", "immersive", "notes",
        "collections", "translate", "grammar", "bookmarks", "progress",
        "export", "tts", "theme", "typography", "search", "stats",
        "evidence", "shortcuts",
    ]
    assert all(p["enabled"] for p in data["plugins"])


def test_toggle_hides_api(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    doc = c.post("/api/documents", json={"text": "Hello ubiquitous world.", "title": "t"}).json()
    note = c.post("/api/notes", json={"doc_id": doc["id"], "body": "remember", "quote": "Hello"}).json()
    assert note["id"]
    c.patch("/api/plugins/notes", json={"enabled": False})
    off = c.post("/api/notes", json={"doc_id": doc["id"], "body": "nope"})
    assert off.status_code == 404
    c.patch("/api/plugins/notes", json={"enabled": True})
    on = c.post("/api/notes", json={"doc_id": doc["id"], "body": "again"})
    assert on.status_code == 200


def test_unavailable_evidence_can_be_disabled_without_blocking_reading(tmp_path, monkeypatch):
    # Exercise a real SQLite open failure, while keeping all files disposable.
    # Optional startup failure must preserve reading, and repeated disable must
    # persist the flag without assuming that the evidence service was created.
    (tmp_path / "user.evidence.sqlite3").mkdir()
    monkeypatch.setenv("WR_PDF_DATA_DIR", str(tmp_path / "user-pdf"))
    monkeypatch.setenv("WR_NATIVE_TRACKPAD", "0")
    app = create_app(Settings(_env_file=None, wr_user_db=str(tmp_path / "user.db"),
                              wr_llm_enabled=False, wr_llm_api_key=""))
    with TestClient(app, raise_server_exceptions=False) as c:
        assert not hasattr(app.state, "evidence")
        assert c.get("/api/profile").status_code == 200
        assert c.get("/api/evidence/status").status_code == 404
        for _ in range(2):
            result = c.patch("/api/plugins/evidence", json={"enabled": False})
            assert result.status_code == 200, result.text
            evidence = next(p for p in result.json()["plugins"] if p["id"] == "evidence")
            assert evidence["enabled"] is False
            assert c.get("/api/profile").status_code == 200
        assert app.state.store.plugin_flags()["evidence"] is False


def test_epub_import_and_library(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    r = c.post("/api/import", files={"file": ("demo.epub", tiny_epub(), "application/epub+zip")})
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["title"] == "Demo Book"
    assert payload["chapters"]
    books = c.get("/api/library/books").json()
    assert books[0]["id"] == payload["book_id"]
    assert books[0]["chapter_count"] >= 1
    doc_id = payload["chapters"][0]["doc_id"]
    shown = c.get(f"/api/documents/{doc_id}").json()
    assert shown["word_count"] > 0


def test_auth_locks_after_register(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    assert c.get("/api/profile").status_code == 200
    r = c.post("/api/auth/register", json={"username": "fish", "password": "secret"})
    assert r.status_code == 200
    other = TestClient(create_app())
    locked = other.get("/api/profile")
    assert locked.status_code == 401
    assert other.get("/api/plugins").status_code == 200
    assert other.patch("/api/plugins/notes", json={"enabled": False}).status_code == 401
    login = other.post("/api/auth/login", json={"username": "fish", "password": "secret"})
    assert login.status_code == 200
    assert other.get("/api/profile").status_code == 200
    assert other.patch("/api/plugins/notes", json={"enabled": False}).status_code == 200


def test_delete_source_preserves_notes_and_clears_navigation(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    doc = c.post("/api/documents", json={"text": "Hello ubiquitous serendipity.", "title": "x"}).json()
    note = c.post("/api/notes", json={"doc_id": doc["id"], "body": "keep my thought", "quote": "ubiquitous"}).json()
    c.post("/api/bookmarks", json={"doc_id": doc["id"], "label": "here"})
    c.put(f"/api/documents/{doc['id']}/progress", json={"scroll_ratio": 0.5})
    assert c.delete(f"/api/documents/{doc['id']}").status_code == 200
    assert c.get(f"/api/documents/{doc['id']}").status_code == 404
    retained = c.get("/api/notes").json()
    assert len(retained) == 1
    assert retained[0]["id"] == note["id"]
    assert retained[0]["body"] == "keep my thought"
    assert retained[0]["quote"] == "ubiquitous"
    assert retained[0]["title"] == "x"
    assert retained[0]["source_available"] is False
    snapshot = json.loads(retained[0]["source_snapshot"])
    assert snapshot["title"] == "x"
    assert snapshot["quote"] == "ubiquitous"
    assert snapshot["source_identity"]["text_sha256"]
    assert c.get("/api/bookmarks").json() == []
    assert c.get("/api/progress").json() == []


def test_progress_bookmarks_export_stats(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    doc = c.post("/api/documents", json={"text": "Hello ubiquitous serendipity.", "title": "x"}).json()
    assert c.put(f"/api/documents/{doc['id']}/progress", json={"scroll_ratio": 0.4}).status_code == 200
    latest = c.get("/api/progress").json()
    assert latest[0]["doc_id"] == doc["id"]
    bm = c.post("/api/bookmarks", json={"doc_id": doc["id"], "label": "mid", "scroll_ratio": 0.4}).json()
    assert bm["id"]
    assert c.get("/api/bookmarks").json()[0]["label"] == "mid"
    csv = c.get("/api/export/vocab.csv")
    assert csv.status_code == 200
    assert "lemma,verdict" in csv.text
    hb = c.post("/api/stats/heartbeat", json={"doc_id": doc["id"], "seconds": 15})
    assert hb.status_code == 200
    stats = c.get("/api/stats").json()
    assert stats["seconds"] >= 15
    tr = c.put(
        f"/api/documents/{doc['id']}/translation",
        json={"lang": "zh", "body": "你好", "generate": False},
    )
    assert tr.status_code == 200
    got = c.get(f"/api/documents/{doc['id']}/translation").json()
    assert got["body"] == "你好"
    gen = c.put(
        f"/api/documents/{doc['id']}/translation",
        json={"lang": "zh", "generate": True},
    )
    assert gen.status_code == 400


def test_frontend_plugin_files(tmp_path, monkeypatch):
    from wise_reader.plugins.catalog import PLUGINS
    from wise_reader.settings import ROOT

    c = client(tmp_path, monkeypatch)
    page = c.get("/")
    assert 'href="#/labs"' in page.text
    asset = re.search(r'href="(/assets/[0-9a-f]{16})/plugin-host\.js"', page.text)
    assert asset, page.text
    prefix = asset[1]
    assert f'src="{prefix}/app.js?' in page.text
    assert c.get(f"{prefix}/plugin-host.js").status_code == 200
    assert "renderLabs" in c.get(f"{prefix}/app.js").text
    # Cached clients still use the unversioned alias.
    assert c.get("/static/plugin-host.js").status_code == 200
    assert "renderLabs" in c.get("/static/app.js").text
    for spec in PLUGINS:
        js = ROOT / "web" / "plugins" / f"{spec.id}.js"
        assert js.is_file(), spec.id
        assert c.get(f"{prefix}/plugins/{spec.id}.js").status_code == 200
        assert c.get(f"/static/plugins/{spec.id}.js").status_code == 200
