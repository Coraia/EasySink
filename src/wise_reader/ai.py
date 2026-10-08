"""Runtime provider settings. Secrets stay in a private server-side file."""

from __future__ import annotations

import json
import os
from typing import Literal
from threading import RLock
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from wise_reader.l1 import NullLLM, OpenAICompatLLM


class ProviderPatch(BaseModel):
    enabled: bool | None = None
    base_url: str | None = Field(default=None, max_length=500)
    model: str | None = Field(default=None, max_length=150)
    voice: str | None = Field(default=None, max_length=100)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_key: bool = False
    mode: Literal["local", "browser", "natural"] | None = None
    local_voice: str | None = Field(default=None, max_length=100)


class ConfigPatch(BaseModel):
    text: ProviderPatch | None = None
    speech: ProviderPatch | None = None


def provider_error(exc):
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in (401, 403):
            return "服务拒绝了凭据，请检查 API Key 与权限"
        if code == 429:
            return "服务额度或请求频率已达上限，请稍后重试"
        return f"服务请求失败（HTTP {code}），请检查地址和模型名称"
    if isinstance(exc, httpx.TimeoutException):
        return "服务响应超时，请稍后重试"
    if isinstance(exc, httpx.RequestError):
        return "无法连接服务，请检查地址和网络"
    return "无法读取服务返回的数据，请检查接口格式和模型名称"


class AIConfig:
    def __init__(self, settings, engine, store):
        self.engine = engine
        self.ctx = None
        self.lock = RLock()
        self.path = store.path.parent / "ai-settings.json"
        self.cache_dir = store.path.parent / "speech-cache"
        self.values = {
            "text": dict(
                enabled=settings.wr_llm_enabled,
                base_url=settings.wr_llm_base_url,
                model=settings.wr_llm_model,
                api_key=settings.wr_llm_api_key,
            ),
            "speech": dict(
                enabled=False,
                base_url="https://api.openai.com/v1",
                model="gpt-4o-mini-tts",
                voice="marin",
                api_key="",
                mode="local",
                local_voice="Samantha",
            ),
        }
        if self.path.exists():
            saved = json.loads(self.path.read_text())
            for kind in self.values:
                self.values[kind].update(
                    {
                        k: v
                        for k, v in saved.get(kind, {}).items()
                        if k in self.values[kind]
                    }
                )
        self.apply()

    def apply(self):
        p = self.values["text"]
        active = bool(p["enabled"] and p["api_key"])
        self.engine.llm = (
            OpenAICompatLLM(p["base_url"], p["api_key"], p["model"])
            if active
            else NullLLM()
        )
        self.engine.l1_enabled = active
        if self.ctx:
            self.ctx.llm = self.engine.llm
            self.ctx.l1_on = active

    def snapshot(self, kind):
        with self.lock:
            return dict(self.values[kind])

    def public(self):
        with self.lock:
            return {
                kind: {
                    **{k: v for k, v in p.items() if k != "api_key"},
                    "has_api_key": bool(p["api_key"]),
                    "available": bool(p["enabled"] and p["api_key"]),
                }
                for kind, p in self.values.items()
            }

    def update(self, patch):
        with self.lock:
            values = {k: dict(v) for k, v in self.values.items()}
            for kind in values:
                item = getattr(patch, kind)
                if item is None:
                    continue
                p = values[kind]
                for k, v in item.model_dump(exclude_none=True).items():
                    if k == "clear_key":
                        continue
                    if k == "api_key" and not v.strip():
                        continue
                    if k in ("voice", "mode", "local_voice") and kind != "speech":
                        continue
                    p[k] = v.strip() if isinstance(v, str) else v
                if item.clear_key:
                    p["api_key"] = ""
                parts = urlsplit(p["base_url"])
                if (
                    parts.scheme not in ("http", "https")
                    or not parts.hostname
                    or parts.username
                    or parts.password
                    or parts.query
                    or parts.fragment
                ):
                    raise HTTPException(
                        400, "服务地址必须是 HTTP(S) 基础地址，不能包含凭据或查询参数"
                    )
                if not p["model"]:
                    raise HTTPException(400, "请填写模型名称")
                if kind == "speech" and not p["voice"]:
                    raise HTTPException(400, "请填写音色名称")
                p["base_url"] = p["base_url"].rstrip("/")
                if p["enabled"] and not p["api_key"]:
                    raise HTTPException(400, "启用前请填写 API Key")
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                with os.fdopen(fd, "w") as f:
                    os.fchmod(f.fileno(), 0o600)
                    json.dump(values, f, ensure_ascii=False)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.path)
            finally:
                tmp.unlink(missing_ok=True)
            self.values = values
            self.apply()
            return self.public()


def register_ai(app, manager):
    @app.exception_handler(RequestValidationError)
    async def safe_validation(request, exc):
        if request.url.path == "/api/ai/config":
            return JSONResponse(
                {"detail": "配置格式不正确，请检查字段长度与启用状态"}, status_code=422
            )
        return await request_validation_exception_handler(request, exc)

    @app.get("/api/ai/config")
    def config(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return manager.public()

    @app.put("/api/ai/config")
    def save(body: ConfigPatch, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return manager.update(body)

    @app.post("/api/ai/test")
    def test_text():
        p = manager.snapshot("text")
        if not p["enabled"] or not p["api_key"]:
            raise HTTPException(400, "请先保存并启用文本 AI 配置")
        try:
            reply = OpenAICompatLLM(
                p["base_url"], p["api_key"], p["model"], timeout=15
            ).chat("Reply only OK.", "Connection test.")
            if not isinstance(reply, str) or not reply.strip():
                raise ValueError("empty")
        except Exception as exc:
            raise HTTPException(502, provider_error(exc)) from None
        return {"ok": True, "message": "连接成功，可以生成注释与翻译"}
