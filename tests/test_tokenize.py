"""M0 地基：分词、分句、原文无损重建。"""

from wise_reader.tokenize import parse

SENT_CASES = [
    ("Mr. Smith went home. Then he slept.", ["Mr", "Smith", "went", "home", "Then", "he", "slept"]),
    ("The U.S. economy grew.", ["The", "U", "S", "economy", "grew"]),
    ("Pi is 3.14 today.", ["Pi", "is", "today"]),
]


def test_abbreviation_and_decimal_not_split():
    for text, words in SENT_CASES:
        doc = parse(text)
        assert [t.text for t in doc.tokens] == words, text


def test_us_is_one_sentence():
    doc = parse("The U.S. economy grew last year.")
    assert len(doc.sentences) == 1


def test_mr_is_one_sentence():
    doc = parse("Mr. Smith arrived yesterday.")
    assert len(doc.sentences) == 1


def test_reconstruct_roundtrip():
    texts = [
        "Hello, world.",
        "Mr. Smith went to the U.S. in 3.14 seconds.\nThen he left.",
        "Don't you love state-of-the-art O'Neill solutions?",
        FIXTURE_A,
        FIXTURE_B,
        FIXTURE_C,
        FIXTURE_D,
        FIXTURE_E,
    ]
    for text in texts:
        doc = parse(text)
        assert doc.reconstruct() == text
        for t in doc.tokens:
            assert t.text == text[t.start : t.end]


def test_hyphen_and_apostrophe():
    doc = parse("Don't buy state-of-the-art gear.")
    assert [t.text for t in doc.tokens] == ["Don't", "buy", "state-of-the-art", "gear"]


def test_numbered_sentences_use_token_ids():
    doc = parse("Cats sleep. Dogs run.")
    numbered = doc.numbered_sentences()
    assert numbered[0].startswith("[S0]")
    assert "<0>Cats" in numbered[0]
    assert "<2>Dogs" in numbered[1]


FIXTURE_A = open(__file__.replace("test_tokenize.py", "fixtures/a_tech.txt"), encoding="utf-8").read()
FIXTURE_B = open(__file__.replace("test_tokenize.py", "fixtures/b_opinion.txt"), encoding="utf-8").read()
FIXTURE_C = open(__file__.replace("test_tokenize.py", "fixtures/c_theology.txt"), encoding="utf-8").read()
FIXTURE_D = open(__file__.replace("test_tokenize.py", "fixtures/d_sports.txt"), encoding="utf-8").read()
FIXTURE_E = open(__file__.replace("test_tokenize.py", "fixtures/e_fiction.txt"), encoding="utf-8").read()
