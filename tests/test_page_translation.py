import httpx
import pytest
from fastapi.testclient import TestClient

from wise_reader import page_translation
from wise_reader.app import create_app
from wise_reader.content import put_content
from wise_reader.reading_assist import ModelRequestError, utf16


def create(client, source):
    return client.post("/api/documents", json={"title": "Reading", "text": source}).json()


def ref(doc, index):
    return {"doc_id": doc["id"], "version": doc["version"], "block_id": doc["blocks"][index]["id"]}


def enable_ai(client):
    assert client.put("/api/ai/config", json={"text": {"enabled": True,
        "base_url": "http://127.0.0.1:1/v1", "api_key": "fixture", "model": "fixture"}}).is_success


def fetch(client, path, refs):
    return client.post(path, json={"blocks": refs}).raise_for_status().json()["blocks"]


def translation(item):
    return {"id": item["id"], "segments": [{"quote": item["source"], "zh": "译文"}]}


def test_partial_batch_persists_and_retries_only_the_selected_failure(monkeypatch):
    calls = []

    async def model(app, request, prompt, payload, provider, **_):
        items = payload["paragraphs"]
        calls.append(items)
        if len(calls) == 1:
            bad, good, duplicate, _ = map(translation, items)
            bad["segments"][0]["quote"] = "Invented source."
            return {"paragraphs": [good, bad, duplicate, duplicate, {"id": 99}]}
        return {"paragraphs": [translation(item) for item in items]}

    monkeypatch.setattr(page_translation, "model_json", model)
    with TestClient(create_app()) as client:
        doc = create(client, "Alpha 😀 bravo.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.")
        path = f"/api/documents/{doc['id']}/page-translation"
        refs = [ref(doc, i) for i in range(4)]
        batch = {"blocks": [*refs, refs[0]], "generate": True}
        assert client.post(path, json=batch).status_code == 400
        assert fetch(client, path, refs) == []
        enable_ai(client)
        started = client.post(path, json=batch).raise_for_status().json()
        assert started["batch"]["total"] == 4
        assert {row["status"] for row in started["blocks"]} == {"pending"}
        token = started["batch"]["id"]
        assert len(calls[0]) == 4

    with TestClient(create_app()) as client:
        replay = client.post(path, json=batch).raise_for_status().json()["blocks"]
        assert [row["status"] for row in replay] == ["failed", "ready", "failed", "failed"]
        assert replay[0]["error_code"] == replay[3]["error_code"] == "alignment"
        assert replay[1]["segments"][0]["zh"] == "译文"
        assert len(calls) == 1
        assert client.post(path, json={"blocks": refs[:2], "retry": token}).is_success
        assert [item["source"] for item in calls[1]] == [calls[0][0]["source"]]
        assert [r["status"] for r in fetch(client, path, refs)] == ["ready", "ready", "failed", "failed"]
        client.post(path, json={"blocks": refs[:2], "retry": token}).raise_for_status()
        assert len(calls) == 2
        assert client.post(path, json={"blocks": [{**refs[2], "version": "outdated"}], "generate": True}).status_code == 409
        other = create(client, "Another book.")
        assert client.post(path, json={"blocks": [ref(other, 0)], "generate": True}).status_code == 422


def test_complete_group_alignment_uses_utf16_across_source_blocks(monkeypatch):
    async def model(app, request, prompt, payload, provider, **_):
        unit, = payload["paragraphs"]
        assert unit["source"] == "Alpha 😀.\n\nBravo."
        return {"paragraphs": [{"id": 0, "segments": [{"quote": unit["source"], "zh": "整段"}]}]}

    monkeypatch.setattr(page_translation, "model_json", model)
    with TestClient(create_app()) as client:
        enable_ai(client)
        text = "Alpha 😀.\n\nBravo."
        doc = create(client, text)
        blocks = doc["blocks"]
        group = {"id": "natural-paragraph", "blocks": [block["id"] for block in blocks]}
        for block in blocks:
            block["paragraph_group"] = group
        put_content(client.app.state.store, doc["id"], text, blocks)
        path = f"/api/documents/{doc['id']}/page-translation"
        body = {"blocks": [ref(doc, 0)], "generate": True}
        assert client.post(path, json={**body, "blocks": [ref(doc, 1)]}).status_code == 422
        response = client.post(path, json=body)
        assert response.is_success, response.text
        segment, = fetch(client, path, body["blocks"])[0]["segments"]
        assert segment["ranges"] == [{"block_id": block["id"], "start": 0, "end": utf16(block["text"])}
                                     for block in blocks]


@pytest.mark.parametrize(("cause", "state", "code", "http_status"), [
    (httpx.ReadTimeout("timeout"), "unknown", "timeout", None),
    (httpx.ConnectError("network"), "unknown", "connection", None),
    (httpx.HTTPStatusError("rate", request=httpx.Request("POST", "https://example.test"),
                           response=httpx.Response(429)), "failed", "rate_limit", 429),
    (ValueError("invalid JSON"), "failed", "model_format", None),
])
def test_failure_reason_and_attempt_survive_restart(monkeypatch, cause, state, code, http_status):
    calls = []

    async def model(*args, **kwargs):
        calls.append(1)
        raise ModelRequestError(cause)

    monkeypatch.setattr(page_translation, "model_json", model)
    with TestClient(create_app()) as client:
        doc = create(client, "First paragraph.")
        path = f"/api/documents/{doc['id']}/page-translation"
        refs = [ref(doc, 0)]
        enable_ai(client)
        client.post(path, json={"blocks": refs, "generate": True}).raise_for_status()

    with TestClient(create_app()) as client:
        row, = client.post(path, json={"blocks": refs, "generate": True}).raise_for_status().json()["blocks"]
        assert (row["status"], row["error_code"]) == (state, code)
        attempt = client.app.state.store.query_one("SELECT * FROM wr_page_translation_attempt WHERE id=?", (row["batch_id"],))
        assert (attempt["state"], attempt["provider_status"], attempt["error_code"]) == (state, http_status, code)
        assert len(calls) == 1


def test_restart_applies_journal_and_never_resends_an_interrupted_paid_attempt(monkeypatch):
    calls = []

    async def model(app, request, prompt, payload, provider, **_):
        calls.append(1)
        return {"paragraphs": [translation(item) for item in payload["paragraphs"]]}

    def crash_after_receipt(*args):
        raise RuntimeError("interrupted after durable receipt")

    monkeypatch.setattr(page_translation, "model_json", model)
    with TestClient(create_app(), raise_server_exceptions=False) as client:
        doc = create(client, "First paragraph.\n\nSecond paragraph.")
        path = f"/api/documents/{doc['id']}/page-translation"
        refs = [ref(doc, i) for i in range(2)]
        enable_ai(client)
        with monkeypatch.context() as interrupt:
            interrupt.setattr(page_translation, "settle", crash_after_receipt)
            received = client.post(path, json={"blocks": refs[:1], "generate": True}).json()["batch"]["id"]
            sent = client.post(path, json={"blocks": refs[1:], "generate": True}).json()["batch"]["id"]
        store = client.app.state.store
        assert store.query_one("SELECT state FROM wr_page_translation_attempt WHERE id=?", (received,))["state"] == "received"
        store.execute("UPDATE wr_page_translation_attempt SET state='sent',result=NULL WHERE id=?", (sent,))

    with TestClient(create_app()) as client:
        rows = client.post(path, json={"blocks": refs, "generate": True}).raise_for_status().json()["blocks"]
        assert [(r["status"], r["error_code"]) for r in rows] == [("ready", None), ("unknown", "interrupted")]
        assert len(calls) == 2
        store = client.app.state.store
        assert store.query_one("SELECT state,result FROM wr_page_translation_attempt WHERE id=?", (received,)) == {
            "state": "succeeded", "result": None,
        }
