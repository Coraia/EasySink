"""M1：L0 候选 + L2 过滤。专名不标、密度上限、同词一次。"""

from pathlib import Path

from wise_reader.l0 import candidates
from wise_reader.l2 import filter_candidates
from wise_reader.profile import ReaderProfile
from wise_reader.tokenize import parse

FIXTURES = Path(__file__).parent / "fixtures"

PROPER_NOUNS = {
    "Obama",
    "Smith",
    "Augustine",
    "Margaret",
    "Seattle",
    "Nebula",
}


def _annotate(lexicon, text, vocab=8000, density=4.0, known=None, unknown=None):
    doc = parse(text)
    l0 = candidates(doc, lexicon)
    profile = ReaderProfile(
        vocab_size=vocab,
        density=density,
        known=set(known or []),
        unknown=set(unknown or []),
    )
    shown = filter_candidates(l0, [], profile, len(doc.tokens))
    return doc, l0, shown


def test_function_word_is_not_annotated(lexicon):
    text = "It is taken and produced and cannot be designed."
    _, _, shown = _annotate(lexicon, text)
    lemmas = {a.lemma for a in shown}
    assert not {"is", "be", "taken", "produced", "cannot", "designed"} & lemmas


def test_obama_never_annotated(lexicon):
    text = "Yesterday Obama spoke about the ubiquitous problem of gerrymandering."
    doc, _, shown = _annotate(lexicon, text)
    surfaces = {a.surface for a in shown}
    assert "Obama" not in surfaces
    lemmas = {a.lemma for a in shown}
    assert "obama" not in lemmas


def test_density_cap(lexicon):
    text = (FIXTURES / "b_opinion.txt").read_text(encoding="utf-8")
    doc, _, shown = _annotate(lexicon, text, density=4.0)
    rate = 100 * len(shown) / max(len(doc.tokens), 1)
    assert rate <= 4.5, rate


def test_no_duplicate_lemma(lexicon):
    text = (FIXTURES / "a_tech.txt").read_text(encoding="utf-8")
    _, _, shown = _annotate(lexicon, text)
    lemmas = [a.lemma for a in shown]
    assert len(lemmas) == len(set(lemmas))


def test_fixtures_density_and_proper_nouns(lexicon):
    for name in [
        "a_tech.txt",
        "b_opinion.txt",
        "c_theology.txt",
        "d_sports.txt",
        "e_fiction.txt",
    ]:
        text = (FIXTURES / name).read_text(encoding="utf-8")
        doc, _, shown = _annotate(lexicon, text)
        assert len(doc.tokens) >= 400, (name, len(doc.tokens))
        rate = 100 * len(shown) / max(len(doc.tokens), 1)
        assert rate <= 4.5, (name, rate)
        for a in shown:
            if a.surface in PROPER_NOUNS:
                raise AssertionError(f"{name} annotated proper noun {a.surface}")


def test_whitelist_removes_note(lexicon):
    text = "The ubiquitous serendipity of photosynthesis amazed us."
    _, _, shown = _annotate(lexicon, text, known=["ubiquitous"])
    assert "ubiquitous" not in {a.lemma for a in shown}


def test_blacklist_forces_note(lexicon):
    text = "The cat sat on the mat today."
    _, _, shown = _annotate(lexicon, text, unknown=["cat"])
    assert any(a.lemma == "cat" and a.forced for a in shown)


def test_density_change_does_not_need_new_l0(lexicon):
    text = (FIXTURES / "b_opinion.txt").read_text(encoding="utf-8")
    doc, l0, _ = _annotate(lexicon, text, density=4.0)
    low = filter_candidates(l0, [], ReaderProfile(vocab_size=8000, density=1.0), len(doc.tokens))
    high = filter_candidates(l0, [], ReaderProfile(vocab_size=8000, density=8.0), len(doc.tokens))
    assert len(low) < len(high)
    assert {a.lemma for a in low} <= {a.lemma for a in high}
