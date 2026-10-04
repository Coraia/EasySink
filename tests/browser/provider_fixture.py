"""Deterministic HTTP fixture, not a real translation or voice quality evaluation."""

import io
import json
import math
import struct
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Provider:
    def __init__(self):
        self.observed = {"speech": [], "chat": []}
        observed = self.observed

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, code, body, kind="application/json"):
                self.send_response(code)
                self.send_header("Content-Type", kind)
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                self.send(200, json.dumps(observed).encode())

            def do_POST(self):
                p = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.headers.get("Authorization") != "Bearer e2e-no-secret":
                    self.send(401, b'{"error":"invalid fixture credential"}')
                    return
                if self.path == "/v1/chat/completions":
                    observed["chat"].append({"model": p["model"]})
                    if p["model"] == "broken-json":
                        self.send(200, b"not json")
                        return
                    system = p["messages"][0]["content"]
                    content = (
                        "OK"
                        if "Connection test." in p["messages"][-1]["content"]
                        else '{"annotations":[{"first_token":0,"last_token":1,"kind":"culture","note":"测试背景","detail":"确定性测试注释","difficulty":3}]}'
                        if "annotations" in system
                        else "测试译文：好奇心让故事继续。"
                    )
                    self.send(
                        200,
                        json.dumps(
                            {"choices": [{"message": {"content": content}}]},
                            ensure_ascii=False,
                        ).encode(),
                    )
                    return
                if self.path == "/v1/audio/speech":
                    observed["speech"].append(p)
                    if p.get("voice") == "bad-audio":
                        self.send(200, b'{"error":"invalid audio fixture"}')
                        return
                    if p.get("voice") == "slow":
                        time.sleep(1.2)
                    buffer = io.BytesIO()
                    with wave.open(buffer, "wb") as out:
                        out.setnchannels(1)
                        out.setsampwidth(2)
                        out.setframerate(16000)
                        out.writeframes(
                            b"".join(
                                struct.pack(
                                    "<h",
                                    int(800 * math.sin(2 * math.pi * 440 * i / 16000)),
                                )
                                for i in range(16000 * 4)
                            )
                        )
                    self.send(200, buffer.getvalue(), "audio/wav")
                    return
                self.send(404, b"{}")

        self.server = ThreadingHTTPServer(("127.0.0.1", 18768), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
