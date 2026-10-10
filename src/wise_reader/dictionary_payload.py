"""Lossless ECDICT candidates, not contextual disambiguation.

ECDICT has unaligned Chinese/English text lines, not bilingual sense IDs.
Line IDs below are local presentation IDs. Never pair lines by their index.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass
from functools import lru_cache

PAYLOAD_VERSION = "ecdict-candidates-v2"
SOURCE = {
    "id": "ecdict",
    "name": "ECDICT",
    "url": "https://github.com/skywind3000/ECDICT",
    "license": "MIT (ECDICT repository)",
    "version": "local snapshot",
}

_POS = re.compile(
    r"^(?:(?:n|v|a|ad|adj|adv|vt|vi|prep|conj|pron|art|num|int|aux|abbr|u|c)"
    r"\.\s*(?:[&/]\s*)?)+", re.IGNORECASE,
)
_LABEL = re.compile(r"^\[([^\]]+)\]\s*")
# Source labels only: this mapping classifies metadata, never a sentence's meaning.
_DOMAINS = frozenset({
    "计", "医", "法", "化", "经", "电", "机", "数", "物", "生", "建", "宗",
    "军", "地", "商", "航", "植", "动", "心理", "逻", "语",
    "computing", "computer science", "typography", "printing", "biology",
    "christian theology", "theology", "christianity", "religion", "bible",
    "greek mythology", "mathematics", "physics", "chemistry", "medicine", "law",
})


@dataclass(frozen=True, slots=True)
class Sense:
    id: str
    language: str
    pos: str
    domains: tuple[str, ...]
    labels: tuple[str, ...]
    text: str
    raw: str
    field: str
    line: int
    source: str = "ecdict"

    def to_dict(self):
        value = asdict(self)
        value["domains"] = list(self.domains)
        value["labels"] = list(self.labels)
        return value


@lru_cache(maxsize=8192)
def parse_senses(translation: str, definition: str) -> tuple[Sense, ...]:
    result = []
    for field, language, value in (
        ("translation", "zh", translation), ("definition", "en", definition),
    ):
        for number, raw in enumerate(value.splitlines(), 1):
            text = raw.strip()
            if not text:
                continue
            pos, labels = [], []
            # ECDICT mixes "n. [计] ..." and "[计] n. ...".
            while text:
                match = _POS.match(text)
                label = _LABEL.match(text)
                if match:
                    pos.append(match.group().strip().rstrip("&/ "))
                    text = text[match.end():].lstrip()
                elif label:
                    labels.append(label[1])
                    text = text[label.end():].lstrip()
                else:
                    break
            paren = re.match(r"^\(([^)]+)\)", text)
            if paren and paren[1].lower() in _DOMAINS:
                labels.append(paren[1])
                # Keep the parenthetical in the original gloss too.
            identity = hashlib.sha256(f"{field}:{number}:{raw}".encode()).hexdigest()[:16]
            result.append(Sense(
                f"ecdict-line:{identity}", language, " ".join(pos),
                tuple(x for x in labels if x.lower() in _DOMAINS), tuple(labels),
                text, raw, field, number,
            ))
    return tuple(result)


def full_detail(translation: str, definition: str, extra: str = "") -> str:
    parts = [translation.strip()] if translation.strip() else []
    if definition.strip():
        parts.append("英文释义（独立候选）:\n" + definition.strip())
    if extra.strip():
        parts.append("词库补充资料:\n" + extra.strip())
    return "\n\n".join(parts)


def compact_gloss(senses: tuple[Sense, ...], max_len: int) -> str:
    if max_len <= 0:
        return ""
    preferred = [s for s in senses if s.language == "zh"]
    if not preferred:
        preferred = [s for s in senses if s.language == "en"]
    if not preferred:
        return ""
    # Surface later domain lines before other POS groups; no context inference.
    ordered = preferred[:1] + [s for s in preferred[1:] if s.domains]
    ordered += [s for s in preferred[1:] if not s.domains]
    parts = []
    for sense in ordered:
        value = ("".join(f"[{label}]" for label in sense.labels)
                 + re.sub(r"\s+", " ", sense.text))
        if sense.language == "zh":
            value = re.sub(r"([,，;；])\s+", r"\1", value)
        if value and value not in parts:
            parts.append(value)
    full = " / ".join(parts)
    if len(full) <= max_len:
        return full
    # Reserve space for each line instead of silently dropping later meanings.
    snippets = []
    room = max_len - 1
    for i, part in enumerate(parts):
        separator = 3 if snippets else 0
        if room <= separator:
            break
        allowance = max(1, (room - separator - 3 * (len(parts) - i - 1)) // (len(parts) - i))
        if len(part) <= allowance:
            snippet = part
        elif preferred[0].language == "zh":
            # Use complete comma/semicolon-delimited alternatives where possible.
            chunk = re.split(r"[,，;；]", part)[0]
            snippet = chunk if len(chunk) <= allowance else part[:max(0, allowance - 1)] + "…"
        else:
            snippet = part[:allowance].rsplit(" ", 1)[0] if " " in part[:allowance] else "…"
        snippets.append(snippet)
        room -= len(snippet) + separator
    return (" / ".join(snippets) + "…")[:max_len]
