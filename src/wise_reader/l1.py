"""L1 模型层：习语 / 语法 / 文化。失败或未配置时返回空列表，阅读不中断。"""

from __future__ import annotations

import json
import re
from typing import Any, Protocol

import httpx

from wise_reader.models import Annotation, Kind
from wise_reader.tokenize import Document

ALLOWED_KINDS = {Kind.PHRASE, Kind.GRAMMAR, Kind.CULTURE}
ALLOWED_DOMAINS = {
    "tech",
    "business",
    "politics",
    "religion",
    "sports",
    "pop",
    "science",
    "medicine",
    "law",
    "history",
    "military",
    "slang",
}

PROMPT = """你是英文阅读注释器。只标注词典无法表达的三类：phrase（习语/搭配，整体含义≠字面之和）、grammar（结构障碍）、culture（典故/梗/背景）。
禁止输出单个普通生词的释义。
只引用给定的 token 编号，不得复述或改写原文。
宁缺毋滥：没有值得标的就返回空数组。单篇最多 8 条。
note 用中文解释（不是翻译），不超过 20 个中文字符。detail 不超过 100 字。
输出严格 JSON，无额外文字：
{"annotations":[{"first_token":0,"last_token":0,"kind":"culture","note":"...","detail":"...","domain":"sports","difficulty":3}]}
kind 只能是 phrase/grammar/culture。domain 为 tech/business/politics/religion/sports/pop/science/medicine/law/history/military/slang 或 null。
difficulty 1-5。
"""


class LLMClient(Protocol):
    def complete(self, prompt: str, numbered: str) -> dict[str, Any]: ...


class NullLLM:
    def complete(self, prompt: str, numbered: str) -> dict[str, Any]:
        return {"annotations": []}

    def chat(self, system: str, user: str) -> str:
        return ""


class OpenAICompatLLM:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def complete(self, prompt: str, numbered: str) -> dict[str, Any]:
        return _parse_json(self.chat(prompt, numbered))

    def chat(self, system: str, user: str) -> str:
        url = f"{self.base_url}/chat/completions"
        payload = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        with httpx.Client(timeout=self.timeout) as client:
            r = client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]


def _parse_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def validate(raw: dict[str, Any], doc: Document) -> tuple[list[Annotation], int, int]:
    """返回 (合法标注, 原始条数, 丢弃条数)。"""
    if not isinstance(raw, dict):
        raise ValueError("模型未返回 JSON 对象")
    items = raw.get("annotations") or []
    if not isinstance(items, list):
        raise ValueError("annotations 必须是数组")
    kept: list[Annotation] = []
    dropped = 0
    n = len(doc.tokens)
    for item in items[:8]:
        try:
            first = int(item["first_token"])
            last = int(item["last_token"])
            kind = Kind(item["kind"])
            note = str(item.get("note") or "").strip()
            difficulty = max(1, min(5, int(item.get("difficulty") or 3)))
        except (KeyError, TypeError, ValueError):
            dropped += 1
            continue
        if not (0 <= first <= last < n):
            dropped += 1
            continue
        if doc.tokens[first].sent_id != doc.tokens[last].sent_id:
            dropped += 1
            continue
        if last - first + 1 > 12:
            dropped += 1
            continue
        if not note or len(note) > 40:
            dropped += 1
            continue
        if kind not in ALLOWED_KINDS:
            dropped += 1
            continue
        # 行内 note 再压到 20 字
        if len(note) > 20:
            note = note[:20]
        domain = item.get("domain")
        if domain not in ALLOWED_DOMAINS:
            domain = None
        start, end = doc.slice(first, last)
        kept.append(
            Annotation(
                first_token=first,
                last_token=last,
                kind=kind,
                note=note,
                surface=doc.text[start:end],
                rarity=difficulty * 10_000,
                lemma="",
                domain=domain,
                detail=str(item.get("detail") or "")[:100],
            )
        )
    return kept, len(items), dropped


def generate(
    doc: Document,
    client: LLMClient,
    enabled: bool = True,
) -> tuple[list[Annotation], dict[str, int]]:
    stats = {"raw": 0, "dropped": 0, "calls": 0}
    if not enabled:
        return [], stats
    numbered = "\n".join(doc.numbered_sentences())
    if not numbered.strip():
        return [], stats
    try:
        stats["calls"] = 1
        raw = client.complete(PROMPT, numbered)
        kept, raw_n, dropped = validate(raw, doc)
    except Exception as e:
        return [], {**stats, "failed": True, "error": type(e).__name__}
    stats["raw"] = raw_n
    stats["dropped"] = dropped
    if raw_n and dropped == raw_n:
        stats["failed"] = True
    return kept, stats
