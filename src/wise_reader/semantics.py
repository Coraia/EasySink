"""Offline dictionary candidates. Context explanations require the explicit AI path."""

import re

from wise_reader.dictionary_phrases import candidates as phrase_candidates
from wise_reader.models import Kind


def contextualize(doc, candidates):
    """Compatibility entry point; never guess a sense from sentence keywords.

    A river near a bank loan does not turn the loan's bank into a riverbank.
    Preserve the dictionary candidates and their full detail unchanged.
    """
    return candidates


def phrases(doc, lexicon=None):
    """Return exact dictionary phrase candidates; callers must pass their Lexicon.

    Omitting the lexicon fails closed to no matches for legacy integrations,
    without silently creating another database connection or using canned glosses.
    """
    return phrase_candidates(doc, lexicon) if lexicon is not None else []


def target(a):
    if a.kind == Kind.WORD:
        return a.lemma or a.surface.lower()
    return a.kind.value + ":" + re.sub(r"\s+", " ", a.surface.lower()).strip()
