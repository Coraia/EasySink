"""确定性分句与分词，为全部标注层提供统一的 token 坐标系。

所有标注一律用 token id 区间表达位置。模型永远不接触也不复述原文。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_WORD = re.compile(r"[A-Za-z]+(?:['\u2019\-][A-Za-z]+)*")

_ABBREV = frozenset(
    """mr mrs ms dr prof sr jr st vs etc al inc ltd co corp dept est fig
    no vol pp approx jan feb mar apr jun jul aug sep sept oct nov dec
    mon tue wed thu fri sat sun ave blvd rd apt univ""".split()
)

_SENT_END = re.compile(r"[.!?\u2026]+[\"'\u201d\u2019)\]]*")


@dataclass(frozen=True, slots=True)
class Token:
    id: int
    text: str
    start: int
    end: int
    sent_id: int

    @property
    def key(self) -> str:
        return self.text.lower().replace("\u2019", "'")


@dataclass(frozen=True, slots=True)
class Sentence:
    id: int
    start: int
    end: int
    first_token: int
    last_token: int


@dataclass(slots=True)
class Document:
    text: str
    tokens: list[Token]
    sentences: list[Sentence]

    def slice(self, first_token: int, last_token: int) -> tuple[int, int]:
        return self.tokens[first_token].start, self.tokens[last_token].end

    def numbered_sentences(self) -> list[str]:
        out = []
        for sent in self.sentences:
            parts = []
            pos = sent.start
            for t in self.tokens[sent.first_token : sent.last_token + 1]:
                parts.append(self.text[pos : t.start] + f"<{t.id}>" + t.text)
                pos = t.end
            parts.append(self.text[pos : sent.end])
            out.append(f"[S{sent.id}] " + "".join(parts))
        return out

    def reconstruct(self) -> str:
        """用 token 偏移把原文拼回去。任何偏移错误都会让结果 != text。"""
        parts: list[str] = []
        pos = 0
        for t in self.tokens:
            parts.append(self.text[pos : t.start])
            parts.append(t.text)
            pos = t.end
        parts.append(self.text[pos:])
        return "".join(parts)


def _split_sentences(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    start = 0
    for m in _SENT_END.finditer(text):
        end = m.end()
        before = text[max(0, m.start() - 12) : m.start()]
        last_word = _WORD.findall(before)
        if m.group().startswith(".") and last_word and last_word[-1].lower() in _ABBREV:
            continue
        if (
            m.group().startswith(".")
            and before
            and before[-1:].isalpha()
            and (len(before) < 2 or not before[-2:-1].isalpha())
        ):
            continue
        if end < len(text) and not text[end].isspace():
            continue
        if end > start:
            spans.append((start, end))
        start = end
    if start < len(text) and text[start:].strip():
        spans.append((start, len(text)))
    return spans


def parse(text: str) -> Document:
    sent_spans = _split_sentences(text)
    if not sent_spans:
        sent_spans = [(0, len(text))] if text.strip() else []

    tokens: list[Token] = []
    sentences: list[Sentence] = []

    for _sent_id, (s_start, s_end) in enumerate(sent_spans):
        first = len(tokens)
        for m in _WORD.finditer(text, s_start, s_end):
            tokens.append(
                Token(
                    id=len(tokens),
                    text=m.group(),
                    start=m.start(),
                    end=m.end(),
                    sent_id=len(sentences),
                )
            )
        if len(tokens) == first:
            continue
        sentences.append(
            Sentence(
                id=len(sentences),
                start=s_start,
                end=s_end,
                first_token=first,
                last_token=len(tokens) - 1,
            )
        )

    return Document(text=text, tokens=tokens, sentences=sentences)
