"""Closing an HTTP consumer does not revoke an explicit explanation request."""

import asyncio
from functools import partial
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from wise_reader.app import create_app
from wise_reader import reading_assist


@pytest.mark.parametrize("finish_mode", ["complete", "join", "cancel"])
def test_context_card_disconnect_lifecycle(monkeypatch, finish_mode):
    with TestClient(create_app()) as c:
        c.put("/api/ai/config", json={"text": {
            "enabled": True, "api_key": "test-no-secret", "model": "fixture",
            "base_url": "http://provider.invalid/v1",
        }})
        doc = c.post("/api/documents", json={
            "title": "Detached explanation", "text": "A prominent contribution matters.",
        }).json()
        anchor = {"version": doc["version"], "block_id": doc["blocks"][0]["id"],
                  "start": 2, "end": 11, "quote": "prominent"}
        endpoint = partial(reading_assist.context_assist, c.app,
                           SimpleNamespace(store=c.app.state.store))
        calls = []

        async def scenario():
            started, release = asyncio.Event(), asyncio.Event()

            async def model(app, state, system, user, *args, **kwargs):
                calls.append(user["task"])
                await kwargs["before_send"]()
                if len(calls) == 1:
                    started.set()
                    await release.wait()
                    return {
                        "target_usage": {"quote": user["nearby_excerpt"]["quote"], "usage": "突出的贡献"},
                        "lexical_gloss": "突出的",
                        "translations": [{"unit_id": unit["id"], "plain_chinese": "突出的贡献很重要。"}
                                         for unit in user["focus_sources"]],
                    }
                return user["draft"]

            monkeypatch.setattr(reading_assist, "model_json", model)
            messages = asyncio.Queue()
            request = Request({"type": "http", "app": c.app, "headers": []}, messages.get)
            first = asyncio.create_task(endpoint(doc_id=doc["id"], body=reading_assist.ContextIn(
                anchor=anchor, request_id="card-first"), request=request))
            await asyncio.wait_for(started.wait(), 2)
            await messages.put({"type": "http.disconnect"})
            with pytest.raises(HTTPException) as disconnected:
                await asyncio.wait_for(first, 2)
            assert disconnected.value.status_code == 499
            attempt = c.app.state.store.query_one("SELECT * FROM wr_context_attempt")
            assert attempt["state"] == "pending"
            flight = c.app.state.assist_flights["context:" + attempt["id"]]
            if finish_mode == "cancel":
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=c.app),
                                             base_url="http://testserver") as client:
                    cancelled = await client.delete(f"/api/documents/{doc['id']}/assist-requests/card-first")
                    assert cancelled.status_code == 200
                with pytest.raises(asyncio.CancelledError):
                    await flight["task"]
                assert c.app.state.store.query_one("SELECT state FROM wr_context_attempt")["state"] == "unknown"
                return None
            joined = None
            if finish_mode == "join":
                other = Request({"type": "http", "app": c.app, "headers": []}, asyncio.Queue().get)
                joined = asyncio.create_task(endpoint(doc_id=doc["id"], body=reading_assist.ContextIn(
                    anchor=anchor, request_id="card-reopened"), request=other))
                await asyncio.sleep(0)
                assert not joined.done()
            release.set()
            result = await asyncio.wait_for(asyncio.shield(flight["task"]), 2)
            if joined:
                assert (await joined)["id"] == result["id"]
            assert c.app.state.store.query_one("SELECT state FROM wr_context_attempt")["state"] == "succeeded"
            return result

        result = c.portal.call(scenario)
        later = c.post(f"/api/documents/{doc['id']}/context", json={
            "anchor": anchor, "request_id": "card-later",
        })
        if finish_mode == "cancel":
            assert later.status_code == 409
            assert later.json()["detail"]["code"] == "context_unknown"
            assert len(calls) == 1
            assert c.app.state.store.query("SELECT * FROM wr_assist") == []
            return
        assert later.status_code == 200, later.text
        assert later.json()["cached"] is True
        assert later.json()["id"] == result["id"]
        assert len(calls) == 2
        assert len(c.app.state.store.query("SELECT * FROM wr_context_attempt")) == 1
