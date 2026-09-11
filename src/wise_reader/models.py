"""标注与分片的统一数据模型。"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import StrEnum
from typing import Any


class Kind(StrEnum):
    WORD = "word"
    PHRASE = "phrase"
    GRAMMAR = "grammar"
    CULTURE = "culture"


@dataclass(slots=True)
class Annotation:
    first_token: int
    last_token: int
    kind: Kind
    note: str
    surface: str = ""
    rarity: int = 0
    lemma: str = ""
    domain: str | None = None
    detail: str = ""
    forced: bool = False
    suppressed: bool = False
    source: str = "dictionary"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["kind"] = self.kind.value
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Annotation:
        return cls(
            first_token=int(d["first_token"]),
            last_token=int(d["last_token"]),
            kind=Kind(d["kind"]),
            note=d.get("note") or "",
            surface=d.get("surface") or "",
            rarity=int(d.get("rarity") or 0),
            lemma=d.get("lemma") or "",
            domain=d.get("domain"),
            detail=d.get("detail") or "",
            forced=bool(d.get("forced")),
            suppressed=bool(d.get("suppressed")),
            source=d.get("source", "dictionary"),
        )


@dataclass(slots=True)
class Fragment:
    type: str  # plain | anno
    text: str
    note: str = ""
    detail: str = ""
    lemma: str = ""
    kind: str = ""
    anno_id: int | None = None
    first_token: int | None = None
    last_token: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "text": self.text,
            "note": self.note,
            "detail": self.detail,
            "lemma": self.lemma,
            "kind": self.kind,
            "id": self.anno_id,
            "first_token": self.first_token,
            "last_token": self.last_token,
        }
