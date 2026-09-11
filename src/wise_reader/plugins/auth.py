"""本地登录。未建账号前不拦请求；有账号后 cookie 会话。"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from wise_reader.plugins.catalog import BY_ID
from wise_reader.plugins.runtime import PluginContext, require_plugin
from wise_reader.store import Store

PLUGIN_ID = "auth"
COOKIE = "wr_session"
PUBLIC_EXACT = {"/", "/favicon.ico"}


def _is_public(path: str, method: str) -> bool:
    if path in PUBLIC_EXACT:
        return True
    if path.startswith("/static/") or path.startswith("/api/auth/"):
        return True
    if path == "/api/plugins" and method == "GET":
        return True
    return False


class AuthIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=4, max_length=200)


def migrate(store: Store) -> None:
    store.executescript(
        """
        CREATE TABLE IF NOT EXISTS wr_user (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            pass_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wr_session (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"{salt.hex()}:{dk.hex()}"


def _verify(password: str, stored: str) -> bool:
    try:
        salt_hex, dk_hex = stored.split(":", 1)
    except ValueError:
        return False
    want = _hash(password, bytes.fromhex(salt_hex))
    return hmac.compare_digest(want, stored)


def _user_count(store: Store) -> int:
    row = store.query_one("SELECT COUNT(*) AS n FROM wr_user")
    return int(row["n"]) if row else 0


def _session_user(store: Store, token: str | None) -> dict | None:
    if not token:
        return None
    return store.query_one(
        "SELECT u.id, u.username FROM wr_session s"
        " JOIN wr_user u ON u.id = s.user_id WHERE s.token = ?",
        (token,),
    )


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.get("/api/auth/status")
    def status(request: Request):
        n = _user_count(ctx.store)
        user = _session_user(ctx.store, request.cookies.get(COOKIE))
        return {
            "enabled": True,
            "user_count": n,
            "needs_setup": n == 0,
            "user": user["username"] if user else None,
        }

    @router.post("/api/auth/register")
    def register_user(body: AuthIn, response: Response):
        username = body.username.strip()
        if _user_count(ctx.store) > 0:
            raise HTTPException(409, "already has a local account")
        try:
            cur = ctx.store.execute(
                "INSERT INTO wr_user(username, pass_hash, created_at) VALUES (?,?,?)",
                (username, _hash(body.password), _now()),
            )
        except Exception as e:
            raise HTTPException(409, "username taken") from e
        token = secrets.token_urlsafe(32)
        ctx.store.execute(
            "INSERT INTO wr_session(token, user_id, created_at) VALUES (?,?,?)",
            (token, int(cur.lastrowid), _now()),
        )
        response.set_cookie(COOKIE, token, httponly=True, samesite="lax")
        return {"ok": True, "username": username}

    @router.post("/api/auth/login")
    def login(body: AuthIn, response: Response):
        row = ctx.store.query_one(
            "SELECT id, username, pass_hash FROM wr_user WHERE username = ?",
            (body.username.strip(),),
        )
        if row is None or not _verify(body.password, row["pass_hash"]):
            raise HTTPException(401, "bad credentials")
        token = secrets.token_urlsafe(32)
        ctx.store.execute(
            "INSERT INTO wr_session(token, user_id, created_at) VALUES (?,?,?)",
            (token, row["id"], _now()),
        )
        response.set_cookie(COOKIE, token, httponly=True, samesite="lax")
        return {"ok": True, "username": row["username"]}

    @router.post("/api/auth/logout")
    def logout(request: Request, response: Response):
        token = request.cookies.get(COOKIE)
        if token:
            ctx.store.execute("DELETE FROM wr_session WHERE token = ?", (token,))
        response.delete_cookie(COOKIE)
        return {"ok": True}

    app.include_router(router)

    @app.middleware("http")
    async def auth_gate(request: Request, call_next):
        spec = BY_ID[PLUGIN_ID]
        if not ctx.store.is_plugin_enabled(PLUGIN_ID, spec.default_on):
            return await call_next(request)
        path = request.url.path
        if _is_public(path, request.method):
            return await call_next(request)
        if _user_count(ctx.store) == 0:
            return await call_next(request)
        user = _session_user(ctx.store, request.cookies.get(COOKIE))
        if user:
            return await call_next(request)
        if path.startswith("/api/"):
            return JSONResponse({"detail": "login required"}, status_code=401)
        return await call_next(request)
