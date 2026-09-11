"""L1 校验：非法 token 丢弃；原文不可能被改写。"""

from wise_reader.l1 import NullLLM, generate, validate
from wise_reader.models import Kind
from wise_reader.tokenize import parse


def test_validate_drops_bad_spans():
    doc = parse("The cat sat on the mat.")
    raw = {
        "annotations": [
            {
                "first_token": 1,
                "last_token": 1,
                "kind": "culture",
                "note": "合法",
                "detail": "x",
                "domain": "pop",
                "difficulty": 2,
            },
            {"first_token": 99, "last_token": 99, "kind": "culture", "note": "越界"},
            {"first_token": 0, "last_token": 0, "kind": "word", "note": "禁止的kind"},
            {"first_token": 0, "last_token": 5, "kind": "grammar", "note": "跨句会在单句文本里过？"},
        ]
    }
    kept, n, dropped = validate(raw, doc)
    assert n == 4
    assert dropped >= 2
    assert all(a.kind != Kind.WORD for a in kept)
    for a in kept:
        assert doc.tokens[a.first_token].text == doc.text[doc.tokens[a.first_token].start : doc.tokens[a.first_token].end]


def test_original_text_never_rewritten():
    text = "The cat sat on the mat."
    doc = parse(text)
    raw = {
        "annotations": [
            {
                "first_token": 1,
                "last_token": 1,
                "kind": "phrase",
                "note": "家猫",
                "difficulty": 1,
            }
        ]
    }
    kept, _, _ = validate(raw, doc)
    assert doc.text == text
    assert kept[0].surface == "cat"


def test_null_llm_does_not_call():
    doc = parse("Hello world.")
    kept, stats = generate(doc, NullLLM(), enabled=True)
    assert kept == []
    assert stats["calls"] == 1


def test_disabled_skips_call():
    doc = parse("Hello world.")
    kept, stats = generate(doc, NullLLM(), enabled=False)
    assert stats["calls"] == 0
    assert kept == []


def test_note_truncated_to_twenty():
    doc = parse("The cat sat.")
    raw = {
        "annotations": [
            {
                "first_token": 1,
                "last_token": 1,
                "kind": "culture",
                "note": "这是一段超过二十个中文字符的注释内容应当被截断处理",
                "difficulty": 3,
            }
        ]
    }
    kept, _, dropped = validate(raw, doc)
    assert dropped == 0
    assert len(kept) == 1
    assert len(kept[0].note) <= 20
