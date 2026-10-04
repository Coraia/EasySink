"""组装 tokenizer / L0 / L1 / L2 的管线。"""

from __future__ import annotations

import hashlib

from wise_reader import content, l0, l1, l2, render, semantics
from wise_reader.l1 import LLMClient, NullLLM
from wise_reader.lexicon import Lexicon
from wise_reader.models import Annotation
from wise_reader.profile import ReaderProfile
from wise_reader.store import Store
from wise_reader.tokenize import Document, parse


def text_hash(text: str) -> str:
    normalized = "\n".join(
        line.rstrip() for line in text.replace("\r\n", "\n").split("\n")
    )
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


class Engine:
    def __init__(
        self,
        lexicon: Lexicon,
        store: Store,
        llm: LLMClient | None = None,
        l1_enabled: bool = False,
    ):
        self.lexicon = lexicon
        self.store = store
        self.llm = llm or NullLLM()
        self.l1_enabled = l1_enabled

    def ingest(
        self, title: str, text: str, profile: ReaderProfile, analyze: bool = True
    ) -> dict:
        doc = parse(text)
        h = text_hash(text)
        l0_cands = l0.candidates(doc, self.lexicon)
        l1_cands, l1_stats = (
            self._l1(doc, h) if analyze else ([], {"pending": self.l1_enabled})
        )
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
        client = self.llm
        enabled = self.l1_enabled and not isinstance(client, NullLLM)
        h = text_hash(
            h
            + "|punctuated-v2|"
            + getattr(client, "base_url", "")
            + "|"
            + getattr(client, "model", "offline")
        )
        cached = self.store.get_l1_cache(h)
        if cached is not None:
            return cached, {
                "raw": len(cached),
                "dropped": 0,
                "calls": 0,
                "cache_hit": True,
            }
        kept, stats = l1.generate(doc, client, enabled=enabled)
        stats = {**stats, "cache_hit": False}
        if enabled and not stats.get("failed"):
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
        l0_cands = semantics.contextualize(doc, l0.candidates(doc, self.lexicon))
        l1_cands = [Annotation.from_dict(d) for d in _loads(row["l1_json"])]
        l1_cands += semantics.phrases(doc)
        verdicts = {
            r["target"]: r["verdict"]
            for r in self.store.query("SELECT * FROM wr_target")
        }
        shown = l2.filter_candidates(
            l0_cands, l1_cands, profile, len(doc.tokens), density, verdicts
        )
        frags = render.fragments(doc, shown)
        dens = profile.density if density is None else density
        version, blocks = content.get_content(self.store, row)
        rendered = []
        for block in blocks:
            pieces = []
            pos = block["start"]
            for a in shown:
                start, end = doc.slice(a.first_token, a.last_token)
                if start < block["start"] or end > block["end"]:
                    continue
                if start > pos:
                    pieces.append({"type": "plain", "text": doc.text[pos:start]})
                pieces.append(
                    {
                        "type": "anno",
                        "text": doc.text[start:end],
                        "note": a.note,
                        "detail": a.detail,
                        "lemma": a.lemma,
                        "kind": a.kind.value,
                        "target": semantics.target(a),
                        "source": a.source
                        if a.kind.value == "word" or a.source != "dictionary"
                        else "model",
                        "start": start - block["start"],
                        "end": end - block["start"],
                    }
                )
                pos = end
            if pos < block["end"]:
                pieces.append({"type": "plain", "text": doc.text[pos : block["end"]]})
            rendered.append({**block, "fragments": pieces})
        chapter = self.store.query_one(
            "SELECT * FROM wr_chapter WHERE doc_id=?", (doc_id,)
        )
        siblings = (
            self.store.query(
                "SELECT doc_id,title,idx FROM wr_chapter WHERE book_id=? ORDER BY idx",
                (chapter["book_id"],),
            )
            if chapter
            else []
        )
        return {
            "id": doc_id,
            "text": row["text"],
            "version": version,
            "blocks": rendered,
            "chapter": chapter,
            "chapters": siblings,
            "forced_count": sum(a.forced for a in shown),
            "automatic_count": sum(not a.forced for a in shown),
            "automatic_budget": max(1, round(len(doc.tokens) * dens / 100))
            if dens > 0
            else 0,
            "archived": bool(
                self.store.query_one(
                    "SELECT doc_id FROM wr_archive WHERE doc_id=?", (doc_id,)
                )
            ),
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
            "detail": entry.translation.strip().splitlines()[0][:100]
            if entry.translation
            else "",
            "rank": entry.rank,
        }


def _title_from(text: str) -> str:
    line = text.strip().splitlines()[0] if text.strip() else "untitled"
    return line[:60]


def _loads(s: str) -> list:
    import json

    return json.loads(s)
