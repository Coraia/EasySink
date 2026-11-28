from fastapi.testclient import TestClient

from wise_reader import page_translation
from wise_reader.app import create_app
from wise_reader.content import put_content
from wise_reader.reading_assist import utf16


def create(client, source):
    return client.post("/api/documents", json={"title": "Reading", "text": source}).json()


def ref(doc, index):
    return {"doc_id": doc["id"], "version": doc["version"], "block_id": doc["blocks"][index]["id"]}


def enable_ai(client):
    assert client.put("/api/ai/config", json={"text": {"enabled": True,
        "base_url": "http://127.0.0.1:1/v1", "api_key": "fixture", "model": "fixture"}}).is_success


def test_durable_failure_and_exact_batch_retry(monkeypatch):
    calls = []

    async def model(app, request, prompt, payload, provider):
        items = payload["paragraphs"]
        calls.append(items)
        return {"paragraphs": [{"id": item["id"], "segments": [{"quote": item["source"], "zh": "译文"}]}
                               for item in (items[1:] if len(calls) == 1 else reversed(items))]}

    monkeypatch.setattr(page_translation, "model_json", model)
    with TestClient(create_app()) as client:
        doc = create(client, "Alpha 😀 bravo.\n\nSecond paragraph.\n\nThird paragraph.")
        path = f"/api/documents/{doc['id']}/page-translation"
        first, second, third = [ref(doc, i) for i in range(3)]
        batch = {"blocks": [first, second, first], "generate": True}
        assert client.post(path, json=batch).status_code == 400
        assert client.post(path, json={"blocks": [first]}).json()["blocks"] == []
        enable_ai(client)
        value = client.post(path, json=batch).json()
        assert {row["status"] for row in value["blocks"]} == {"unknown"}
        token, = {row["batch_id"] for row in value["blocks"]}
        assert len(calls[0]) == 2

    with TestClient(create_app()) as client:
        replay = client.post(path, json={"blocks": [second], "generate": True}).json()
        assert replay["blocks"][0]["status"] == "unknown"
        assert len(calls) == 1
        value = client.post(path, json={"blocks": [second, third], "retry": token}).json()
        assert {row["block_id"] for row in value["blocks"]} == {first["block_id"], second["block_id"]}
        assert calls[0] == calls[1]
        assert client.post(path, json=batch).json()["blocks"][0]["status"] == "ready"
        assert len(calls) == 2
        assert client.post(path, json={"blocks": [{**third, "version": "outdated"}], "generate": True}).status_code == 409
        other = create(client, "Another book.")
        assert client.post(path, json={"blocks": [ref(other, 0)], "generate": True}).status_code == 422


def test_complete_group_alignment_uses_utf16_across_source_blocks(monkeypatch):
    async def model(app, request, prompt, payload, provider):
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
        segment, = response.json()["blocks"][0]["segments"]
        assert segment["ranges"] == [{"block_id": block["id"], "start": 0, "end": utf16(block["text"])}
                                     for block in blocks]
