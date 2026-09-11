"""M0 词典层回归：对照 03-design.md 实测样例表。"""

from wise_reader.lexicon import Lexicon


def test_lemma_sample_table(lexicon: Lexicon):
    # running / they：自身有词频则不还原，否则 they 会被 lemma 表映射成 it。
    # better 自身有词频 452，按同一规则不还原成 good（样例表那一行混用了 lookup 的 rank）。
    expected = {
        "running": "running",
        "ran": "run",
        "mice": "mouse",
        "better": "better",
        "they": "they",
        "ubiquitous": "ubiquitous",
        "photosynthesis": "photosynthesis",
        "serendipity": "serendipity",
        "gerrymandering": "gerrymandering",
        "Obama": "obama",
    }
    for word, lemma in expected.items():
        assert lexicon.lemma(word) == lemma, word


def test_they_not_mapped_to_it(lexicon: Lexicon):
    assert lexicon.lemma("they") == "they"


def test_obama_rank_zero(lexicon: Lexicon):
    entry = lexicon.lookup("Obama")
    assert entry is not None
    assert entry.rank == 0


def test_gloss_strips_pos_prefix(lexicon: Lexicon):
    e = lexicon.lookup("ubiquitous")
    assert e is not None
    g = e.gloss()
    assert not g.lower().startswith("a.")
    assert "无所不在" in g


def test_running_gloss_and_rank(lexicon: Lexicon):
    e = lexicon.lookup("running")
    assert e is not None
    assert e.rank == 3252
    assert "赛跑" in e.gloss() or "运转" in e.gloss()


def test_gerrymander_via_inflection(lexicon: Lexicon):
    e = lexicon.lookup("gerrymandering")
    assert e is not None
    assert e.rank > 8000
    assert "选区" in e.gloss() or "选举" in e.gloss()
    # 自身有 COCA 词频，lemma 保持 surface（与 running 同一规则）
    assert lexicon.lemma("gerrymandering") == "gerrymandering"
