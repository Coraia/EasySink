#!/usr/bin/env python3
"""Start/stop/status for the local app; detached process, bounded readiness and persistent logs."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / ".runtime"
PID = RUNTIME / "web.json"
URL = "http://127.0.0.1:8766/"


def healthy():
    try:
        with urllib.request.urlopen(URL + "health", timeout=1) as response:
            return json.load(response).get("version") == "0.2.0"
    except Exception:
        return False


def owned_pid():
    if not PID.exists():
        return None
    pid = json.loads(PID.read_text())["pid"]
    cmd = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True
    ).stdout
    return pid if "wise_reader.app:create_app" in cmd and "8766" in cmd else None


def stop():
    pid = owned_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            if not owned_pid():
                break
            time.sleep(0.1)
        else:
            raise SystemExit("服务仍在退出，可能正在结束 AI 请求；请稍后执行 status。")
    PID.unlink(missing_ok=True)
    print("Web 已停止")


def start():
    if healthy():
        print("Web 已就绪：" + URL)
        return
    if owned_pid():
        raise SystemExit("进程存在但未就绪，请查看 .runtime/web.log")
    RUNTIME.mkdir(exist_ok=True)
    python = ROOT / ".venv/bin/python"
    if not python.exists():
        raise SystemExit("请先运行 uv sync --extra dev")
    log = (RUNTIME / "web.log").open("ab")
    process = subprocess.Popen(
        [
            str(python),
            "-m",
            "uvicorn",
            "wise_reader.app:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            "8766",
        ],
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log.close()
    PID.write_text(json.dumps({"pid": process.pid, "url": URL}))
    for _ in range(80):
        if healthy():
            print("Web 已启动：" + URL + "\n日志：" + str(RUNTIME / "web.log"))
            return
        if process.poll() is not None:
            break
        time.sleep(0.15)
    raise SystemExit("启动未就绪，请检查 .runtime/web.log（可能端口被占用）。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=["start", "stop", "restart", "status"],
        nargs="?",
        default="start",
    )
    action = parser.parse_args().action
    if action in ("stop", "restart"):
        stop()
    if action in ("start", "restart"):
        start()
    if action == "status":
        print(
            ("运行中：" + URL)
            if healthy()
            else "服务未就绪；日志：" + str(RUNTIME / "web.log")
        )
