import importlib
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path

import pytest

from wise_reader.pdf_lab.worker import worker_python

ROOT = Path(__file__).resolve().parents[1]
PROTOTYPE = ROOT / "scripts/prototypes/pdf_body_projection"


@pytest.fixture
def projection(monkeypatch):
    monkeypatch.syspath_prepend(str(PROTOTYPE))
    return importlib.import_module("projection")


def test_join_maps_utf16_back_to_original_line_offsets(projection):
    Block, Line, project = projection.Block, projection.Line, projection.project_block
    text = "😀 We made a locatio n marker."
    block = Block("body", 1, text, "paragraph", [0, 0, 140, 25], (
        Line("😀 We made a locatio", 0, [0, 0, 140, 10], {0: [0, 0, 11, 10]}),
        Line("n marker.", 20, [0, 15, 60, 25], {0: [0, 15, 5, 25]}),
    ), 9, "v1")
    unit = project(block, {"a", "location"}.__contains__, set(), 140)
    assert unit.text == "😀 We made a location marker."
    start = unit.text.index("location")
    ranges = unit.ranges(start, start + len("location"))
    assert list(unit.repaired_words()) == [{"text": "location", "ranges": ranges}]
    assert [(r["doc_id"], r["revision"], r["start"], r["end"]) for r in ranges] == [
        (9, "v1", 13, 20), (9, "v1", 21, 22)]
    encoded = text.encode("utf-16-le")
    assert "".join(encoded[2*r["start"]:2*r["end"]].decode("utf-16-le") for r in ranges) == "location"


def test_lexical_join_preserves_two_words_and_real_hyphens(projection):
    known = {"side", "in", "inside", "well", "known", "well-known", "location"}
    assert projection.lexical_join("the locatio", "n marker", known.__contains__, ())
    assert not projection.lexical_join("stored in", "side pockets", known.__contains__, ())
    assert not projection.lexical_join("the well-", "known paper", known.__contains__, (), True)


def test_real_import_baseline_projection_override_and_pending(tmp_path, projection):
    dependencies = subprocess.run([str(worker_python()), "-c", "import pdfplumber, pypdfium2"],
                                  capture_output=True, check=False)
    if dependencies.returncode:
        pytest.skip("PDF lab environment not installed")
    review = importlib.import_module("review")
    with closing(sqlite3.connect((ROOT / "data/stardict.db").as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
        cases = review.load_cases(tmp_path, db)
        for name, pair in {"running": {1, 2}, "footnote": {1, 2}, "number-only": {1, 2}, "range-edge": {8, 9}}.items():
            state = review.snapshot(cases[name])
            assert any("remaining material to the laboratory" in p["source"] for p in state["afterPayload"]["paragraphs"])
            assert not any("remaining material to the laboratory" in p["source"] for p in state["beforePayload"]["paragraphs"])
            assert any({r["page"] for r in t["ranges"]} == pair for t in state["translations"])
            assert not any(p["source"].isdecimal() for p in state["afterPayload"]["paragraphs"])
        running = cases["running"]
        state = review.snapshot(running)
        header = "FIELD STUDY ARCHIVE"
        footer = "RESEARCH DIVISION COPY"
        assert {header, footer} <= {p["source"] for p in state["beforePayload"]["paragraphs"]}
        assert not {header, footer} & {p["source"] for p in state["afterPayload"]["paragraphs"]}
        note = "1. The original records are kept on site."
        footnote = review.snapshot(cases["footnote"])
        assert any(b["role"] == "footnote" and b["source"] == note for b in footnote["pages"][0]["objects"])
        assert not any(note in p["source"] for p in footnote["afterPayload"]["paragraphs"])
        obj = next(b for b in state["pages"][0]["objects"] if b["role"] == "footer")
        running.projection.override(obj["id"], "body")
        edited = review.snapshot(running)
        assert edited["changed"] == [1]
        assert any(p["source"] == footer for p in edited["afterPayload"]["paragraphs"])
        assert not any({r["page"] for r in t["ranges"]} == {1, 2} for t in edited["translations"])
        running.projection.override(obj["id"], "exclude")
        assert review.snapshot(running)["afterPayload"] == state["afterPayload"]
        running.projection.override(obj["id"], "reset")
        assert review.snapshot(running)["afterPayload"] == state["afterPayload"]
        running.projection.pending(2)
        pending = review.snapshot(running)
        assert pending["waiting"] and pending["hidden"] == 2
        assert pending["afterPayload"]["paragraphs"] == []
        running.projection.pending(2)
        assert review.snapshot(running)["afterPayload"] == state["afterPayload"]
        words = review.snapshot(cases["line-break"])
        before, after = [" ".join(p["source"] for p in words[key]["paragraphs"])
                         for key in ("beforePayload", "afterPayload")]
        for split, joined in [("p repared", "prepared"), ("locatio n", "location"),
                              ("diffe rent", "different"), ("record s", "records")]:
            assert split in before and split not in after and joined in after
        assert after.count("in side pockets") == 2
