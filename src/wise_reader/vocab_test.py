"""自适应频带词汇量测试。V1 不做伪词，接口预留。"""

from __future__ import annotations

import math
import secrets
from dataclasses import dataclass, field

from wise_reader.lexicon import Entry, Lexicon

BANDS = (1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000)
MAX_ROUNDS = 5
PER_ROUND = 5


@dataclass
class TestSession:
    id: str
    lo: int = 1000
    hi: int = 30000
    round: int = 0
    band: int = 5000
    answered: dict[str, bool] = field(default_factory=dict)
    asked: list[str] = field(default_factory=list)
    known_words: list[str] = field(default_factory=list)
    current: list[Entry] = field(default_factory=list)
    answers_this_round: dict[str, bool] = field(default_factory=dict)
    finished: bool = False
    estimate: int | None = None


class VocabTester:
    def __init__(self, lexicon: Lexicon):
        self.lexicon = lexicon
        self.sessions: dict[str, TestSession] = {}

    def start(self) -> TestSession:
        session = TestSession(id=secrets.token_hex(8))
        self._deal(session)
        self.sessions[session.id] = session
        return session

    def answer(self, session_id: str, word: str, known: bool) -> TestSession:
        session = self.sessions[session_id]
        if session.finished:
            return session
        word = word.lower()
        if word in session.answered:
            return session
        pending = [
            e
            for e in session.current
            if e.word.lower() not in session.answers_this_round
        ]
        if not pending or pending[0].word.lower() != word:
            raise ValueError("这不是当前题目，请刷新测试")
        session.answered[word] = known
        session.answers_this_round[word] = known
        if known:
            session.known_words.append(word.lower())
        if len(session.answers_this_round) < len(session.current):
            return session
        known_n = sum(1 for v in session.answers_this_round.values() if v)
        band = session.band
        if known_n >= 4:
            session.lo = max(session.lo, band)
        elif known_n <= 1:
            session.hi = min(session.hi, band)
        else:
            session.estimate = band
            session.finished = True
            return session
        session.round += 1
        session.answers_this_round = {}
        if session.hi / max(session.lo, 1) < 1.5 or session.round >= MAX_ROUNDS:
            session.estimate = int(math.sqrt(session.lo * session.hi))
            session.finished = True
            return session
        self._deal(session)
        return session

    def _deal(self, session: TestSession) -> None:
        band = int(math.sqrt(session.lo * session.hi))
        lo, hi = _band_window(band)
        seed = int(session.id[-4:], 16) + session.round * 17
        sample = self.lexicon.band_sample(lo, hi, PER_ROUND + 8, seed=seed)
        picked: list[Entry] = []
        seen = set(session.asked)
        for e in sample:
            if e.word.lower() in seen:
                continue
            picked.append(e)
            if len(picked) >= PER_ROUND:
                break
        session.band = int(sum(e.frq for e in picked) / len(picked)) if picked else band
        if not picked:
            session.finished = True
            session.estimate = band
        session.current = picked
        session.asked.extend(e.word.lower() for e in picked)


def _band_window(band: int) -> tuple[int, int]:
    below = [b for b in BANDS if b <= band]
    above = [b for b in BANDS if b >= band]
    lo = below[-1] if below else BANDS[0]
    hi = above[0] if above else BANDS[-1]
    if hi <= lo:
        hi = min(lo + 1500, 47062)
    return lo, hi


def question_payload(session: TestSession) -> dict:
    pending = [
        e for e in session.current if e.word.lower() not in session.answers_this_round
    ]
    q = pending[0] if pending else None
    return {
        "session": session.id,
        "finished": session.finished,
        "estimate": session.estimate,
        "range": [session.lo, session.hi],
        "measure": "COCA 词频熟悉度范围；用于选择阅读辅助起点，不等于精确词汇量",
        "round": session.round + 1,
        "max_rounds": MAX_ROUNDS,
        "progress": len(session.asked) - len(pending) + (0 if q else len(pending)),
        "question": None
        if q is None
        else {
            "word": q.word,
            "phonetic": q.phonetic,
        },
    }
