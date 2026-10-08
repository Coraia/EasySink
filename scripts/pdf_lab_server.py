#!/usr/bin/env python3
"""Own and inspect only the isolated loopback PDF lab service."""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = Path(__file__).resolve()
HOST = "127.0.0.1"


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/health", timeout=1) as response:
            payload = json.load(response)
            return payload.get("service") == "wise-reader-pdf-lab" and payload.get("status") == "ok"
    except (OSError, ValueError):
        return False


def owned_pid(record: Path, data_dir: Path, port: int):
    try:
        information = json.loads(record.read_text(encoding="utf-8"))
        pid = information["pid"]
        if information.get("port") != port or information.get("data_dir") != str(data_dir):
            return None
        command = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                 capture_output=True, text=True, timeout=3).stdout
        return pid if all(part in command for part in
            (str(SCRIPT), "serve", f"--port {port}", str(data_dir))) else None
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        return None


def port_free(port):
    with socket.socket() as connection:
        # Match uvicorn's bind semantics after an owned socket enters TIME_WAIT.
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            connection.bind((HOST, port))
            return True
        except OSError:
            return False


def stop(data_dir, port):
    record = data_dir / "server.json"
    pid = owned_pid(record, data_dir, port)
    if not pid:
        if not port_free(port):
            raise SystemExit("Port is occupied by an unowned process; no signal was sent.")
        record.unlink(missing_ok=True)
        print("PDF lab is stopped.")
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        if not owned_pid(record, data_dir, port):
            record.unlink(missing_ok=True)
            print("PDF lab stopped; originals and conversion ranges retained.")
            return
        time.sleep(0.1)
    raise SystemExit("Owned service is still stopping; inspect its server.log.")


def start(data_dir, port):
    record = data_dir / "server.json"
    if owned_pid(record, data_dir, port):
        if healthy(port):
            print(f"PDF lab is ready: http://{HOST}:{port}/static/prototypes/pdf-lab/index.html")
            return
        raise SystemExit("Owned process exists but is not ready; inspect server.log.")
    if not port_free(port):
        raise SystemExit("Port is occupied; no existing process was changed.")
    python = ROOT / ".venv/bin/python"
    if not python.is_file():
        raise SystemExit("Existing lightweight .venv is unavailable; no dependencies were installed.")
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = {name: os.environ[name] for name in ("PATH", "HOME", "USER", "TMPDIR", "LANG")
                   if name in os.environ}
    environment["PYTHONPATH"] = str(ROOT / "src")
    with (data_dir / "server.log").open("ab") as log:
        process = subprocess.Popen([str(python), str(SCRIPT), "serve", "--port", str(port),
                                    "--data-dir", str(data_dir)], cwd=ROOT, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True, umask=0o077)
    temporary = record.with_suffix(".tmp")
    temporary.write_text(json.dumps({"pid": process.pid, "port": port, "data_dir": str(data_dir)}),
                         encoding="utf-8")
    os.replace(temporary, record)
    for _ in range(80):
        if healthy(port):
            print(f"PDF lab started: http://{HOST}:{port}/static/prototypes/pdf-lab/index.html")
            print(f"Data and logs: {data_dir}")
            return
        if process.poll() is not None:
            break
        time.sleep(0.15)
    raise SystemExit("PDF lab did not become ready; inspect server.log (first failure preserved).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "stop", "restart", "status", "serve"],
                        nargs="?", default="start")
    parser.add_argument("--port", type=int, default=18866)
    parser.add_argument("--data-dir", type=Path, default=ROOT / ".runtime/pdf-lab")
    options = parser.parse_args()
    data_dir = options.data_dir.expanduser().resolve()
    if not 1024 <= options.port <= 65535:
        parser.error("Use an unprivileged valid loopback port.")
    if options.action == "serve":
        sys.path.insert(0, str(ROOT / "src"))
        import uvicorn
        from wise_reader.pdf_lab.app import create_app
        uvicorn.run(create_app(data_dir), host=HOST, port=options.port, log_level="info")
    elif options.action == "status":
        pid = owned_pid(data_dir / "server.json", data_dir, options.port)
        print(json.dumps({"ready": bool(pid and healthy(options.port)), "owned_pid": pid,
                          "port": options.port, "data_dir": str(data_dir)}, indent=2))
    else:
        if options.action in {"stop", "restart"}:
            stop(data_dir, options.port)
        if options.action in {"start", "restart"}:
            start(data_dir, options.port)


if __name__ == "__main__":
    main()
