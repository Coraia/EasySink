"""Optional neural speech; English source input, bounded private disk cache."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
import platform
import re
import subprocess
from functools import lru_cache

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from wise_reader.ai import provider_error
from wise_reader.plugins.runtime import require_plugin


class SpeechIn(BaseModel):
    text: str = Field(min_length=1, max_length=1500)
    voice: str | None = Field(default=None, max_length=100)


@lru_cache(maxsize=1)
def local_voices():
    if platform.system() != "Darwin":
        return []
    try:
        result = subprocess.run(["/usr/bin/say", "-v", "?"], capture_output=True, text=True, timeout=5, check=True)
        voices = []
        for line in result.stdout.splitlines():
            m = re.match(r"(.+?)\s+(en_[A-Za-z]+)\s+#", line)
            if m:
                voices.append({"name": m[1].strip(), "lang": m[2].replace("_", "-")})
        return voices
    except (OSError, subprocess.SubprocessError):
        return []


async def native_command(args, request):
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    waiting = asyncio.create_task(process.wait())
    try:
        for _ in range(200):
            if await request.is_disconnected():
                raise HTTPException(499, "已取消朗读")
            try:
                code = await asyncio.wait_for(asyncio.shield(waiting), timeout=.2)
                if code:
                    raise HTTPException(502, "本地语音生成失败，请换一个已安装音色")
                return
            except asyncio.TimeoutError:
                continue
        raise HTTPException(504, "本地语音生成超时，请选择较短原文")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def register(app, ctx):
    router = APIRouter(dependencies=[Depends(require_plugin("tts"))])
    lock = asyncio.Lock()

    @router.get("/api/speech/status")
    def status():
        return {**app.state.ai.public()["speech"], "local": {"available": bool(local_voices()), "voices": local_voices(), "engine": "macOS 已安装语音"}}

    @router.post("/api/speech/local")
    async def local_speech(body: SpeechIn, request: Request):
        voices = local_voices()
        if not voices:
            raise HTTPException(400, "此电脑尚无可用本地英文音色，可选择浏览器本机语音")
        p = app.state.ai.snapshot("speech")
        voice = body.voice or p.get("local_voice", "Samantha")
        if voice not in {v["name"] for v in voices}:
            raise HTTPException(400, "请选择已安装的本地英文音色")
        text = body.text.strip()
        if not text:
            raise HTTPException(400, "没有可朗读的原文")
        key = hashlib.sha256(("macos-local\0" + voice + "\0" + text).encode()).hexdigest()
        directory = app.state.ai.cache_dir
        directory.mkdir(exist_ok=True, mode=0o700)
        path = directory / (key + ".wav")
        hit = path.exists()
        async with lock:
            if not path.exists():
                with tempfile.TemporaryDirectory(dir=directory, prefix="local-") as temp:
                    from pathlib import Path
                    source, aiff, wav = (Path(temp) / name for name in ("source.txt", "source.aiff", "speech.wav"))
                    source.write_text(text)
                    await native_command(["/usr/bin/say", "-v", voice, "-f", str(source), "-o", str(aiff)], request)
                    await native_command(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16", str(aiff), str(wav)], request)
                    if wav.stat().st_size > 8 * 1024 * 1024:
                        raise HTTPException(400, "音频过长，请选择较短原文")
                    os.replace(wav, path)
                size = 0
                for file in sorted(directory.glob("*.wav"), key=lambda f: f.stat().st_mtime, reverse=True):
                    size += file.stat().st_size
                    if size > 100 * 1024 * 1024 and file != path:
                        file.unlink(missing_ok=True)
        return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "private, no-store", "X-Speech-Cache": "hit" if hit else "miss", "X-Speech-Engine": "macos-local"})

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
