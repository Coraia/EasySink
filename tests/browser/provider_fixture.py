"""Deterministic HTTP fixture, not a real translation or voice quality evaluation."""

import io
import json
import math
import struct
import threading
import time
import re
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
                    user = p["messages"][-1]["content"]
                    try:
                        selection = json.loads(user)
                    except ValueError:
                        selection = {}
                    task = selection.get("task", "legacy")
                    observed["chat"].append({"model": p["model"], "task": task, "source": selection.get("source"), "context": selection.get("context"), "traces": selection.get("traces")})
                    if p["model"] == "slow-assist":
                        time.sleep(1.2)
                    if p["model"] == "broken-json":
                        self.send(200, b"not json")
                        return
                    system = p["messages"][0]["content"]
                    if task == "selection-translation":
                        source = selection["source"]
                        pieces = re.findall(r"[^,;.!?]+[,;.!?]*", source)
                        content = json.dumps({"segments": [{"quote": text.lstrip(), "zh": "测试译文：" + str(i + 1)} for i, text in enumerate(pieces) if text.strip()]})
                        if p["model"] == "bad-alignment":
                            content = '{"segments":[{"quote":"invented source","zh":"虚构对应"}]}'
                    elif task == "context-meaning":
                        content = '{"meaning":"此处为令人信服的力量","explanation":"依据所选词附近的论证语境判断，区别于法律定罪。"}'
                        if p["model"] == "long-context":
                            content = json.dumps({"meaning": "用于测试卡片滚动的上下文解释", "explanation": "这是本机验收用的长解释，检查滚动范围与边界。" * 35}, ensure_ascii=False)
                    elif task == "reading-review":
                        content = '{"body":"AI 回顾草稿：保留读者的原始笔记，复习请求过的句子结构与词义。"}'
                    elif task == "grammar-map":
                        source = selection["source"]
                        tokens = list(re.finditer(r"\S+", source))
                        def bounds(quote):
                            start = source.find(quote)
                            end = start + len(quote)
                            indices = [i for i, m in enumerate(tokens) if m.start() < end and m.end() > start]
                            return {"first": indices[0], "last": indices[-1]} if indices else {"first": 0, "last": len(tokens)-1}
                        nodes = [{"id": "overview", "parent": None, "label": "整句", "explanation": "主干与原因，原因包含两个并列内容从句。", "kind": "clause", "ranges": [bounds(source)]}]
                        parts = [
                            ("main", "overview", "主干", "The reasoning of these two men did not carry conviction", "这两个人的论证未能令人信服。"),
                            ("cause", "overview", "原因：since", "since it was felt", "since 引出原因，it 是形式主语。"),
                            ("felt", "cause", "无人称表达", "it was felt", "不是指向某物的 it；后面两个 that 从句是认为的内容。"),
                            ("content-one", "cause", "第一项内容", "the Absolute or Inﬁnite does not necessarily exist outside of all relations, but can enter into various relations", "不一定在一切关系之外，也可进入关系。"),
                            ("content-two", "cause", "第二项内容", "the fact that we know things only in their relations does not mean that the knowledge so acquired is merely a relative or unreal knowledge", "the fact … does not mean that …"),
                            ("fact", "content-two", "同位语从句", "that we know things only in their relations", "说明 the fact 的内容。"),
                            ("modifier", "content-two", "过去分词后置修饰", "so acquired", "修饰 knowledge，以这种方式获得。"),
                            ("so", "modifier", "so 的回指", "so", "回指通过关系认识事物的方式。relative 不等于 unreal。"),
                        ]
                        for id, parent, label, quote, explanation in parts:
                            if quote in source:
                                nodes.append({"id": id, "parent": parent, "label": label, "explanation": explanation, "kind": "reference" if id == "so" else "clause", "ranges": [bounds(quote), bounds("that we know things only in their relations")] if id == "so" else [bounds(quote)]})
                        if len(nodes) == 1:
                            nodes.append({"id": "main", "parent": "overview", "label": "主干", "explanation": "确定性语法样例，仅供链路验收。", "kind": "clause", "ranges": [bounds(source)]})
                        if p["model"] == "bad-grammar":
                            nodes[-1]["parent"] = nodes[-1]["id"]
                        content = json.dumps({"summary": "先读主干，再读 since 引出的原因；两个 that 内容并列。", "nodes": nodes}, ensure_ascii=False)
                    else:
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
