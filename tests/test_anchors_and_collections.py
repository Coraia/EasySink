"""Behavioral pins for UTF-16 <-> Python source anchors and /api/collections contracts."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from wise_reader.app import create_app
from wise_reader.content import Anchor, get_content
from wise_reader.reading_assist import offset_index, selected, source_ranges, utf16


def _anchor(doc: dict, block_idx: int, start_char: int, end_char: int, **extra) -> dict:
    block = doc["blocks"][block_idx]
    text = block["text"]
    return {
        "version": doc["version"],
        "block_id": block["id"],
        "start": utf16(text[:start_char]),
        "end": utf16(text[:end_char]),
        "quote": text[start_char:end_char],
        **extra,
    }


def test_utf16_anchor_offsets_and_surrogate_pair_guards():
    with TestClient(create_app()) as c:
        created = c.post(
            "/api/documents",
            json={
                "title": "Emoji Anchors",
                "text": "Alpha 😀 beta gamma.\n\nSecond paragraph.\n\nThird paragraph.",
            },
        ).json()
        doc_id = created["id"]
        blocks = created["blocks"]
        version = created["version"]

        assert utf16("Alpha 😀 ") == 9
        assert offset_index("Alpha 😀 beta", 9) == 8

        ctx = SimpleNamespace(store=c.app.state.store)
        _, stored_blocks = get_content(ctx.store, ctx.store.get_document(doc_id))
        assert [b["id"] for b in stored_blocks] == [b["id"] for b in blocks]

        _, single, single_src = selected(
            ctx, doc_id, Anchor.model_validate(_anchor(created, 0, 8, 12))
        )
        assert single_src == "beta"
        assert (single.start, single.end) == (9, 13)

        # Surrogate pair spans UTF-16 units 6..8; offset 7 splits the emoji.
        with pytest.raises(HTTPException) as split_err:
            selected(ctx, doc_id, Anchor.model_validate({"version": version, "block_id": blocks[0]["id"], "start": 7, "end": 9}))
        assert split_err.value.status_code == 400

        p0 = _anchor(created, 0, 8, len(blocks[0]["text"]))
        p1 = _anchor(created, 1, 0, 6)
        cross = Anchor.model_validate({**p0, "quote": p0["quote"] + "\n\n" + p1["quote"], "segments": [p0, p1]})
        _, resolved_cross, cross_src = selected(ctx, doc_id, cross)
        assert cross_src == "beta gamma.\n\nSecond"
        mapped = source_ranges(resolved_cross, 5, len(cross_src))
        assert [m["quote"] for m in mapped] == ["gamma.", "Second"]
        assert mapped[1]["start"] == 0 and mapped[1]["end"] == 6

        # Skipping middle block or forging quote/version must fail explicitly.
        discontinuous = {**p0, "quote": p0["quote"] + "\n\nThird", "segments": [p0, _anchor(created, 2, 0, 5)]}
        with pytest.raises(HTTPException) as gap_err:
            selected(ctx, doc_id, Anchor.model_validate(discontinuous))
        assert gap_err.value.status_code == 400

        forged = _anchor(created, 0, 8, 12, quote="forged")
        with pytest.raises(HTTPException) as quote_err:
            selected(ctx, doc_id, Anchor.model_validate(forged))
        assert quote_err.value.status_code == 409

        stale = _anchor(created, 0, 8, 12, version="stale-version")
        with pytest.raises(HTTPException) as ver_err:
            selected(ctx, doc_id, Anchor.model_validate(stale))
        assert ver_err.value.status_code == 409


def test_collections_save_idempotency_merge_and_undo():
    with TestClient(create_app()) as c:
        doc = c.post(
            "/api/documents",
            json={"title": "Collections", "text": "Alpha 😀 beta gamma delta epsilon.\n\nSecond paragraph."},
        ).json()
        doc_id = doc["id"]

        first = c.post("/api/collections", json={"doc_id": doc_id, "kind": "excerpt", "anchor": _anchor(doc, 0, 0, 5)})
        assert first.status_code == 200
        first_body = first.json()

        dup = c.post("/api/collections", json={"doc_id": doc_id, "kind": "excerpt", "anchor": _anchor(doc, 0, 0, 5)}).json()
        assert dup["item"]["id"] == first_body["item"]["id"]
        assert dup["undo_token"] is None

        assert c.post("/api/collections", json={"doc_id": doc_id, "kind": "word", "anchor": _anchor(doc, 0, 0, 5, quote="bad")}).status_code == 409
        bad_surrogate = _anchor(doc, 0, 0, 5)
        bad_surrogate.pop("quote")
        bad_surrogate["start"], bad_surrogate["end"] = 6, 7
        assert c.post("/api/collections", json={"doc_id": doc_id, "kind": "word", "anchor": bad_surrogate}).status_code == 400
        assert c.post("/api/collections", json={"doc_id": doc_id, "kind": "word", "anchor": _anchor(doc, 0, 0, 5, version="old")}).status_code == 409

        second = c.post("/api/collections", json={"doc_id": doc_id, "kind": "excerpt", "anchor": _anchor(doc, 0, 8, 12)}).json()
        union = c.post("/api/collections", json={"doc_id": doc_id, "kind": "excerpt", "anchor": _anchor(doc, 0, 3, 10)}).json()
        assert union["item"]["quote"] == doc["blocks"][0]["text"][:12]
        assert second["item"]["id"] in union["merged_ids"]

        restored = c.post("/api/collections/undo", json={"token": union["undo_token"]})
        assert restored.status_code == 200
        assert len(restored.json()["items"]) == 2
        assert c.post("/api/collections/undo", json={"token": union["undo_token"]}).status_code == 409


def test_collections_cross_paragraph_and_discontinuous_rejection():
    with TestClient(create_app()) as c:
        doc = c.post(
            "/api/documents",
            json={"title": "Multi", "text": "First paragraph end.\n\nSecond paragraph.\n\nThird paragraph."},
        ).json()
        doc_id = doc["id"]

        p0 = _anchor(doc, 0, 16, len(doc["blocks"][0]["text"]))
        p1 = _anchor(doc, 1, 0, 6)
        cross = {**p0, "quote": p0["quote"] + "\n\n" + p1["quote"], "segments": [p0, p1]}
        ok = c.post("/api/collections", json={"doc_id": doc_id, "kind": "excerpt", "anchor": cross})
        assert ok.status_code == 200
        assert ok.json()["item"]["quote"] == "end.\n\nSecond"

        invalid = {**cross, "segments": [p0, _anchor(doc, 2, 0, 5)]}
        assert c.post("/api/collections", json={"doc_id": doc_id, "kind": "excerpt", "anchor": invalid}).status_code == 400


def test_collections_word_feedback_and_document_delete_preserves_records():
    with TestClient(create_app()) as c:
        doc = c.post(
            "/api/documents",
            json={"title": "Retained", "text": "Alpha beta gamma."},
        ).json()
        doc_id = doc["id"]

        saved = c.post("/api/collections", json={"doc_id": doc_id, "kind": "word", "anchor": _anchor(doc, 0, 0, 5)}).json()
        fb1 = c.post(
            "/api/collections/feedback",
            json={"doc_id": doc_id, "anchor": _anchor(doc, 0, 0, 5), "retained": True, "note": "first letter"},
        ).json()
        fb2 = c.post(
            "/api/collections/feedback",
            json={"doc_id": doc_id, "anchor": _anchor(doc, 0, 0, 5), "understood": True},
        ).json()
        assert fb2["state"]["retained"] is True
        assert fb2["state"]["understood"] is True

        c.post("/api/collections/undo", json={"token": fb2["undo_token"]})
        fb_state = c.get(f"/api/collections/state/{doc_id}").json()["feedback"]
        assert len(fb_state) == 1 and fb_state[0]["understood"] is None and fb_state[0]["retained"] is True
        assert fb1["state"]["id"] == fb_state[0]["id"]

        assert c.delete(f"/api/documents/{doc_id}").status_code == 200
        collections = c.get("/api/collections").json()["items"]
        assert len(collections) == 1 and collections[0]["id"] == saved["item"]["id"]
        src = c.get(f"/api/collections/{saved['item']['id']}/source").json()
        assert src["available"] is False
        assert src["quote"] == "Alpha"
