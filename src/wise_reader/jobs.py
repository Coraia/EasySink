"""Durable, serial AI jobs with per-chunk checkpoints and cooperative cancellation."""

from __future__ import annotations

import json
import threading

from fastapi import HTTPException

from wise_reader.engine import text_hash
from wise_reader.tokenize import parse


def chunks(text, n=1400):
    while text:
        end = min(n, len(text))
        if end < len(text):
            split = max(
                text.rfind("\n", 0, end),
                text.rfind(". ", 0, end),
                text.rfind(" ", 0, end),
            )
            if split > n // 2:
                end = split + 1
        part = text[:end].strip()
        text = text[end:]
        if part:
            yield part


class Jobs:
    def __init__(self, store, engine):
        self.store = store
        self.engine = engine
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        store.executescript("""CREATE TABLE IF NOT EXISTS wr_job(
          id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, status TEXT NOT NULL,
          doc_ids TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
          results TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
        """)
        store.execute("UPDATE wr_job SET status='queued' WHERE status='running'")
        self.thread = None

    def start(self):
        self.thread = threading.Thread(
            target=self.run, name="wise-reader-jobs", daemon=True
        )
        self.thread.start()

    def close(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=35)

    def payload(self, row):
        return {k: v for k, v in row.items() if k != "results"} | {
            "doc_ids": json.loads(row["doc_ids"])
        }

    def enqueue(self, ids, kind="translate"):
        if not self.engine.l1_enabled:
            raise HTTPException(409, "AI 尚未配置；仍可阅读、标注和粘贴译文")
        if not ids:
            raise HTTPException(400, "没有可处理的章节")
        total = 0
        for id in ids:
            row = self.store.get_document(id)
            if not row:
                raise HTTPException(404, "章节不存在")
            total += len(list(chunks(row["text"]))) if kind == "translate" else 1
        if kind == "annotations" and any(
            len(self.store.get_document(i)["text"]) > 20000 for i in ids
        ):
            raise HTTPException(
                400, "增强注释暂限每章 20,000 字符，请拆分长章；词典注释仍可使用"
            )
        with self.store.transaction():
            duplicate = self.store.query_one(
                "SELECT * FROM wr_job WHERE kind=? AND doc_ids=? AND status IN ('queued','running')",
                (kind, json.dumps(ids)),
            )
            if duplicate:
                return self.payload(duplicate)
            cur = self.store.execute(
                "INSERT INTO wr_job(kind,status,doc_ids,total) VALUES(?,'queued',?,?)",
                (kind, json.dumps(ids), total),
            )
        self.wake.set()
        return self.payload(
            self.store.query_one("SELECT * FROM wr_job WHERE id=?", (cur.lastrowid,))
        )

    def control(self, id, action):
        row = self.store.query_one("SELECT * FROM wr_job WHERE id=?", (id,))
        if not row:
            raise HTTPException(404, "任务不存在")
        if action == "cancel" and row["status"] in ("queued", "running"):
            self.store.execute("UPDATE wr_job SET status='cancelled' WHERE id=?", (id,))
        elif action == "retry" and row["status"] in ("failed", "cancelled"):
            self.store.execute(
                "UPDATE wr_job SET status='queued', error='' WHERE id=?", (id,)
            )
            self.wake.set()
        return self.payload(
            self.store.query_one("SELECT * FROM wr_job WHERE id=?", (id,))
        )

    def run(self):
        while not self.stop_event.is_set():
            row = self.store.query_one(
                "SELECT * FROM wr_job WHERE status='queued' ORDER BY id LIMIT 1"
            )
            if not row:
                self.wake.wait(1)
                self.wake.clear()
                continue
            self.process(row)

    def process(self, row):
        id = row["id"]
        results = json.loads(row["results"])
        units = []
        try:
            for doc_id in json.loads(row["doc_ids"]):
                doc = self.store.get_document(doc_id)
                if not doc:
                    raise ValueError("原章节已删除")
                units += [
                    (doc_id, text)
                    for text in (
                        list(chunks(doc["text"]))
                        if row["kind"] == "translate"
                        else [doc["text"]]
                    )
                ]
            self.store.execute(
                "UPDATE wr_job SET status='running' WHERE id=? AND status='queued'",
                (id,),
            )
            for index in range(row["cursor"], len(units)):
                current = self.store.query_one(
                    "SELECT status FROM wr_job WHERE id=?", (id,)
                )
                if self.stop_event.is_set() or current["status"] != "running":
                    return
                if row["kind"] == "translate" and not self.store.is_plugin_enabled(
                    "translate"
                ):
                    raise ValueError("翻译插件已关闭，开启后可重试")
                if not self.engine.l1_enabled:
                    raise ValueError("AI 已关闭，重新启用后可重试")
                doc_id, text = units[index]
                if row["kind"] == "translate":
                    output = self.engine.llm.chat(
                        "将英文忠实地译为流畅中文。保留段落，只输出译文。", text
                    ).strip()
                    if not output:
                        raise ValueError("模型返回了空译文")
                else:
                    annos, stats = self.engine._l1(parse(text), text_hash(text))
                    if stats.get("failed"):
                        raise ValueError("模型注释失败，可重试")
                    output = [a.to_dict() for a in annos]
                with self.store.transaction():
                    if (
                        self.store.query_one(
                            "SELECT status FROM wr_job WHERE id=?", (id,)
                        )["status"]
                        != "running"
                    ):
                        return
                    results.append({"doc_id": doc_id, "body": output})
                    self.store.execute(
                        "UPDATE wr_job SET cursor=?,results=? WHERE id=?",
                        (index + 1, json.dumps(results, ensure_ascii=False), id),
                    )
                    if row["kind"] == "annotations":
                        self.store.execute(
                            "UPDATE document SET l1_json=? WHERE id=?",
                            (json.dumps(output, ensure_ascii=False), doc_id),
                        )
                    elif index == len(units) - 1 or units[index + 1][0] != doc_id:
                        body = "\n\n".join(
                            r["body"] for r in results if r["doc_id"] == doc_id
                        )
                        self.store.execute(
                            "INSERT OR REPLACE INTO wr_translation VALUES(?,'zh',?,'llm',datetime('now'))",
                            (doc_id, body),
                        )
            self.store.execute(
                "UPDATE wr_job SET status='complete' WHERE id=? AND status='running'",
                (id,),
            )
        except Exception as exc:
            # Keep credentials/provider response bodies out of user-visible errors.
            error = (
                str(exc)
                if isinstance(exc, ValueError)
                else f"服务调用失败（{type(exc).__name__}），已保留完成的分段"
            )
            self.store.execute(
                "UPDATE wr_job SET status='failed',error=? WHERE id=? AND status='running'",
                (error[:200], id),
            )
