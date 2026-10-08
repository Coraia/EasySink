"""Discardable local cache of content analysis, never of personal selection."""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import zlib
from pathlib import Path

from wise_reader.models import Annotation, Kind

log = logging.getLogger(__name__)
MAX_BYTES = 32 * 1024 * 1024
MAX_EXPANDED = 16 * 1024 * 1024


class SourceCache:
    def __init__(self, store, lexicon):
        self.store = store
        revision = hashlib.sha256(b"source-analysis-v1")
        for name in ("tokenize.py", "l0.py", "lexicon.py", "semantics.py", "models.py", "engine.py", "source_cache.py"):
            revision.update((Path(__file__).parent / name).read_bytes())
        for path in (lexicon.db_path, lexicon.lemma_path):
            stat = path.stat() if path.exists() else None
            revision.update(str((str(path.resolve()), stat.st_size if stat else 0,
                                 stat.st_mtime_ns if stat else 0)).encode())
        self.revision = revision.hexdigest()
        store.executescript("""
            CREATE TABLE IF NOT EXISTS wr_source_analysis (
                doc_id INTEGER PRIMARY KEY,
                cache_key TEXT NOT NULL,
                payload BLOB NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
        """)

    def key(self, row):
        key = hashlib.sha256(self.revision.encode())
        key.update(row["text"].encode())
        key.update(row["l1_json"].encode())
        return key.hexdigest()

    def load(self, row, doc):
        try:
            cached = self.store.query_one(
                "SELECT payload FROM wr_source_analysis WHERE doc_id=? AND cache_key=?",
                (row["id"], self.key(row)),
            )
            if not cached or len(cached["payload"]) > MAX_BYTES:
                return None
            decoder = zlib.decompressobj()
            raw = decoder.decompress(cached["payload"], MAX_EXPANDED + 1)
            if len(raw) > MAX_EXPANDED or not decoder.eof or decoder.unused_data:
                return None
            entries, words, expressions = json.loads(raw)

            def restore(spans):
                result = []
                for first, last, index in spans:
                    if not 0 <= first <= last < len(doc.tokens):
                        raise ValueError("Cached token range no longer valid")
                    if not 0 <= index < len(entries):
                        raise ValueError("Cached entry index no longer valid")
                    kind, note, rarity, lemma, domain, detail, forced, suppressed, source = entries[index]
                    result.append(Annotation(
                        first, last, Kind(kind), note,
                        doc.text[slice(*doc.slice(first, last))], rarity,
                        lemma, domain, detail, forced, suppressed, source,
                    ))
                return result

            return restore(words), restore(expressions)
        except (sqlite3.Error, ValueError, TypeError, KeyError, IndexError, zlib.error):
            log.warning("Discarding unavailable or invalid source analysis cache for %s", row["id"])
            return None

    @staticmethod
    def prepare(words, expressions):
        """CPU/serialization work must happen outside the shared DB transaction."""
        entries, indices = [], {}

        def pack(annotations):
            spans = []
            for a in annotations:
                entry = (a.kind.value, a.note, a.rarity, a.lemma, a.domain,
                         a.detail, a.forced, a.suppressed, a.source)
                if entry not in indices:
                    indices[entry] = len(entries)
                    entries.append(entry)
                spans.append((a.first_token, a.last_token, indices[entry]))
            return spans

        word_spans, expression_spans = pack(words), pack(expressions)
        raw = json.dumps([entries, word_spans, expression_spans], ensure_ascii=False,
                         separators=(",", ":")).encode()
        return zlib.compress(raw, level=1) if len(raw) <= MAX_EXPANDED else None

    def save(self, row, words, expressions):
        self.save_prepared(row, self.prepare(words, expressions))

    def save_prepared(self, row, payload, cache_key=None):
        try:
            if payload is None:
                return
            self.store.execute(
                "INSERT OR REPLACE INTO wr_source_analysis(doc_id,cache_key,payload) VALUES(?,?,?)",
                (row["id"], cache_key or self.key(row), payload),
            )
            # Cache retention has a byte and entry bound. Never evict user traces.
            rows = self.store.query(
                "SELECT doc_id,length(payload) AS bytes FROM wr_source_analysis "
                "ORDER BY updated_at DESC,doc_id DESC"
            )
            total = 0
            for index, cached in enumerate(rows):
                total += cached["bytes"]
                if index >= 64 or total > MAX_BYTES:
                    self.store.execute("DELETE FROM wr_source_analysis WHERE doc_id=?", (cached["doc_id"],))
        except (sqlite3.Error, ValueError, TypeError):
            log.warning("Cannot retain source analysis cache for %s", row["id"])
