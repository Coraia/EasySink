"""Observable contracts for URL article import, offline assets, and deletion."""

from __future__ import annotations

import io
import uuid
from contextlib import contextmanager

from fastapi.testclient import TestClient
from PIL import Image

from wise_reader import url_transport
from wise_reader.app import create_app


@contextmanager
def url_client(monkeypatch=None, fetcher=None):
    """Create a local-origin TestClient and optionally mock url_transport.fetch."""
    if monkeypatch is not None and fetcher is not None:
        monkeypatch.setattr(url_transport, "fetch", fetcher)
    with TestClient(create_app(), base_url="http://127.0.0.1:8766") as c:
        lib = c.get("/api/import/url/identity")
        assert lib.status_code == 200, lib.text
        headers = {
            "Origin": "http://127.0.0.1:8766",
            "X-WR-Library-ID": lib.json()["library_id"],
        }
        yield c, headers


def sample_png() -> bytes:
    """Return a valid tiny PNG image in memory."""
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color=(20, 90, 160)).save(buf, format="PNG")
    return buf.getvalue()


SAMPLE_HTML = (
    "<!doctype html><html><head><title>Demo</title></head><body><article>"
    "<h1>Clean Article</h1>"
    "<p>The ubiquitous serendipity of reading offline.</p>"
    '<figure><img src="/diagram.png" alt="Sample diagram"/><figcaption>Figure one.</figcaption></figure>'
    "</article></body></html>"
).encode("utf-8")


def test_url_policy_and_approval_gate(monkeypatch):
    def unexpected_fetch(*_args, **_kwargs):
        raise AssertionError("fetch must not run without explicit approval")

    with url_client(monkeypatch, unexpected_fetch) as (c, headers):
        builtin = c.post(
            "/api/import/url/policy",
            headers=headers,
            json={"url": "https://simonwillison.net/2026/demo/"},
        )
        assert builtin.status_code == 200
        assert builtin.json()["builtin"] is True
        assert builtin.json()["rule"] == "simon-willison"

        external = c.post(
            "/api/import/url/policy",
            headers=headers,
            json={"url": "https://example.com/post"},
        )
        assert external.status_code == 200
        assert external.json()["builtin"] is False
        assert external.json()["rule"] is None

        blocked = c.post(
            "/api/import/url",
            headers=headers,
            json={"request_id": str(uuid.uuid4()), "url": "https://example.com/post"},
        )
        assert blocked.status_code == 403


def test_url_import_html_with_image_and_offline_readback(monkeypatch):
    png = sample_png()
    page_url = "https://simonwillison.net/2026/demo/"
    img_url = "https://simonwillison.net/diagram.png"

    def fake_fetch(url, kind, _control, **_kwargs):
        if kind == "html" and url == page_url:
            return url_transport.Fetched(url, url, SAMPLE_HTML, "text/html", ())
        if kind == "image" and url == img_url:
            return url_transport.Fetched(url, url, png, "image/png", ())
        raise AssertionError(f"unexpected fetch: {kind} {url}")

    with url_client(monkeypatch, fake_fetch) as (c, headers):
        request_id = str(uuid.uuid4())
        res = c.post(
            "/api/import/url",
            headers=headers,
            json={"request_id": request_id, "url": page_url},
        )
        assert res.status_code == 200, res.text
        receipt = res.json()
        assert receipt["state"] == "committed"
        assert receipt["reused"] is False
        assert receipt["source"]["final_url"] == page_url
        doc_id = receipt["doc_id"]
        snapshot_id = receipt["snapshot_id"]

        listed = c.get("/api/documents").json()
        assert any(d["id"] == doc_id and d["title"] == "Clean Article" for d in listed)

        doc = c.get(f"/api/documents/{doc_id}")
        assert doc.status_code == 200
        blocks = doc.json()["blocks"]
        texts = "\n".join(b["text"] for b in blocks)
        assert "Clean Article" in texts
        assert "ubiquitous serendipity" in texts
        img_block = next(b for b in blocks if b["type"] == "image")
        asset_id = img_block["asset_id"]

        asset = c.get(f"/api/import/url/snapshots/{snapshot_id}/assets/{asset_id}")
        assert asset.status_code == 200
        assert asset.headers["content-type"].startswith("image/png")
        assert asset.content.startswith(b"\x89PNG\r\n\x1a\n")

        status = c.get(f"/api/import/url/requests/{request_id}", headers=headers)
        assert status.status_code == 200
        assert status.json()["state"] == "committed"
        assert status.json()["doc_id"] == doc_id
        assert status.json()["snapshot_id"] == snapshot_id


def test_url_import_request_idempotency_and_content_reuse(monkeypatch):
    page_url = "https://simonwillison.net/2026/demo/"
    html = (
        "<!doctype html><html><body><article>"
        "<h1>Repeated Import</h1><p>Idempotent offline snapshot text.</p>"
        "</article></body></html>"
    ).encode("utf-8")
    calls = 0

    def fake_fetch(url, kind, _control, **_kwargs):
        nonlocal calls
        calls += 1
        assert kind == "html" and url == page_url
        return url_transport.Fetched(url, url, html, "text/html", ())

    with url_client(monkeypatch, fake_fetch) as (c, headers):
        rid1 = str(uuid.uuid4())
        first = c.post("/api/import/url", headers=headers, json={"request_id": rid1, "url": page_url}).json()
        assert first["state"] == "committed"
        assert calls == 1

        # Exact same request_id replays stored receipt without re-fetching.
        same = c.post("/api/import/url", headers=headers, json={"request_id": rid1, "url": page_url}).json()
        assert same["state"] == "committed"
        assert same["doc_id"] == first["doc_id"]
        assert same["snapshot_id"] == first["snapshot_id"]
        assert calls == 1

        # New request_id for identical snapshot content reuses existing document.
        rid2 = str(uuid.uuid4())
        second = c.post("/api/import/url", headers=headers, json={"request_id": rid2, "url": page_url}).json()
        assert second["state"] == "committed"
        assert second["reused"] is True
        assert second["doc_id"] == first["doc_id"]
        assert len(c.get("/api/documents").json()) == 1


def test_delete_url_document_preserves_notes_and_removes_source(monkeypatch):
    page_url = "https://simonwillison.net/2026/notes/"
    html = (
        "<!doctype html><html><body><article>"
        "<h1>Note Preservation</h1><p>Keep ubiquitous insights after deleting source.</p>"
        "</article></body></html>"
    ).encode("utf-8")

    def fake_fetch(url, _kind, _control, **_kwargs):
        return url_transport.Fetched(url, url, html, "text/html", ())

    with url_client(monkeypatch, fake_fetch) as (c, headers):
        doc_id = c.post(
            "/api/import/url",
            headers=headers,
            json={"request_id": str(uuid.uuid4()), "url": page_url},
        ).json()["doc_id"]
        note = c.post("/api/notes", json={"doc_id": doc_id, "body": "keep", "quote": "ubiquitous"})
        assert note.status_code == 200

        deleted = c.delete(f"/api/documents/{doc_id}")
        assert deleted.status_code == 200
        assert all(d["id"] != doc_id for d in c.get("/api/documents").json())
        assert c.get(f"/api/documents/{doc_id}").status_code in (404, 410)

        notes = c.get("/api/notes").json()
        assert len(notes) == 1
        assert notes[0]["body"] == "keep"
        assert notes[0]["source_available"] is False

        reimported = c.post(
            "/api/import/url",
            headers=headers,
            json={"request_id": str(uuid.uuid4()), "url": page_url},
        )
        assert reimported.status_code == 200, reimported.text
        assert reimported.json()["state"] == "committed"
        assert reimported.json()["doc_id"] != doc_id

        notes_after = c.get("/api/notes").json()
        assert len(notes_after) == 1
        assert notes_after[0]["body"] == "keep"


def test_url_import_strips_scripts_styles_svg_and_handles_modern_html(monkeypatch):
    png = sample_png()
    page_url = "https://simonwillison.net/2026/modern/"
    img_url = "https://simonwillison.net/chart.png"
    html = (
        '<!doctype html><html><head>'
        '<title>Fallback Title</title>'
        '<meta name="author" content="Jane Doe">'
        '<script>alert("xss")</script>'
        '<style>body{color:red}</style>'
        '</head><body>'
        '<nav>Site Menu</nav>'
        '<article>'
        '<h1>Modern Web Article</h1>'
        '<time datetime="2026-10-01T00:00:00Z">Oct 1</time>'
        '<p>Paragraph with <a href="#top">Jump</a> link and real prose.</p>'
        '<svg><path d="M0 0"/>SVGTEXT</svg>'
        '<noscript>Enable JS</noscript>'
        '<img src="/chart.png" loading="lazy" srcset="/chart.png 1x, /chart.png 2x" '
        'style="color:transparent" alt="Chart">'
        '</article>'
        '<footer>Copyright 2026</footer>'
        '</body></html>'
    ).encode("utf-8")

    def fake_fetch(url, kind, _control, **_kwargs):
        if kind == "html" and url == page_url:
            return url_transport.Fetched(url, url, html, "text/html", ())
        if kind == "image" and url == img_url:
            return url_transport.Fetched(url, url, png, "image/png", ())
        raise AssertionError(f"unexpected fetch: {kind} {url}")

    with url_client(monkeypatch, fake_fetch) as (c, headers):
        res = c.post(
            "/api/import/url",
            headers=headers,
            json={"request_id": str(uuid.uuid4()), "url": page_url},
        )
        assert res.status_code == 200, res.text
        receipt = res.json()
        assert receipt["state"] == "committed"
        assert receipt["source"]["author"] == "Jane Doe"
        assert receipt["source"]["published_at"] == "2026-10-01T00:00:00Z"

        doc = c.get(f"/api/documents/{receipt['doc_id']}").json()
        blocks = doc["blocks"]
        full_text = "\n".join(b["text"] for b in blocks)
        assert "Modern Web Article" in full_text
        assert "Paragraph with Jump link and real prose." in full_text
        for forbidden in ("alert", "color:red", "SVGTEXT", "Enable JS", "Site Menu", "Copyright 2026"):
            assert forbidden not in full_text

        img_block = next(b for b in blocks if b["type"] == "image")
        asset = c.get(f"/api/import/url/snapshots/{receipt['snapshot_id']}/assets/{img_block['asset_id']}")
        assert asset.status_code == 200
        assert asset.content.startswith(b"\x89PNG\r\n\x1a\n")


def test_url_import_rejects_invalid_url_and_non_article_cleanly(monkeypatch):
    responses = {
        "https://simonwillison.net/2026/plain/": (b"plain text body", "text/plain"),
        "https://simonwillison.net/2026/no-article/": (
            b"<html><body><p>Loose text</p></body></html>",
            "text/html",
        ),
    }

    def fake_fetch(url, _kind, _control, **_kwargs):
        body, mime = responses[url]
        return url_transport.Fetched(url, url, body, mime, ())

    with url_client(monkeypatch, fake_fetch) as (c, headers):
        for bad_url in ("file:///etc/passwd", "javascript:alert(1)"):
            res = c.post(
                "/api/import/url",
                headers=headers,
                json={"request_id": str(uuid.uuid4()), "url": bad_url, "user_approved": True},
            )
            assert res.status_code == 422

        for url in responses:
            res = c.post(
                "/api/import/url",
                headers=headers,
                json={"request_id": str(uuid.uuid4()), "url": url},
            )
            assert res.status_code == 422
            assert res.json()["state"] == "failed"

        assert c.get("/api/documents").json() == []
