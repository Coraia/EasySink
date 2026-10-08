"""组装 tokenizer / L0 / L1 / L2 的管线。"""

from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from threading import RLock

from wise_reader import content, l0, l1, l2, render, semantics
from wise_reader.l1 import LLMClient, NullLLM
from wise_reader.lexicon import Lexicon
from wise_reader.models import Annotation
from wise_reader.profile import ReaderProfile
from wise_reader.store import Store
from wise_reader.store import _now
from wise_reader.source_cache import SourceCache
from wise_reader.source_urls import overlaps_url, url_ranges
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
        # Only content-derived analysis is cached. Personal selection stays live.
        self._analysis = OrderedDict()
        self._analysis_lock = RLock()
        self._analysis_tokens = 0
        self._source_cache = SourceCache(store, lexicon)

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

    def prepare_import(self, title, text, blocks):
        """Prepare content-derived analysis without touching the user Store."""
        doc = parse(text)
        candidates = l0.candidates(doc, self.lexicon)
        words = semantics.contextualize(doc, candidates)
        expressions = semantics.phrases(doc)
        row = {
            "title": title or _title_from(text), "text": text,
            "word_count": len(doc.tokens), "text_hash": text_hash(text),
            "l0_json": json.dumps([a.to_dict() for a in candidates], ensure_ascii=False),
            "l1_json": "[]", "created_at": _now(),
        }
        return {
            "row": row,
            "version": hashlib.sha256(text.encode()).hexdigest(),
            "blocks": json.dumps(blocks, ensure_ascii=False),
            "analysis": self._source_cache.prepare(words, expressions),
            "cache_key": self._source_cache.key(row),
        }

    def persist_import(self, prepared):
        """Caller owns a short book-wide atomic transaction; no analysis here."""
        row = prepared["row"]
        doc_id = int(self.store.execute(
            "INSERT INTO document(title,text,word_count,text_hash,l0_json,l1_json,created_at) "
            "VALUES(?,?,?,?,?,?,?)", tuple(row[k] for k in (
                "title", "text", "word_count", "text_hash", "l0_json", "l1_json", "created_at"
            ))
        ).lastrowid)
        self.store.execute("INSERT INTO wr_content(doc_id,version,blocks) VALUES(?,?,?)",
                           (doc_id, prepared["version"], prepared["blocks"]))
        self._source_cache.save_prepared({**row, "id": doc_id}, prepared["analysis"], prepared["cache_key"])
        return {"id": doc_id, "title": row["title"], "word_count": row["word_count"]}

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

    def _source_analysis(self, row):
        key = (row["id"], row["text_hash"], row["l1_json"])
        with self._analysis_lock:
            cached = self._analysis.get(key)
            if cached is not None and cached[0].text == row["text"]:
                self._analysis.move_to_end(key)
                return cached
        doc = parse(row["text"])
        persisted = self._source_cache.load(row, doc)
        if persisted is not None:
            words, expressions = persisted
        else:
            words = semantics.contextualize(doc, l0.candidates(doc, self.lexicon))
            expressions = [Annotation.from_dict(d) for d in _loads(row["l1_json"])]
            # Old tokenization split PDF ligatures: reject shifted annotations.
            expressions = [
                a for a in expressions
                if 0 <= a.first_token <= a.last_token < len(doc.tokens)
                and doc.text[slice(*doc.slice(a.first_token, a.last_token))] == a.surface
            ]
            expressions += semantics.phrases(doc)
            self._source_cache.save(row, words, expressions)
        result = (doc, words, expressions)
        with self._analysis_lock:
            # Token and entry bounds prevent a collection of large books accumulating.
            previous = self._analysis.pop(key, None)
            if previous is not None:
                self._analysis_tokens -= len(previous[0].tokens)
            if len(doc.tokens) <= 150000:
                self._analysis[key] = result
                self._analysis_tokens += len(doc.tokens)
            while self._analysis and (
                self._analysis_tokens > 150000 or len(self._analysis) > 4
            ):
                _, removed = self._analysis.popitem(last=False)
                self._analysis_tokens -= len(removed[0].tokens)
        return result

    def present(
        self,
        doc_id: int,
        profile: ReaderProfile,
        density: float | None = None,
        l1_stats: dict | None = None,
        compact: bool = False,
    ) -> dict:
        row = self.store.query_one(
            "SELECT id,title,text,word_count,text_hash,l1_json,created_at "
            "FROM document WHERE id=?", (doc_id,)
        )
        if row is None:
            raise KeyError(doc_id)
        doc, l0_cands, l1_cands = self._source_analysis(row)
        # Apply to every presentation, including old persisted and warm caches.
        # Keep canonical text/token IDs intact and free the budget for prose.
        urls = url_ranges(doc.text)
        if urls:
            l0_cands = [a for a in l0_cands if not overlaps_url(urls, *doc.slice(a.first_token, a.last_token))]
            l1_cands = [a for a in l1_cands if not overlaps_url(urls, *doc.slice(a.first_token, a.last_token))]
        verdicts = {
            r["target"]: r["verdict"]
            for r in self.store.query("SELECT * FROM wr_target")
        }
        shown = l2.filter_candidates(
            l0_cands, l1_cands, profile, len(doc.tokens), density, verdicts
        )
        frags = render.fragments(doc, shown) if not compact else []
        dens = profile.density if density is None else density
        version, blocks = content.get_content(self.store, row)
        rendered = []
        annotations = iter((a, *doc.slice(a.first_token, a.last_token)) for a in shown)
        current = next(annotations, None)
        for block in blocks:
            pieces = []
            pos = block["start"]
            while current is not None and current[1] < block["end"]:
                a, start, end = current
                current = next(annotations, None)
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
        result = {
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

        if compact:
            # The Web reader consumes canonical blocks, never these duplicate copies.
            for field in ("text", "fragments", "fragment_count"):
                result.pop(field)
        return result

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
