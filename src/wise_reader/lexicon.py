"""词典层：词形还原、词频查询、分级标签、中文释义。

零模型调用。surface 自身有词频时不做还原——running 是独立词条，
they 若走 lemma 表会被错映射成 it。
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent.parent / "data"

_LEMMA_CODE = "0"

_POS_PREFIX = re.compile(
    r"^(?:(?:n|v|a|ad|adj|adv|vt|vi|prep|conj|pron|art|num|int|aux|abbr|u|c)\.\s*[&/]?\s*)+",
    re.IGNORECASE,
)


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

    @property
    def rank(self) -> int:
        ranks = [r for r in (self.frq, self.bnc) if r > 0]
        return min(ranks) if ranks else 0

    @property
    def has_chinese(self) -> bool:
        return bool(self.translation and self.translation.strip())

    def gloss(self, max_len: int = 18) -> str:
        if not self.translation:
            return ""
        first = self.translation.strip().splitlines()[0].strip()
        first = _POS_PREFIX.sub("", first)
        for sep in ("。", "；", ";"):
            if sep in first:
                first = first.split(sep)[0]
        parts = [p.strip() for p in first.replace("，", ",").split(",") if p.strip()]
        out = ""
        for p in parts:
            candidate = f"{out},{p}" if out else p
            if len(candidate) > max_len:
                break
            out = candidate
        return out or first[:max_len]


class Lexicon:
    def __init__(self, db_path: Path | None = None, lemma_path: Path | None = None):
        self.db_path = db_path or DATA / "stardict.db"
        self.lemma_path = lemma_path or DATA / "lemma.en.txt"
        if not self.db_path.exists():
            raise FileNotFoundError(
                f"词库不存在：{self.db_path}\n请先运行 python3 scripts/fetch_lexicon.py"
            )
        self._con = sqlite3.connect(
            f"file:{self.db_path}?mode=ro", uri=True, check_same_thread=False
        )
        self._con.row_factory = sqlite3.Row
        self._inflection = self._load_lemma_table()

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
        )

    @lru_cache(maxsize=100_000)
    def _raw(self, word: str) -> Entry | None:
        row = self._con.execute(
            "SELECT word, phonetic, translation, pos, frq, bnc, collins, oxford,"
            " tag, exchange FROM stardict WHERE word = ? COLLATE NOCASE LIMIT 1",
            (word,),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_entry(row)

    @lru_cache(maxsize=100_000)
    def _exchange_lemma(self, word: str) -> str | None:
        row = self._con.execute(
            "SELECT exchange FROM stardict WHERE word = ? COLLATE NOCASE LIMIT 1",
            (word,),
        ).fetchone()
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
        w = word.lower()
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
        base = self.lemma(word)
        if base != word.lower():
            parent = self._raw(base)
            if parent is not None:
                return parent
        return self._raw(word.lower())

    def band_sample(self, lo: int, hi: int, n: int, seed: int = 0) -> list[Entry]:
        rows = self._con.execute(
            "SELECT word, phonetic, translation, pos, frq, bnc, collins, oxford, tag"
            " FROM stardict"
            " WHERE frq >= ? AND frq < ? AND translation != '' AND word NOT LIKE '% %'"
            "   AND word GLOB '[a-z]*'"
            " ORDER BY (frq * 7919 + ?) % 104729"
            " LIMIT ?",
            (lo, hi, seed, n),
        ).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def close(self) -> None:
        self._con.close()
