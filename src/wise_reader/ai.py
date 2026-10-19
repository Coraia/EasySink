"""Runtime provider settings. Secrets stay in a private server-side file."""

from __future__ import annotations

import json
import logging
import os
import re
import stat
import time
import uuid
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


class AssistFailureDiagnostic:
    """Private, bounded failure evidence, separate from valid assistance records."""

    lock = RLock()
    max_files = 20
    max_total = 2 * 1024 * 1024
    max_file = 192 * 1024
    max_response = 128 * 1024

    def __init__(self, store, doc_id, operation, request_id, selection, target, secret):
        self.directory = store.path.parent / ".runtime" / "assist-failures"
        self.secret = secret
        self.stage = "configuration"
        self.exception_type = None
        self.provider_status = None
        self.response = None
        self.response_kind = None
        self.started = time.monotonic()
        self.data = {"format": 1, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                     "request_id": request_id or uuid.uuid4().hex, "doc_id": doc_id, "operation": operation,
                     "selection": self.anchor(selection), "analyzed_range": self.anchor(target)}

    @staticmethod
    def anchor(anchor):
        fields = ("version", "block_id", "start", "end", "quote")
        value = anchor.model_dump(include=set(fields) | {"segments"})
        if value.get("segments"):
            value["segments"] = [{k: s[k] for k in fields if k in s} for s in value["segments"]]
        return value

    def redact(self, text):
        if self.secret:
            for value in {self.secret, json.dumps(self.secret)[1:-1], json.dumps(self.secret, ensure_ascii=False)[1:-1]}:
                text = text.replace(value, "<REDACTED>")
        # A model/provider may echo credentials: message bodies are untrusted too.
        names = r"(?:x-)?api[_-]?key|authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token"
        text = re.sub(r'(?i)("(?:' + names + r')"\s*:\s*)"(?:\\.|[^"\\])*"', r'\1"<REDACTED>"', text)
        text = re.sub(r"(?im)(\b(?:Authorization|Proxy-Authorization|X-Api-Key|Cookie|Set-Cookie)\s*:\s*)[^\r\n]+", r"\1<REDACTED>", text)
        return re.sub(r"(?i)\bBearer\s+[^\s\"'\\,;]+", "Bearer <REDACTED>", text)

    def safe(self, value):
        if isinstance(value, str):
            return self.redact(value)
        if isinstance(value, list):
            return [self.safe(item) for item in value]
        if isinstance(value, dict):
            return {key: self.safe(item) for key, item in value.items()}
        return value

    def save(self, exc):
        category = self.stage
        detail = exc.detail if isinstance(exc, HTTPException) and isinstance(exc.detail, str) else "分析处理失败"
        if category == "validation":
            category = ("source_range" if any(s in detail for s in ("原文", "所选文字"))
                        else "hierarchy" if any(s in detail for s in ("层级", "根节点")) else "schema")
        diagnostic_id = None
        try:
            body = self.safe({**self.data, "category": category,
                              "exception_type": self.exception_type or type(exc).__name__,
                              "elapsed_ms": round((time.monotonic() - self.started) * 1000, 1),
                              "status": getattr(exc, "status_code", 500), "message": detail,
                              "provider_status": self.provider_status, "response_kind": self.response_kind})
            raw = self.redact(self.response) if self.response is not None else None
            encoded = raw.encode("utf-8") if raw is not None else b""
            body.update(model_response=encoded[:self.max_response].decode("utf-8", errors="ignore") if raw is not None else None,
                        response_bytes=len(encoded), response_truncated=len(encoded) > self.max_response,
                        response_redacted=raw != self.response,
                        selection_redacted=body["selection"] != self.data["selection"] or body["analyzed_range"] != self.data["analyzed_range"])
            while True:
                body["replay_complete"] = bool(raw is not None and not any(body[k] for k in ("response_truncated", "response_redacted", "selection_redacted")))
                payload = (json.dumps(body, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
                if len(payload) <= self.max_file:
                    break
                if not body["model_response"]:
                    raise ValueError("diagnostic metadata exceeds limit")
                body["model_response"] = body["model_response"][:len(body["model_response"]) // 2]
                body["response_truncated"] = True
            with self.lock:
                self.directory.parent.mkdir(mode=0o700, exist_ok=True)
                if not stat.S_ISDIR(self.directory.parent.lstat().st_mode):
                    raise OSError("diagnostic parent is not a directory")
                self.directory.mkdir(mode=0o700, exist_ok=True)
                if not stat.S_ISDIR(self.directory.lstat().st_mode):
                    raise OSError("diagnostic destination is not a directory")
                self.directory.chmod(0o700)
                files = sorted(p for p in self.directory.glob("failure-*.json") if stat.S_ISREG(p.lstat().st_mode))
                total = sum(p.stat().st_size for p in files)
                while files and (len(files) >= self.max_files or total + len(payload) > self.max_total):
                    old = files.pop(0)
                    total -= old.stat().st_size
                    old.unlink()
                name = f"failure-{time.time_ns()}-{uuid.uuid4().hex}.json"
                temporary = self.directory / ("." + name + ".tmp")
                try:
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(payload)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, self.directory / name)
                    diagnostic_id = name
                finally:
                    temporary.unlink(missing_ok=True)
        except Exception:
            # Evidence storage must never obscure the reader's original error.
            pass
        logging.getLogger(__name__).warning("reading_assist_failed operation=%s category=%s diagnostic=%s",
                                           self.data["operation"], category, diagnostic_id or "unavailable")


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
    illustration: ProviderPatch | None = None


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
            "illustration": dict(
                enabled=False,
                base_url="https://api.openai.com/v1",
                model="",
                api_key="",
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

    def preview(self, kind, item, current=None):
        """Validate a candidate without changing runtime or persisted settings."""
        previous = current if current is not None else self.snapshot(kind)
        p = dict(previous)
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
        if (
            previous["api_key"]
            and p["base_url"] != previous["base_url"].strip().rstrip("/")
            and not item.clear_key
            and not (item.api_key or "").strip()
        ):
            raise HTTPException(400, "更换服务地址时请填写该服务的 API Key，或移除凭据并关闭")
        if p["enabled"] and not p["api_key"]:
            raise HTTPException(400, "启用前请填写 API Key")
        return p

    def save_tested_text(self, candidate, previous):
        with self.lock:
            if self.values["text"] != previous:
                raise HTTPException(409, "文本 AI 配置已被其他操作更改，本次测试未覆盖它；请重新检查")
            return self.update(ConfigPatch(text=ProviderPatch(**candidate)))

    def update(self, patch):
        with self.lock:
            values = {k: dict(v) for k, v in self.values.items()}
            for kind in values:
                item = getattr(patch, kind)
                if item is None:
                    continue
                values[kind] = self.preview(kind, item, values[kind])
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
        if request.url.path in ("/api/ai/config", "/api/ai/test"):
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
    def test_text(response: Response, body: ProviderPatch | None = None):
        response.headers["Cache-Control"] = "no-store"
        previous = manager.snapshot("text")
        if body is None:
            p = previous  # Existing API clients may still test the saved provider.
        else:
            p = manager.preview("text", body.model_copy(update={"enabled": True}), previous)
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
        if body is None:
            return {"ok": True, "message": "连接成功，可以生成注释与翻译"}
        saved = manager.save_tested_text(p, previous)
        return {"ok": True, "message": "连接成功，已启用并保存文本 AI", "config": saved}
