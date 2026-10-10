#!/usr/bin/env python3
"""Private desktop service. Launch with bundled Python -I and an open stdin pipe."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import errno
import fcntl
import hmac
import json
import os
import re
import signal
import socket
import sys
import tempfile
from http.cookies import CookieError, SimpleCookie
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
COOKIE = "wr_desktop"


def atomic_json(path: Path, value) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(temporary).unlink(missing_ok=True)


def isolate(data: Path) -> None:
    # Explicitly clear credentials, proxies, Python paths, PDF overrides and .env
    # influences before importing any application or dependency modules.
    language = os.environ.get("LANG", "en_US.UTF-8")
    os.environ.clear()
    for name in ("home", "tmp", "cache", "models"):
        (data / name).mkdir(mode=0o700, exist_ok=True)
    os.environ.update(
        PATH="/usr/bin:/bin:/usr/sbin:/sbin", LANG=language,
        HOME=str(data / "home"), TMPDIR=str(data / "tmp"),
        XDG_CACHE_HOME=str(data / "cache"), PDF_LAB_MODELS_DIR=str(data / "models"),
        PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1",
        HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1",
        WR_USER_DB=str(data / "user.db"), WR_NATIVE_TRACKPAD="0",
    )
    sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE at startup.
    tempfile.tempdir = str(data / "tmp")
    os.chdir(data)
    sys.path.insert(0, str(APP / "src"))
    sys.path.insert(0, str(APP / "scripts/desktop"))
    from runtime import configured_manifest
    os.environ["WISE_READER_MINERU_MANIFEST"] = str(configured_manifest(data))


class SessionGuard:
    """Cookie authentication and browser origin isolation cover every route."""

    def __init__(self, app, authority: str, token: str, cookie_name: str):
        self.app, self.authority, self.token = app, authority, token
        self.cookie_name = cookie_name

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        headers = scope["headers"]
        hosts = [v.decode("latin-1") for k, v in headers if k == b"host"]
        origins = [v.decode("latin-1") for k, v in headers if k == b"origin"]
        sites = [v.decode("latin-1") for k, v in headers if k == b"sec-fetch-site"]
        cookies = SimpleCookie()
        try:
            for name, value in headers:
                if name == b"cookie":
                    cookies.load(value.decode("latin-1"))
            credential = cookies.get(self.cookie_name)
            authenticated = credential is not None and hmac.compare_digest(credential.value, self.token)
        except (CookieError, ValueError, TypeError):
            authenticated = False
        allowed = (
            hosts == [self.authority]
            and (not origins or origins == ["http://" + self.authority])
            and all(site in {"same-origin", "none"} for site in sites)
            and authenticated
        )
        if not allowed:
            if scope["type"] == "websocket":
                return await send({"type": "websocket.close", "code": 1008})
            from starlette.responses import JSONResponse
            return await JSONResponse({"detail": "Desktop session required."}, status_code=403,
                                      headers={"Cache-Control": "no-store"})(scope, receive, send)

        async def protected_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", [])) + [
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"cross-origin-resource-policy", b"same-origin"),
                    (b"content-security-policy", b"frame-ancestors 'none'"),
                ]
            await send(message)
        await self.app(scope, receive, protected_send)


def bind(data: Path):
    saved = data / "desktop-port.json"
    preferred = 0
    try:
        value = json.loads(saved.read_text()).get("port")
        if type(value) is int and 1024 <= value <= 65535:
            preferred = value
    except (OSError, ValueError, AttributeError):
        pass
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        try:
            sock.bind(("127.0.0.1", preferred))
        except OSError as exc:
            if not preferred or exc.errno != errno.EADDRINUSE:
                raise
            sock.bind(("127.0.0.1", 0))
        sock.listen(128)
        sock.setblocking(False)
        port = sock.getsockname()[1]
        record = {"port": port, "previous_port": preferred or None,
                  "changed": bool(preferred and port != preferred)}
        atomic_json(saved, record)
        if record["changed"]:
            with (data / "desktop-port-changes.jsonl").open("a") as stream:
                stream.write(json.dumps(record) + "\n")
        return sock
    except BaseException:
        sock.close()
        raise


async def serve(args, sock):
    import httpx
    import uvicorn
    from wise_reader.app import create_app
    from wise_reader.settings import Settings

    authority = "127.0.0.1:" + str(sock.getsockname()[1])
    cookie_name = COOKIE + "_" + str(sock.getsockname()[1])
    url = "http://" + authority
    app = SessionGuard(create_app(Settings.desktop(args.data_dir)), authority, args.token, cookie_name)
    class DesktopServer(uvicorn.Server):
        @contextlib.contextmanager
        def capture_signals(self):
            # Uvicorn normally re-raises SIGTERM after lifespan, which bypasses
            # ready-file cleanup. This process owns signals and exits normally.
            yield

    server = DesktopServer(uvicorn.Config(
        app, host="127.0.0.1", port=0, loop="asyncio", http="h11", ws="none",
        lifespan="on", access_log=False, log_level="warning", proxy_headers=False,
        timeout_graceful_shutdown=15,
    ))
    loop = asyncio.get_running_loop()
    stdin = sys.stdin.fileno()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, setattr, server, "should_exit", True)

    def parent_input():
        if not os.read(stdin, 4096):
            loop.remove_reader(stdin)
            server.should_exit = True

    loop.add_reader(stdin, parent_input)
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        deadline = loop.time() + 45
        while not server.started:
            if serving.done():
                await serving
                raise RuntimeError("Backend exited before readiness.")
            if loop.time() >= deadline:
                raise RuntimeError("Backend startup timed out.")
            await asyncio.sleep(.02)
        if server.should_exit:
            await serving
            return
        # Actual loopback HTTP after lifespan, with the same session policy as WKWebView.
        async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
            response = await client.get(url + "/health", headers={"Cookie": cookie_name + "=" + args.token})
            response.raise_for_status()
            if response.json().get("ok") is not True:
                raise RuntimeError("Backend health did not confirm startup.")
        if not server.should_exit:
            atomic_json(args.ready_file, {"url": url, "token": args.token, "pid": os.getpid(),
                                          "cookie_name": cookie_name})
        await serving
    finally:
        loop.remove_reader(stdin)
        server.should_exit = True
        if not serving.done():
            await serving  # Lifespan owns active conversion termination and database close.
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(sig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--ready-file", required=True, type=Path)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", args.token):
        parser.error("token must be a 32-256 character URL-safe nonce")
    os.umask(0o077)
    args.data_dir = args.data_dir.expanduser().resolve()
    args.ready_file = args.ready_file.expanduser().resolve()
    if args.data_dir == APP or APP in args.data_dir.parents:
        parser.error("data directory must be outside application resources")
    if args.data_dir not in args.ready_file.parents:
        parser.error("ready file must be inside the isolated data directory")
    args.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = os.open(args.data_dir / "desktop.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("This desktop data directory is already in use.", file=sys.stderr)
            return 73
        args.ready_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        args.ready_file.unlink(missing_ok=True)
        isolate(args.data_dir)
        with bind(args.data_dir) as sock:
            try:
                asyncio.run(serve(args, sock))
            finally:
                args.ready_file.unlink(missing_ok=True)
        return 0
    finally:
        os.close(lock)


if __name__ == "__main__":
    raise SystemExit(main())
