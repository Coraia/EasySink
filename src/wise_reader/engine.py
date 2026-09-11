"""组装 tokenizer / L0 / L1 / L2 的管线。"""

from __future__ import annotations

import hashlib

from wise_reader import l0, l1, l2, render
from wise_reader.l1 import LLMClient, NullLLM
from wise_reader.lexicon import Lexicon
from wise_reader.models import Annotation, Fragment
from wise_reader.profile import ReaderProfile
from wise_reader.store import Store
from wise_reader.tokenize import Document, parse


def text_hash(text: str) -> str:
    normalized = "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").split("\n"))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


class Engine:
    def __init__(self, lexicon: Lexicon, store: Store, llm: LLMClient | None = None, l1_enabled: bool = False):
        self.lexicon = lexicon
        self.store = store
        self.llm = llm or NullLLM()
        self.l1_enabled = l1_enabled

    def ingest(self, title: str, text: str, profile: ReaderProfile) -> dict:
        doc = parse(text)
        h = text_hash(text)
        l0_cands = l0.candidates(doc, self.lexicon)
        l1_cands, l1_stats = self._l1(doc, h)
        doc_id = self.store.save_document(
            title=title or _title_from(text),
            text=text,
            word_count=len(doc.tokens),
            text_hash=h,
            l0=l0_cands,
            l1=l1_cands,
        )
        return self.present(doc_id, profile, l1_stats=l1_stats)

    def _l1(self, doc: Document, h: str) -> tuple[list[Annotation], dict]:
        cached = self.store.get_l1_cache(h)
        if cached is not None:
            return cached, {"raw": len(cached), "dropped": 0, "calls": 0, "cache_hit": True}
        enabled = self.l1_enabled and not isinstance(self.llm, NullLLM)
        kept, stats = l1.generate(doc, self.llm, enabled=enabled)
        stats = {**stats, "cache_hit": False}
        if enabled:
            self.store.put_l1_cache(h, kept)
        return kept, stats

    def present(
        self,
        doc_id: int,
        profile: ReaderProfile,
        density: float | None = None,
        l1_stats: dict | None = None,
    ) -> dict:
        row = self.store.get_document(doc_id)
        if row is None:
            raise KeyError(doc_id)
        doc = parse(row["text"])
        l0_cands = [Annotation.from_dict(d) for d in _loads(row["l0_json"])]
        l1_cands = [Annotation.from_dict(d) for d in _loads(row["l1_json"])]
        shown = l2.filter_candidates(l0_cands, l1_cands, profile, len(doc.tokens), density)
        frags = render.fragments(doc, shown)
        dens = profile.density if density is None else density
        return {
            "id": doc_id,
            "title": row["title"],
            "word_count": row["word_count"],
            "annotation_count": len(shown),
            "density": dens,
            "density_actual": round(100 * len(shown) / max(row["word_count"], 1), 2),
            "fragments": [f.to_dict() for f in frags],
            "fragment_count": len(frags),
            "l1": l1_stats or {"cache_hit": True},
            "created_at": row["created_at"],
        }

    def lookup(self, word: str) -> dict:
        entry = self.lexicon.lookup(word)
        lemma = self.lexicon.lemma(word)
        if entry is None:
            return {"word": word, "lemma": lemma, "found": False}
        return {
            "word": word,
            "lemma": lemma,
            "found": True,
            "phonetic": entry.phonetic,
            "note": entry.gloss(),
            "detail": entry.translation.strip().splitlines()[0][:100] if entry.translation else "",
            "rank": entry.rank,
        }


def _title_from(text: str) -> str:
    line = text.strip().splitlines()[0] if text.strip() else "untitled"
    return line[:60]


def _loads(s: str) -> list:
    import json

    return json.loads(s)
