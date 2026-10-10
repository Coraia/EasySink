"""Personal selection with a soft density budget and explicit forced overrides."""

from dataclasses import replace

from wise_reader.models import Kind
from wise_reader.semantics import target


def filter_candidates(l0, l1, profile, word_count, density=None, verdicts=None):
    """Select automatic annotations; contextual overrides are applied by the reader."""
    density = profile.density if density is None else density
    budget = max(1, round(word_count * density / 100)) if density > 0 else 0
    verdicts = verdicts or {}
    # More assistance widens the candidate vocabulary, not just the cap.
    threshold = (
        profile.rank_threshold() * min(1.0, 4 / density)
        if density > 0
        else profile.rank_threshold()
    )
    eligible = []
    for a in l0 + l1:
        key = target(a)
        if profile.knows(key) or verdicts.get(key) == "known":
            continue
        forced = profile.struggles_with(key) or verdicts.get(key) == "unknown"
        if a.kind == Kind.WORD:
            if not forced and (a.suppressed or 0 < a.rarity <= threshold):
                continue
        else:
            if not profile.l1_enabled and a.source != "dictionary-phrase" and not forced:
                continue
            if a.kind == Kind.CULTURE and a.domain in profile.domains and not forced:
                continue
        eligible.append(replace(a, forced=forced))
    # Resolve overlap only when actually selecting; expressions precede ordinary word glosses.
    eligible.sort(key=lambda a: (
        a.forced, a.kind != Kind.WORD, a.last_token - a.first_token, a.rarity,
    ), reverse=True)
    chosen = []
    occupied = set()
    seen = set()
    automatic_count = 0
    for a in eligible:
        key = target(a)
        span = set(range(a.first_token, a.last_token + 1))
        if (not profile.repeat and key in seen) or span & occupied:
            continue
        if not a.forced and automatic_count >= budget:
            continue
        chosen.append(a)
        if not a.forced:
            automatic_count += 1
        occupied |= span
        seen.add(key)
    return sorted(chosen, key=lambda a: a.first_token)
