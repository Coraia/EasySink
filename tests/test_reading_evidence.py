"""Observable contracts for opt-in reading evidence consent, batching, export, and isolation."""

from __future__ import annotations

import json
import time
import uuid

from fastapi.testclient import TestClient

from wise_reader.app import create_app


def _sample_events(session_id: str) -> list[dict]:
    return [
        {
            "event_id": uuid.uuid4().hex,
            "session_id": session_id,
            "session_seq": 1,
            "event_type": "session_opened",
            "status": "observed",
            "client_time": "2026-11-19T10:00:00Z",
            "details": {"doc_id": 1},
        },
        {
            "event_id": uuid.uuid4().hex,
            "session_id": session_id,
            "session_seq": 2,
            "event_type": "word_card",
            "status": "observed",
            "client_time": "2026-11-19T10:00:02Z",
            "details": {"lemma": "serendipity"},
        },
    ]


def test_evidence_consent_control_and_epoch_guard():
    with TestClient(create_app()) as c:
        initial = c.get("/api/evidence/status").json()
        assert initial["enabled"] == 0
        assert initial["events"] == 0
        epoch = initial["epoch"]

        unconfirmed = c.post("/api/evidence/control", json={"action": "enable", "epoch": epoch, "confirm": False})
        assert unconfirmed.status_code == 422

        enabled = c.post("/api/evidence/control", json={"action": "enable", "epoch": epoch, "confirm": True})
        assert enabled.status_code == 200
        body = enabled.json()
        assert body["enabled"] == 1
        assert body["epoch"] != epoch

        stale = c.post("/api/evidence/control", json={"action": "disable", "epoch": epoch})
        assert stale.status_code == 409


def test_evidence_batch_events_and_ndjson_export():
    with TestClient(create_app()) as c:
        status = c.get("/api/evidence/status").json()
        enabled = c.post(
            "/api/evidence/control",
            json={"action": "enable", "epoch": status["epoch"], "confirm": True},
        ).json()
        events = _sample_events(uuid.uuid4().hex)

        posted = c.post("/api/evidence/batch", json={"epoch": enabled["epoch"], "events": events})
        assert posted.status_code == 200, posted.text

        listed = c.get("/api/evidence/events")
        assert listed.status_code == 200
        got = listed.json()["events"]
        assert [row["event_id"] for row in got] == [ev["event_id"] for ev in events]

        assert c.get("/api/evidence/export").status_code == 422
        exported = c.get("/api/evidence/export", params={"confirm": True})
        assert exported.status_code == 200
        records = [json.loads(line) for line in exported.text.splitlines() if line.strip()]
        kinds = [rec["record"] for rec in records]
        assert kinds[0] == "manifest"
        assert kinds.count("event") == 2
        assert "session_index" in kinds


def test_evidence_disable_preserves_and_clear_erases():
    with TestClient(create_app()) as c:
        epoch = c.get("/api/evidence/status").json()["epoch"]
        epoch = c.post("/api/evidence/control", json={"action": "enable", "epoch": epoch, "confirm": True}).json()["epoch"]
        c.post("/api/evidence/batch", json={"epoch": epoch, "events": _sample_events(uuid.uuid4().hex)})

        disabled = c.post("/api/evidence/control", json={"action": "disable", "epoch": epoch})
        assert disabled.status_code == 200
        assert disabled.json()["enabled"] == 0
        assert len(c.get("/api/evidence/events").json()["events"]) == 2

        epoch2 = disabled.json()["epoch"]
        assert c.post("/api/evidence/control", json={"action": "clear", "epoch": epoch2, "confirm": False}).status_code == 422

        cleared = c.post("/api/evidence/control", json={"action": "clear", "epoch": epoch2, "confirm": True})
        assert cleared.status_code == 200
        assert cleared.json()["enabled"] == 0
        assert cleared.json()["events"] == 0
        assert c.get("/api/evidence/events").json() == {"events": []}


def test_evidence_does_not_block_business_operations():
    with TestClient(create_app()) as c:
        for enable in (False, True):
            if enable:
                epoch = c.get("/api/evidence/status").json()["epoch"]
                r = c.post("/api/evidence/control", json={"action": "enable", "epoch": epoch, "confirm": True})
                assert r.status_code == 200
            doc = c.post("/api/documents", json={"title": "Ops", "text": "The ubiquitous serendipity of life."})
            assert doc.status_code == 200
            doc_id = doc.json()["id"]
            note = c.post("/api/notes", json={"doc_id": doc_id, "quote": "ubiquitous", "body": "note text"})
            assert note.status_code == 200
            fb = c.post("/api/feedback", json={"lemma": "serendipity", "verdict": "known"})
            assert fb.status_code == 200


def test_evidence_ignores_backward_clock_jump():
    with TestClient(create_app()) as c:
        epoch = c.get("/api/evidence/status").json()["epoch"]
        enabled = c.post("/api/evidence/control", json={"action": "enable", "epoch": epoch, "confirm": True}).json()
        assert enabled["enabled"] == 1

        c.app.state.evidence.store.execute("UPDATE wr_evidence_control SET clock=? WHERE id=1", (time.time() + 3600,))

        status = c.get("/api/evidence/status")
        assert status.status_code == 200
        assert status.json()["enabled"] == 1
        assert status.json()["pause"] == ""

        posted = c.post("/api/evidence/batch", json={"epoch": enabled["epoch"], "events": _sample_events(uuid.uuid4().hex)})
        assert posted.status_code == 200, posted.text
