"""读者模型：决定"什么该标、什么不该标"的全部个人化参数。"""

from __future__ import annotations

from dataclasses import dataclass, field

DOMAINS: dict[str, str] = {
    "tech": "科技 / IT",
    "business": "商业 / 金融",
    "politics": "政治 / 时事",
    "religion": "宗教 / 神学",
    "sports": "体育",
    "pop": "流行文化 / 影视梗",
    "science": "自然科学",
    "medicine": "医学 / 健康",
    "law": "法律",
    "history": "历史 / 文学典故",
    "military": "军事",
    "slang": "俚语 / 网络用语",
}

EXAM_VOCAB: dict[str, int] = {
    "gaokao": 3500,
    "cet4": 4500,
    "cet6": 6000,
    "kaoyan": 6500,
    "ielts": 8000,
    "toefl": 8000,
    "gre": 12000,
}


@dataclass(slots=True)
class ReaderProfile:
    vocab_size: int = 8000
    known: set[str] = field(default_factory=set)
    unknown: set[str] = field(default_factory=set)
    domains: set[str] = field(default_factory=set)  # Legacy familiarity; retained, not reinterpreted.
    density: float = 4.0
    repeat: bool = False
    l1_enabled: bool = True
    # Append to preserve legacy positional constructors (including CLI callers).
    focus_domains: set[str] = field(default_factory=set)

    def rank_threshold(self) -> int:
        return max(500, self.vocab_size)

    def budget(self, word_count: int) -> int:
        return max(1, round(word_count * self.density / 100))

    def knows(self, lemma: str) -> bool:
        return lemma in self.known

    def struggles_with(self, lemma: str) -> bool:
        return lemma in self.unknown
