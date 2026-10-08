#!/usr/bin/env python3
"""Run the real reader with a persistent disposable PDF review library."""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / ".runtime/pdf-reader-preview"
sys.path.insert(0, str(ROOT / "src"))


def factory():
    from wise_reader.app import create_app
    from wise_reader.settings import Settings

    directory = Path(os.environ["PDF_READER_PREVIEW_DIR"])
    settings = Settings(_env_file=None, wr_user_db=str(directory / "user.db"),
                        wr_llm_enabled=False, wr_llm_api_key="",
                        wr_llm_base_url="http://127.0.0.1:18768", wr_llm_model="preview-disabled")
    return create_app(settings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "serve", "status", "stop", "restart"])
    parser.add_argument("--port", type=int, default=18876)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DIR)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    url = f"http://127.0.0.1:{args.port}/health"
    if args.action in {"stop", "restart"}:
        record = directory / "service.json"
        if record.exists():
            owner = json.loads(record.read_text())
            pid = owner["pid"]
            command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
            if command and not (str(Path(__file__).resolve()) in command and "serve" in command and str(args.port) in command and str(directory) in command):
                raise SystemExit("Recorded PID belongs to a different process; left unchanged")
            if command:
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
                    if not state or state.startswith("Z"):
                        break
                    time.sleep(.1)
                else:
                    raise SystemExit("Owned preview is still shutting down; not killed")
        if args.action == "stop":
            print(json.dumps({"running": False, "url": url}))
            return
    if args.action == "serve":
        import uvicorn
        os.environ["PDF_READER_PREVIEW_DIR"] = str(directory)
        os.environ["WR_NATIVE_TRACKPAD"] = "0"
        uvicorn.run(factory, factory=True, host="127.0.0.1", port=args.port, log_level="warning")
        return
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            health = json.load(response)
        print(json.dumps({"url": url, "running": True, "health": health}))
        return
    except (OSError, ValueError):
        if args.action == "status":
            print(json.dumps({"url": url, "running": False}))
            return
    python = ROOT / ".venv/bin/python"
    command = [str(python), str(Path(__file__).resolve()), "serve", "--port", str(args.port), "--data-dir", str(directory)]
    with (directory / "service.log").open("ab") as log:
        process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
    (directory / "service.json").write_text(json.dumps({"pid": process.pid, "port": args.port,
        "data_dir": str(directory), "command": command}, indent=2))
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and process.poll() is None:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                health = json.load(response)
            print(json.dumps({"running": True, "health": health, "url": f"http://127.0.0.1:{args.port}/"}))
            return
        except (OSError, ValueError):
            time.sleep(.2)
    raise SystemExit(f"Preview failed to become ready; inspect {directory / 'service.log'}")


if __name__ == "__main__":
    main()
