"""Backend tests for grammar analysis mode planning and reference/modifier guardrails."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from wise_reader.app import create_app


def _client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("WR_USER_DB", str(tmp_path / "user.db"))
    monkeypatch.setenv("WR_LLM_ENABLED", "false")
    return TestClient(create_app())


def _enable_ai(c: TestClient, base_url: str = "http://127.0.0.1:19999/v1") -> None:
    resp = c.put(
        "/api/ai/config",
        json={
            "text": {
                "enabled": True,
                "base_url": base_url,
                "model": "test-grammar-model",
                "api_key": "test-key",
            }
        },
    )
    assert resp.status_code == 200


def test_grammar_plan_splits_sentences_and_matches_assist_cache(tmp_path: Path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    _enable_ai(c)
    text = (
        "The doctrine, which reveals its origin, shapes the argument. "
        "It remains central to the debate.\n\n"
        "It is clear that the claim holds."
    )
    doc = c.post("/api/documents", json={"title": "Grammar plan", "text": text}).json()
    blocks = c.get(f"/api/documents/{doc['id']}").json()["blocks"]
    block_ids = [b["id"] for b in blocks]

    plan_before = c.post(
        f"/api/documents/{doc['id']}/grammar/plan",
        json={"block_ids": [block_ids[0], "missing-block", block_ids[1], block_ids[0]]},
    )
    assert plan_before.status_code == 200
    body = plan_before.json()
    assert body["provider_available"] is True
    assert body["total_count"] == 3
    assert body["cached_count"] == 0
    assert body["uncached_count"] == 3
    assert [s["anchor"]["quote"] for s in body["sentences"]] == [
        "The doctrine, which reveals its origin, shapes the argument.",
        "It remains central to the debate.",
        "It is clear that the claim holds.",
    ]
    assert all(s["has_trigger"] for s in body["sentences"])

    # Mock model_json and run grammar analysis on sentence 0.
    from wise_reader import reading_assist

    async def fake_model_json(app, client_arg, system, user, p, diagnostic=None):
        return {
            "summary": "包含非限制性定语从句 which。",
            "nodes": [
                {
                    "id": "root",
                    "parent": None,
                    "label": "整句",
                    "explanation": "主干与定语从句。",
                    "kind": "clause",
                    "ranges": [{"first": 0, "last": 8}],
                },
                {
                    "id": "which-mod",
                    "parent": "root",
                    "label": "定语从句：which",
                    "explanation": "which 修饰 the doctrine。",
                    "kind": "clause",
                    "role": "clause_modifier",
                    "ranges": [{"first": 2, "last": 5}],
                    "target_ranges": [{"first": 0, "last": 1}],
                },
            ],
        }

    monkeypatch.setattr(reading_assist, "model_json", fake_model_json)
    first_anchor = body["sentences"][0]["anchor"]
    created = c.post(
        f"/api/documents/{doc['id']}/grammar",
        json={"anchor": first_anchor, "request_id": "plan-cache-1"},
    )
    assert created.status_code == 200
    assist_row = created.json()
    mod_node = next(n for n in assist_row["payload"]["nodes"] if n["id"] == "which-mod")
    assert mod_node["role"] == "clause_modifier"
    assert mod_node["target_ranges"][0]["quote"] == "The doctrine,"

    # Planning again must detect sentence 0 as cached with the exact assist_id.
    plan_after = c.post(
        f"/api/documents/{doc['id']}/grammar/plan",
        json={"block_ids": block_ids},
    ).json()
    assert plan_after["cached_count"] == 1
    assert plan_after["uncached_count"] == 2
    assert plan_after["sentences"][0]["cached"] is True
    assert plan_after["sentences"][0]["assist_id"] == assist_row["id"]
    assert plan_after["sentences"][1]["cached"] is False


def test_formal_it_strips_hallucinated_target_ranges(tmp_path: Path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    _enable_ai(c)
    doc = c.post(
        "/api/documents",
        json={"title": "Formal it guardrail", "text": "It is clear that the claim holds."},
    ).json()
    blocks = c.get(f"/api/documents/{doc['id']}").json()["blocks"]
    plan = c.post(
        f"/api/documents/{doc['id']}/grammar/plan",
        json={"block_ids": [blocks[0]["id"]]},
    ).json()

    from wise_reader import reading_assist

    async def fake_model_json(app, client_arg, system, user, p, diagnostic=None):
        # Even if a model mistakenly returns target_ranges for formal_it, backend strips it.
        return {
            "summary": "形式主语句。",
            "nodes": [
                {
                    "id": "root",
                    "parent": None,
                    "label": "整句",
                    "explanation": "形式主语结构。",
                    "kind": "clause",
                    "ranges": [{"first": 0, "last": 6}],
                },
                {
                    "id": "formal-it",
                    "parent": "root",
                    "label": "形式主语：It",
                    "explanation": "形式主语，无先行词。",
                    "kind": "reference",
                    "role": "formal_it",
                    "ranges": [{"first": 0, "last": 0}],
                    "target_ranges": [{"first": 4, "last": 5}],
                },
            ],
        }

    monkeypatch.setattr(reading_assist, "model_json", fake_model_json)
    res = c.post(
        f"/api/documents/{doc['id']}/grammar",
        json={"anchor": plan["sentences"][0]["anchor"], "request_id": "formal-it-1"},
    )
    assert res.status_code == 200
    node = next(n for n in res.json()["payload"]["nodes"] if n["id"] == "formal-it")
    assert node["role"] == "formal_it"
    assert "target_ranges" not in node


def test_out_of_bounds_target_ranges_rejected(tmp_path: Path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    _enable_ai(c)
    doc = c.post(
        "/api/documents",
        json={"title": "Bad target range", "text": "It remains central."},
    ).json()
    blocks = c.get(f"/api/documents/{doc['id']}").json()["blocks"]
    plan = c.post(
        f"/api/documents/{doc['id']}/grammar/plan",
        json={"block_ids": [blocks[0]["id"]]},
    ).json()

    from wise_reader import reading_assist

    async def fake_model_json(app, client_arg, system, user, p, diagnostic=None):
        return {
            "summary": "坏范围。",
            "nodes": [
                {
                    "id": "root",
                    "parent": None,
                    "label": "整句",
                    "explanation": "整句。",
                    "kind": "clause",
                    "ranges": [{"first": 0, "last": 2}],
                },
                {
                    "id": "ref",
                    "parent": "root",
                    "label": "回指",
                    "explanation": "越界范围。",
                    "kind": "reference",
                    "role": "referential",
                    "ranges": [{"first": 0, "last": 0}],
                    "target_ranges": [{"first": 0, "last": 99}],
                },
            ],
        }

    monkeypatch.setattr(reading_assist, "model_json", fake_model_json)
    res = c.post(
        f"/api/documents/{doc['id']}/grammar",
        json={"anchor": plan["sentences"][0]["anchor"], "request_id": "bad-target-1"},
    )
    assert res.status_code == 502
