"""词典层：词形还原、词频查询、分级标签、中文释义。

零模型调用。surface 自身有词频时不做还原——running 是独立词条，
they 若走 lemma 表会被错映射成 it。
"""

from __future__ import annotations

import hashlib
import sqlite3
import unicodedata
from collections import OrderedDict
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from threading import RLock

from wise_reader.dictionary_payload import (
    PAYLOAD_VERSION,
    SOURCE,
    compact_gloss,
    full_detail,
    parse_senses,
)

DATA = Path(__file__).resolve().parent.parent.parent / "data"

_LEMMA_CODE = "0"

_COLUMNS = "word, phonetic, translation, definition, detail, pos, frq, bnc, collins, oxford, tag, exchange"


def normalize_query(word: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", word).lower().replace("’", "'").split())


@dataclass(frozen=True, slots=True)
class Entry:
    word: str
    phonetic: str
    translation: str
    pos: str
    frq: int
    bnc: int
    collins: int
    oxford: bool
    tags: frozenset[str]
    definition: str = ""
    detail: str = ""

    @property
    def rank(self) -> int:
        ranks = [r for r in (self.frq, self.bnc) if r > 0]
        return min(ranks) if ranks else 0

    @property
    def has_chinese(self) -> bool:
        return bool(self.translation and self.translation.strip())

    @property
    def has_definition(self) -> bool:
        return bool(self.translation.strip() or self.definition.strip())

    @property
    def senses(self):
        return parse_senses(self.translation, self.definition)

    def full_gloss(self) -> str:
        return full_detail(self.translation, self.definition, self.detail)

    def gloss(self, max_len: int = 48) -> str:
        """Compact candidates; ellipsis signals omitted text, full_gloss is lossless."""
        return compact_gloss(self.senses, max_len)


class Lexicon:
    def __init__(self, db_path: Path | None = None, lemma_path: Path | None = None):
        self.db_path = db_path or DATA / "stardict.db"
        self.lemma_path = lemma_path or DATA / "lemma.en.txt"
        if not self.db_path.exists():
            raise FileNotFoundError(
                f"词库不存在：{self.db_path}\n请先运行 python3 scripts/fetch_lexicon.py"
            )
        self._con = sqlite3.connect(
            self.db_path.resolve().as_uri() + "?mode=ro&immutable=1",
            uri=True, check_same_thread=False
        )
        self._con.row_factory = sqlite3.Row
        self._inflection = self._load_lemma_table()
        # Shared rows also carry exchange, so lemma resolution never repeats SQL.
        self._rows = OrderedDict()
        self._rows_lock = RLock()
        revision = hashlib.sha256(PAYLOAD_VERSION.encode())
        for path in (self.db_path, self.lemma_path):
            stat = path.stat() if path.exists() else None
            revision.update(str((path.name, stat.st_size if stat else 0,
                                 stat.st_mtime_ns if stat else 0)).encode())
        self.dictionary_revision = revision.hexdigest()

    def _load_lemma_table(self) -> dict[str, str]:
        table: dict[str, str] = {}
        if not self.lemma_path.exists():
            return table
        with open(self.lemma_path, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith(";") or "->" not in line:
                    continue
                head, _, forms = line.partition("->")
                base = head.split("/")[0].strip().lower()
                for form in forms.split(","):
                    form = form.split("/")[0].strip().lower()
                    if form and form != base:
                        table.setdefault(form, base)
        return table

    def _row_to_entry(self, row: sqlite3.Row) -> Entry:
        return Entry(
            word=row["word"],
            phonetic=row["phonetic"] or "",
            translation=row["translation"] or "",
            pos=row["pos"] or "",
            frq=row["frq"] or 0,
            bnc=row["bnc"] or 0,
            collins=row["collins"] or 0,
            oxford=bool(row["oxford"]),
            tags=frozenset((row["tag"] or "").split()),
            definition=row["definition"] or "",
            detail=row["detail"] or "",
        )

    def _remember(self, word, row):
        self._rows[word] = row
        self._rows.move_to_end(word)
        while len(self._rows) > 20_000:
            self._rows.popitem(last=False)

    def _row(self, word):
        with self._rows_lock:
            if word in self._rows:
                self._rows.move_to_end(word)
                return self._rows[word]
            row = self._con.execute(
                f"SELECT {_COLUMNS} FROM stardict WHERE word = ? COLLATE NOCASE LIMIT 1",
                (word,),
            ).fetchone()
            self._remember(word, row)
            return row

    def prefetch(self, words):
        """Load distinct source words and their lemmas in bounded indexed batches.

        Case folding, missing entries and exchange precedence match single lookup.
        Nothing here depends on a reader's vocabulary or annotation density.
        """
        words = {normalize_query(w) for w in words}
        with self._rows_lock:
            def load(keys):
                missing = sorted(keys.difference(self._rows))
                for start in range(0, len(missing), 400):
                    batch = missing[start : start + 400]
                    rows = self._con.execute(
                        f"SELECT {_COLUMNS} FROM stardict"
                        " WHERE word COLLATE NOCASE IN (" + ",".join("?" for _ in batch) + ")",
                        batch,
                    ).fetchall()
                    found = {normalize_query(row["word"]): row for row in rows}
                    for word in batch:
                        self._remember(word, found.get(word))

            # Limit each working set so an arbitrarily large book cannot evict its
            # own rows before the lemma pass. The row LRU remains strictly bounded.
            ordered = sorted(words)
            for start in range(0, len(ordered), 4000):
                batch = ordered[start : start + 4000]
                load(set(batch))
                bases = set()
                for word in batch:
                    row = self._rows.get(word)
                    base = None
                    if row and row["exchange"]:
                        for item in row["exchange"].split("/"):
                            code, _, value = item.partition(":")
                            if code == _LEMMA_CODE and value:
                                base = value.lower()
                                break
                    base = base or self._inflection.get(word)
                    if base:
                        bases.add(base)
                load(bases)
                # Fill existing bounded lookup caches before the next working set.
                for word in batch:
                    self.lookup(word)

    @lru_cache(maxsize=100_000)
    def _raw(self, word: str) -> Entry | None:
        row = self._row(word)
        return self._row_to_entry(row) if row is not None else None

    @lru_cache(maxsize=100_000)
    def _exchange_lemma(self, word: str) -> str | None:
        row = self._row(word)
        if not row or not row["exchange"]:
            return None
        for item in row["exchange"].split("/"):
            code, _, value = item.partition(":")
            if code == _LEMMA_CODE and value:
                return value.lower()
        return None

    @lru_cache(maxsize=100_000)
    def lemma(self, word: str) -> str:
        """还原到词典原型。

        surface 自身有词频时默认不还原（running、they）。
        例外：surface 词频很差（>5000）而 exchange 原型是核心高频词（≤2000）
        —— 这是 ECDICT 把 is/taken 等变形单独做成「生僻词条」的噪音，必须还原。
        """
        w = normalize_query(word)
        own = self._raw(w)
        base = self._exchange_lemma(w) or self._inflection.get(w)
        if own is not None and own.rank > 0:
            if base and base != w:
                parent = self._raw(base)
                if parent is not None and 0 < parent.rank <= 2000 and own.rank > 5000:
                    return base
            return w
        if base and base != w:
            return base
        return w

    @lru_cache(maxsize=100_000)
    def lookup(self, word: str) -> Entry | None:
        """查词。优先用 lemma 对应的原型词条（含上面的变形噪音规则）。"""
        word = normalize_query(word)
        base = self.lemma(word)
        if base != word.lower():
            parent = self._raw(base)
            if parent is not None:
                return parent
        return self._raw(word.lower())

    def lookup_exact_many(self, words) -> dict[str, Entry]:
        """Indexed exact entries, without morphology; batches and row LRU are bounded.

        Intended for phrase windows. Unlike prefetch(), this never follows a
        phrase's member lemmas or caches every missing n-gram as an Entry.
        """
        result = {}
        batch = set()

        def load():
            with self._rows_lock:
                # Keep a bounded working copy: inserting misses into the LRU
                # must not evict cache hits that this very batch still needs.
                working = {word: self._rows[word] for word in batch if word in self._rows}
                missing = sorted(batch.difference(working))
                if missing:
                    rows = self._con.execute(
                        f"SELECT {_COLUMNS} FROM stardict WHERE word COLLATE NOCASE IN ("
                        + ",".join("?" for _ in missing) + ")", missing,
                    ).fetchall()
                    found = {normalize_query(row["word"]): row for row in rows}
                    for word in missing:
                        working[word] = found.get(word)
                for word in sorted(batch):
                    row = working[word]
                    self._remember(word, row)
                    if row is not None:
                        result[word] = self._row_to_entry(row)
            batch.clear()

        for word in words:
            batch.add(normalize_query(word))
            if len(batch) >= 400:
                load()
        if batch:
            load()
        return result

    def lookup_payload(self, word: str) -> dict:
        """Engine.lookup contract: legacy fields plus independent, sourced candidates.

        All strings are plain text, never trusted HTML. `senses` lists source
        lines, not aligned translations or resolved contextual meanings.
        `dictionary.raw_detail` preserves the unparsed supplement independently.
        """
        entry = self.lookup(word)
        result = {
            "word": word, "lemma": self.lemma(word), "found": entry is not None,
            "payload_version": PAYLOAD_VERSION, "dictionary_revision": self.dictionary_revision,
            "kind": "dictionary-candidates", "contextual": False,
            "source": "ecdict", "sources": [{**SOURCE, "revision": self.dictionary_revision}],
            "senses": [], "chinese_missing": True, "definition_missing": True,
            "note": "", "detail": "", "phonetic": "", "rank": 0,
        }
        if entry is not None:
            result.update({
                "headword": entry.word, "phonetic": entry.phonetic,
                "note": entry.gloss(), "detail": entry.full_gloss(), "rank": entry.rank,
                "pos": entry.pos, "tags": sorted(entry.tags),
                "translation": entry.translation, "definition": entry.definition,
                "raw_detail": entry.detail,
                "senses": [s.to_dict() for s in entry.senses],
                "chinese_missing": not entry.has_chinese,
                "definition_missing": not entry.has_definition,
                "note_language": "zh" if entry.has_chinese else "en" if entry.definition.strip() else None,
            })
        result["dictionary"] = {
            "senses": result["senses"], "source": {**SOURCE, "revision": self.dictionary_revision},
            "sources": result["sources"], "language": result.get("note_language"),
            "chinese_missing": result["chinese_missing"],
            "definition_missing": result["definition_missing"],
            "contextual": False, "version": PAYLOAD_VERSION,
            "revision": self.dictionary_revision,
            "pos": entry.pos if entry else "", "headword": entry.word if entry else None,
            "raw_detail": entry.detail if entry else "",
        }
        return result

    def band_sample(self, lo: int, hi: int, n: int, seed: int = 0) -> list[Entry]:
        rows = self._con.execute(
            f"SELECT {_COLUMNS} FROM stardict"
            " WHERE frq >= ? AND frq < ? AND translation != '' AND word NOT LIKE '% %'"
            "   AND word GLOB '[a-z]*'"
            " ORDER BY (frq * 7919 + ?) % 104729"
            " LIMIT ?",
            (lo, hi, seed, n),
        ).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def close(self) -> None:
        self._con.close()
