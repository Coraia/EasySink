"""L2 个性化过滤：读者模型唯一介入点。"""

from __future__ import annotations

from wise_reader.models import Annotation, Kind
from wise_reader.profile import ReaderProfile


def filter_candidates(
    l0: list[Annotation],
    l1: list[Annotation],
    profile: ReaderProfile,
    word_count: int,
    density: float | None = None,
) -> list[Annotation]:
    density = profile.density if density is None else density
    budget = max(1, round(word_count * density / 100))
    threshold = profile.rank_threshold()

    l1_kept: list[Annotation] = []
    if profile.l1_enabled:
        for a in l1:
            if a.kind == Kind.CULTURE and a.domain and a.domain in profile.domains:
                continue
            l1_kept.append(a)

    l0_kept: list[Annotation] = []
    seen_lemma: set[str] = set()
    for a in l0:
        lemma = a.lemma or a.surface.lower()
        if profile.knows(lemma):
            continue
        forced = profile.struggles_with(lemma)
        if not forced and 0 < a.rarity <= threshold:
            continue
        if not profile.repeat:
            if lemma in seen_lemma:
                continue
            seen_lemma.add(lemma)
        item = Annotation(
            first_token=a.first_token,
            last_token=a.last_token,
            kind=a.kind,
            note=a.note,
            surface=a.surface,
            rarity=a.rarity,
            lemma=lemma,
            domain=a.domain,
            detail=a.detail,
            forced=forced,
        )
        l0_kept.append(item)

    occupied: set[int] = set()
    for a in l0_kept:
        occupied.update(range(a.first_token, a.last_token + 1))

    l1_deduped: list[Annotation] = []
    for a in l1_kept:
        span = set(range(a.first_token, a.last_token + 1))
        if span & occupied:
            continue
        l1_deduped.append(a)

    merged = l0_kept + l1_deduped
    forced = [a for a in merged if a.forced]
    rest = [a for a in merged if not a.forced]
    rest.sort(key=lambda a: a.rarity, reverse=True)
    room = max(0, budget - len(forced))
    chosen = forced + rest[:room]
    chosen.sort(key=lambda a: a.first_token)
    return chosen
