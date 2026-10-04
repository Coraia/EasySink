"""Optional neural speech; English source input, bounded private disk cache."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from wise_reader.ai import provider_error
from wise_reader.plugins.runtime import require_plugin


class SpeechIn(BaseModel):
    text: str = Field(min_length=1, max_length=1500)
    voice: str | None = Field(default=None, max_length=100)


def register(app, ctx):
    router = APIRouter(dependencies=[Depends(require_plugin("tts"))])
    lock = asyncio.Lock()

    @router.get("/api/speech/status")
    def status():
        return app.state.ai.public()["speech"]

    @router.post("/api/speech")
    async def speech(body: SpeechIn):
        manager = app.state.ai
        p = manager.snapshot("speech")
        if not p["enabled"] or not p["api_key"]:
            raise HTTPException(400, "请先在 AI 与语音设置中启用自然语音")
        text = body.text.strip()
        if not text:
            raise HTTPException(400, "没有可朗读的原文")
        voice = body.voice or p["voice"]
        identity = "\0".join([p["base_url"], p["model"], voice, p["api_key"], text])
        key = hashlib.sha256(identity.encode()).hexdigest()
        directory = manager.cache_dir
        directory.mkdir(exist_ok=True, mode=0o700)
        path = directory / (key + ".wav")
        hit = path.exists()
        async with lock:
            if not path.exists():
                payload = dict(
                    model=p["model"], voice=voice, input=text, response_format="wav"
                )
                if p["model"] == "gpt-4o-mini-tts":
                    payload["instructions"] = (
                        "Read English naturally and warmly, with clear phrasing and gentle pauses, as an audiobook narrator."
                    )
                try:
                    async with httpx.AsyncClient(timeout=35) as client:
                        async with client.stream(
                            "POST",
                            p["base_url"] + "/audio/speech",
                            json=payload,
                            headers={"Authorization": "Bearer " + p["api_key"]},
                        ) as response:
                            response.raise_for_status()
                            audio = bytearray()
                            async for chunk in response.aiter_bytes():
                                audio.extend(chunk)
                                if len(audio) > 8 * 1024 * 1024:
                                    raise ValueError("audio limit")
                    if (
                        len(audio) < 44
                        or audio[:4] != b"RIFF"
                        or audio[8:12] != b"WAVE"
                    ):
                        raise ValueError("invalid wav")
                except Exception as exc:
                    raise HTTPException(502, provider_error(exc)) from None
                fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(audio)
                    os.replace(tmp, path)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
                files = sorted(
                    directory.glob("*.wav"),
                    key=lambda x: x.stat().st_mtime,
                    reverse=True,
                )
                size = 0
                for f in files:
                    size += f.stat().st_size
                    if size > 100 * 1024 * 1024 and f != path:
                        f.unlink(missing_ok=True)
        return FileResponse(
            path,
            media_type="audio/wav",
            headers={
                "Cache-Control": "private, no-store",
                "X-Speech-Cache": "hit" if hit else "miss",
            },
        )

    app.include_router(router)
