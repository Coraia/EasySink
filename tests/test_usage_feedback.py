"""Behavioral tests for whole-word/phrase default usage-feedback scopes and phrase independence."""

from __future__ import annotations

from fastapi.testclient import TestClient

from wise_reader.app import create_app
from wise_reader.collections_source import utf16
from wise_reader.reading_learning import estimate
from wise_reader.usage_feedback import valid_usage


def _anchor_for(doc: dict, block_idx: int, substring: str, nth: int = 0) -> dict:
    block = doc["blocks"][block_idx]
    text = block["text"]
    pos = -1
    start = 0
    for _ in range(nth + 1):
        pos = text.index(substring, start)
        start = pos + 1
    end = pos + len(substring)
    return {
        "version": doc["version"],
        "block_id": block["id"],
        "start": utf16(text[:pos]),
        "end": utf16(text[:end]),
        "quote": substring,
    }


def _annos(doc_json: dict) -> list[dict]:
    return [f for b in doc_json["blocks"] for f in b["fragments"] if f["type"] == "anno"]


def test_single_word_defaults_to_lexeme_across_docs_and_inflections():
    with TestClient(create_app()) as c:
        c.patch("/api/profile", json={"density": 15, "vocab_size": 1000, "l1_enabled": False, "repeat": True})
        doc1 = c.post(
            "/api/documents",
            json={
                "title": "Doc 1",
                "text": "It is ubiquitous, and it stays ubiquitous. I ran before.",
            },
        ).json()
        doc2 = c.post(
            "/api/documents",
            json={
                "title": "Doc 2",
                "text": "Ubiquitous tools are here, and she will run too.",
            },
        ).json()

        assert [a["text"] for a in _annos(doc1) if a["text"].lower() == "ubiquitous"] == [
            "ubiquitous",
            "ubiquitous",
        ]
        assert any(a["text"] == "Ubiquitous" for a in _annos(doc2))

        anchor1 = _anchor_for(doc1, 0, "ubiquitous", 0)
        preview = c.post("/api/collections/usage-preview", json={"doc_id": doc1["id"], "anchor": anchor1})
        assert preview.status_code == 200
        choices = preview.json()["choices"]
        assert choices[0]["id"] == "lexeme:ubiquitous"
        assert choices[0]["requires_confirmation"] is False
        assert choices[0]["usage"] == {"protocol": "lexeme-v1", "lemma": "ubiquitous"}

        fb = c.post(
            "/api/collections/usage-feedback",
            json={"doc_id": doc1["id"], "anchor": anchor1, "action": "known", "scope_id": "lexeme:ubiquitous"},
        )
        assert fb.status_code == 200
        assert fb.json()["model"]["known_evidence"] == 1

        refetched1 = c.get(f"/api/documents/{doc1['id']}").json()
        refetched2 = c.get(f"/api/documents/{doc2['id']}").json()
        assert not any(a["text"].lower() == "ubiquitous" for a in _annos(refetched1))
        assert not any(a["text"].lower() == "ubiquitous" for a in _annos(refetched2))

        state2 = c.get(f"/api/collections/state/{doc2['id']}").json()
        assert len(state2["usage_matches"]) == 1
        assert state2["usage_matches"][0]["anchor"]["quote"] == "Ubiquitous"
        assert state2["usage_matches"][0]["annotation_preference"] == "known"

        # Inflection mapping: marking "ran" known suppresses "run" via lexeme:run.
        ran_anchor = _anchor_for(doc1, 0, "ran")
        ran_preview = c.post("/api/collections/usage-preview", json={"doc_id": doc1["id"], "anchor": ran_anchor}).json()
        assert ran_preview["choices"][0]["id"] == "lexeme:run"
        assert ran_preview["choices"][0]["requires_confirmation"] is False
        assert c.post(
            "/api/collections/usage-feedback",
            json={"doc_id": doc1["id"], "anchor": ran_anchor, "action": "known", "scope_id": "lexeme:run"},
        ).status_code == 200
        state2_after_ran = c.get(f"/api/collections/state/{doc2['id']}").json()
        assert any(m["anchor"]["quote"] == "run" and m["annotation_preference"] == "known" for m in state2_after_ran["usage_matches"])

        # Resetting via "auto" on the capitalized occurrence in doc2 clears the lexeme scope and retracts evidence.
        anchor2 = _anchor_for(doc2, 0, "Ubiquitous")
        reset = c.post(
            "/api/collections/usage-feedback",
            json={"doc_id": doc2["id"], "anchor": anchor2, "action": "auto", "scope_id": "lexeme:ubiquitous"},
        )
        assert reset.status_code == 200
        restored1 = c.get(f"/api/documents/{doc1['id']}").json()
        restored2 = c.get(f"/api/documents/{doc2['id']}").json()
        assert len([a for a in _annos(restored1) if a["text"].lower() == "ubiquitous"]) == 2
        assert any(a["text"] == "Ubiquitous" for a in _annos(restored2))
        model = estimate(c.app.state.store, c.app.state.engine.lexicon, c.app.state.store.get_profile())
        assert model["known_evidence"] == 1  # only "run" remains


def test_single_word_known_does_not_suppress_dictionary_phrases():
    with TestClient(create_app()) as c:
        c.patch("/api/profile", json={"density": 15, "vocab_size": 1000, "l1_enabled": False, "repeat": True})
        doc = c.post(
            "/api/documents",
            json={
                "title": "Phrase Independence",
                "text": "We had to break the ice, while the ice was still there.",
            },
        ).json()

        before = _annos(doc)
        assert any(a["kind"] == "phrase" and a["text"] == "break the ice" for a in before)
        assert any(a["kind"] == "word" and a["text"] == "ice" for a in before)

        ice_anchor = _anchor_for(doc, 0, "ice", 1)
        res = c.post(
            "/api/collections/usage-feedback",
            json={"doc_id": doc["id"], "anchor": ice_anchor, "action": "known", "scope_id": "lexeme:ice"},
        )
        assert res.status_code == 200

        after = _annos(c.get(f"/api/documents/{doc['id']}").json())
        assert any(a["kind"] == "phrase" and a["text"] == "break the ice" for a in after)
        assert not any(a["kind"] == "word" and a["text"] == "ice" for a in after)


def test_phrase_defaults_to_selected_phrase_and_narrowing_stays_scoped():
    with TestClient(create_app()) as c:
        c.patch("/api/profile", json={"density": 15, "vocab_size": 1000, "l1_enabled": False, "repeat": True})
        doc1 = c.post(
            "/api/documents",
            json={
                "title": "Phrase & Pending",
                "text": "We had to break the ice. It is ubiquitous, and it stays ubiquitous.",
            },
        ).json()
        doc2 = c.post(
            "/api/documents",
            json={
                "title": "Second Phrase Doc",
                "text": "They tried to break the ice again.",
            },
        ).json()

        phrase_anchor = _anchor_for(doc1, 0, "break the ice")
        preview = c.post("/api/collections/usage-preview", json={"doc_id": doc1["id"], "anchor": phrase_anchor}).json()
        first = preview["choices"][0]
        assert first["kind"] == "phrase"
        assert first["requires_confirmation"] is False
        assert first["usage"]["pattern"] == "break the ice"

        c.post(
            "/api/collections/usage-feedback",
            json={"doc_id": doc1["id"], "anchor": phrase_anchor, "action": "known", "scope_id": first["id"]},
        )
        after2 = _annos(c.get(f"/api/documents/{doc2['id']}").json())
        assert not any(a["text"] == "break the ice" for a in after2)

        # Occurrence-only ("pending") affects only that exact occurrence.
        ubiq0 = _anchor_for(doc1, 0, "ubiquitous", 0)
        c.post(
            "/api/collections/usage-feedback",
            json={"doc_id": doc1["id"], "anchor": ubiq0, "action": "known", "scope_id": "pending"},
        )
        after1 = _annos(c.get(f"/api/documents/{doc1['id']}").json())
        assert len([a for a in after1 if a["text"] == "ubiquitous"]) == 1


def test_collocation_narrowing_works_for_polysemy():
    with TestClient(create_app()) as c:
        c.patch("/api/profile", json={"density": 15, "vocab_size": 1000, "l1_enabled": False, "repeat": True})
        doc = c.post(
            "/api/documents",
            json={
                "title": "Collocation",
                "text": "Say grace before dinner, and walk with grace after.",
            },
        ).json()

        grace_anchor = _anchor_for(doc, 0, "grace", 0)
        choices = c.post("/api/collections/usage-preview", json={"doc_id": doc["id"], "anchor": grace_anchor}).json()["choices"]
        assert choices[0]["id"] == "lexeme:grace"
        colloc = next(ch for ch in choices if ch["kind"] == "collocation" and ch["usage"]["pattern"] == "Say grace")
        assert colloc["requires_confirmation"] is True

        c.post(
            "/api/collections/usage-feedback",
            json={"doc_id": doc["id"], "anchor": grace_anchor, "action": "known", "scope_id": colloc["id"]},
        )
        state = c.get(f"/api/collections/state/{doc['id']}").json()
        assert len(state["usage_matches"]) == 1
        assert state["usage_matches"][0]["anchor"]["start"] == grace_anchor["start"]


def test_valid_usage_lexeme_v1_validation():
    assert valid_usage({"protocol": "lexeme-v1", "lemma": "ubiquitous"}, "Ubiquitous")
    assert not valid_usage({"protocol": "lexeme-v1", "lemma": "Ubiquitous"}, "Ubiquitous")
    assert not valid_usage({"protocol": "lexeme-v1", "lemma": "two words"}, "two words")
    assert not valid_usage({"protocol": "lexeme-v1", "lemma": "ice", "extra": 1}, "ice")
    assert not valid_usage({"protocol": "lexeme-v1", "lemma": "ice"}, "two words")
