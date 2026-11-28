import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from pdf_prose_fixture import AFTER, BEFORE, pdf_fixture
from wise_reader.app import create_app
from wise_reader.page_translation import BlockRef, align_batch, source_units
from wise_reader.pdf.prose import PDFProse, Paragraph, SourceBlock
from wise_reader.pdf.representation import build_representation
from wise_reader.pdf.text_normalization import normalize_block, verified_mapping
from wise_reader.pdf_lab.worker import worker_python
from wise_reader.reading_assist import projected_anchor, source_ranges


def digital_block(*lines, gap=3):
    glyphs = []
    for row, line in enumerate(lines):
        x, y = 72, 100 + row * 15
        for letter in line:
            if letter == " ":
                x += gap
                continue
            glyphs.append({"text": letter, "bbox": [x, y, x + 4, y + 10]})
            x += 4
    return {
        "id": "source",
        "type": "paragraph",
        "text": " ".join(lines),
        "raw_text": "\n".join(lines),
        "source": {"coordinate_space": "rotated_crop_top_left", "glyphs": glyphs},
    }


def test_native_line_wrap_preserves_utf16_mapping():
    for left, right, whole in (
        ("p", "repared", "prepared"),
        ("locatio", "n", "location"),
        ("diffe", "rent", "different"),
        ("record", "s", "records"),
    ):
        source = digital_block(f"😀 Before the next trial they noted the {left}", f"{right} was relevant.")
        text, mapping = normalize_block(source)
        assert text == f"😀 Before the next trial they noted the {whole} was relevant."
        edit = mapping["edits"][0]
        assert edit["old_utf16"] == [offset + 1 for offset in edit["old_cp"]]
        assert verified_mapping(source, {"text": text, "normalization": mapping})


def test_native_spacing_needs_both_lexical_and_geometry_evidence():
    assert normalize_block(digital_block("p repared.", gap=2))[0] == "prepared."
    assert normalize_block(digital_block("p repared.", gap=5)) == ("p repared.", None)
    assert normalize_block(digital_block("The team kept the tools in", "side pockets."))[1] is None
    source = digital_block("The team kept the tools p", "repared.")
    source["source"].pop("glyphs")
    assert normalize_block(source) == (source["text"], None)


def source_page(number, header, footer, *rows):
    def block(key, lines, top, height=11, kind="paragraph"):
        value = digital_block(*lines)
        value["id"] = f"{number}-{key}"
        value["type"] = kind
        for glyph in value["source"]["glyphs"]:
            x, y, end, _ = glyph["bbox"]
            glyph["bbox"] = [x, y + top - 100, end, y + top - 100 + height]
        boxes = [g["bbox"] for g in value["source"]["glyphs"]]
        value["source"].update(page_number=number,
            bbox=[72, min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)])
        return value
    blocks = [block("header", (header,), 24, 9)]
    blocks += [block(f"body-{i}", lines, y) for i, (lines, y) in enumerate(rows)]
    blocks += [block("footer", (footer,), 740, 9)]
    label = block("number", (str(number),), 767, 9, "page_footer")
    label["role"] = "printed_page_label"
    return {"page_number": number, "width": 612, "height": 792, "blocks": blocks,
            "source_sha256": "fixture", "conversion_task_id": "task",
            "non_content_objects": [label]}


def test_publication_classifies_odd_even_furniture_and_preserves_separate_footnote():
    first = ("The patient researchers examined the entire collection of samples",
             "and wrote careful notes before sending the remaining material")
    second = ("to the laboratory for a second round of testing. The report arrived the following week.",)
    pages = [
        source_page(1, "Odd header", "1. The original records are kept on site.", (first, 646)),
        source_page(2, "Even header", "Running footer", (second, 64)),
        source_page(3, "Odd header", "Running footer", (second, 64)),
        source_page(4, "Even header", "Running footer", (second, 64)),
    ]
    text, blocks, revision = build_representation(pages, 1, "fixture")
    assert "Odd header" not in text and "Running footer" not in text
    before, note, after = blocks[:3]
    assert before["paragraph_group"] == after["paragraph_group"]
    assert before["paragraph_group"]["blocks"] == [before["id"], after["id"]]
    assert note["type"] == note["pdf_role"] == "footnote"
    header, number = before["page_furniture"]
    assert header["role"] == "header" and "alternating-pages" in header["evidence"]
    assert number["role"] == "printed-page-label" and number["text"] == "1"
    assert number["source"]["page_number"] == 1 and number["source"]["revision"] == revision


def test_translation_uses_the_complete_body_group_without_the_separate_note(monkeypatch):
    before = {"id": "p1", "type": "paragraph", "text": "The reader brought 😀 the samples"}
    note = {"id": "note", "type": "footnote", "pdf_role": "footnote", "text": "1. A note"}
    after = {"id": "p2", "type": "paragraph", "text": "to the laboratory."}
    group = {"id": "paragraph-p1", "blocks": ["p1", "p2"]}
    before["paragraph_group"] = after["paragraph_group"] = group
    monkeypatch.setattr("wise_reader.page_translation.source_content",
                        lambda *_: ("revision", [before, note, after]))
    units = source_units(None, [BlockRef(doc_id=1, block_id="p1", version="revision")])
    assert [unit.quote for unit in units] == [before["text"] + "\n\n" + after["text"]]
    raw = {"paragraphs": [{"id": 0, "segments": [{"quote": units[0].quote, "zh": "译文"}]}]}
    assert align_batch(units, raw, "fixture")[0][0]["ranges"] == [
        {"block_id": "p1", "start": 0, "end": len(before["text"]) + 1},
        {"block_id": "p2", "start": 0, "end": len(after["text"])},
    ]


def test_pending_neighbor_is_not_a_complete_paragraph():
    block = {"id": "p8", "source_page": 8, "text": "The unfinished text",
             "pdf_prose_neighbors": [9], "source": {"conversion_task_id": "digital"}}
    class Store:
        def query_one(self, statement, parameters):
            assert parameters == (1, 9)
            return None
    scope = {"doc_id": 1, "book_id": 1, "start_page": 1, "end_page": 8, "ready_pages": "[8]"}
    unit = PDFProse(Store(), scope, "revision1", [block]).metadata()["p8"]
    assert unit["pending"] and unit["ref"]["version"] == "revision1"


def test_discretionary_cross_page_hyphen_maps_only_to_surviving_source():
    head = SourceBlock(1, "older-first", {"id": "p8", "text": "😀 locatio-"})
    tail = SourceBlock(2, "older-next", {"id": "p9", "text": "n."})
    paragraph = Paragraph((head, tail))
    assert paragraph.text == "😀 location."
    target = projected_anchor(paragraph, "older-first", 0, len(paragraph.text))
    ranges = source_ranges(target, 2, 10)
    assert [(p["doc_id"], p["revision"], p["start"], p["end"], p["quote"]) for p in ranges] == [
        (1, "older-first", 3, 10, "locatio"), (2, "older-next", 0, 1, "n"),
    ]
    real = Paragraph((SourceBlock(1, "r1", {"id": "p8", "text": "well-"}),
                      SourceBlock(2, "r2", {"id": "p9", "text": "known"})))
    assert real.text == "well- known"


@pytest.fixture(scope="module")
def digital_worker():
    if subprocess.run([worker_python(), "-c", "import pdfplumber, pypdfium2"], capture_output=True).returncode:
        pytest.skip("local PDF lab dependencies are not installed")


def import_pdf(client, case, count):
    reply = client.post("/api/pdf/imports", data={"engine": "digital"},
                        files={"file": (f"{case}.pdf", pdf_fixture(case), "application/pdf")})
    assert reply.is_success, reply.text
    book_id = reply.json()["book_id"]
    for _ in range(240):
        book = client.get(f"/api/pdf/books/{book_id}").json()
        if book["pdf"]["ready_pages"] == count and book["task"]["state"] == "completed":
            return book
        assert book["task"]["state"] != "failed", book
        time.sleep(.05)
    pytest.fail(f"PDF publication did not finish: {book}")


def test_real_import_and_projection_across_reader_ranges(digital_worker, monkeypatch):
    requests = []

    async def fake_provider(app, request, prompt, payload, provider, *, on_response):
        requests.append(payload["paragraphs"])
        if len(requests) == 1:
            return {"paragraphs": []}
        return {"paragraphs": [{"id": item["id"], "segments": [{"quote": item["source"], "zh": "译文"}]}
                               for item in payload["paragraphs"]]}

    monkeypatch.setattr("wise_reader.page_translation.model_json", fake_provider)
    with TestClient(create_app()) as client:
        book = import_pdf(client, "range-edge", 9)
        left, right = [client.get(f"/api/documents/{r['doc_id']}").json() for r in book["pdf"]["ranges"]]
        head = next(b for b in left["blocks"] if b["source_page"] == 8 and b["text"].startswith(BEFORE[0]))
        tail = next(b for b in right["blocks"] if b["text"] == AFTER)
        assert left["pdf"]["prose"][head["id"]] == right["pdf"]["prose"][tail["id"]]
        ref = right["pdf"]["prose"][tail["id"]]["ref"]
        assert ref["doc_id"] == left["id"] and ref["version"] != left["version"]
        client.put("/api/ai/config", json={"text": {"enabled": True,
            "base_url": "http://127.0.0.1:1/v1", "api_key": "fixture", "model": "fixture"}}).raise_for_status()
        path = f"/api/documents/{right['id']}/page-translation"
        generate = {"generate": True, "blocks": [ref]}
        poll = {"blocks": [ref]}
        started = client.post(path, json=generate).raise_for_status().json()
        assert started["batch"]["total"] == 1
        assert started["blocks"][0]["status"] == "pending"
        failed = client.post(path, json=generate).raise_for_status().json()
        assert failed["blocks"][0]["status"] == "failed"
        expected = [{"id": 0, "source": " ".join([*BEFORE, AFTER])}]
        assert requests == [expected]
        client.post(path, json={**poll, "retry": started["batch"]["id"]}).raise_for_status()
        result = client.post(path, json=poll).raise_for_status().json()
        assert requests == [expected, expected]
        assert [(p["doc_id"], p["block_id"], p["revision"]) for p in result["blocks"][0]["segments"][0]["ranges"]] == [
            (left["id"], head["id"], left["version"]), (right["id"], tail["id"], right["version"])]
        plan = client.post(f"/api/documents/{right['id']}/grammar/plan", json={"block_ids": [tail["id"]]}).raise_for_status().json()
        assert plan["sentences"][0]["anchor"]["quote"] == " ".join([*BEFORE, AFTER.split(". ")[0] + "."])
        assert plan["sentences"][0]["selection"]["block_id"] == tail["id"]


def test_real_import_repairs_line_breaks_and_accepts_local_override(digital_worker):
    with TestClient(create_app()) as client:
        book = import_pdf(client, "line-break", 1)
        doc_id = book["pdf"]["reading_doc_id"]
        doc = client.get(f"/api/documents/{doc_id}").raise_for_status().json()
        blocks = doc["blocks"]
        text = " ".join(b["text"] for b in blocks)
        for word in ("prepared", "location", "different", "records", "in side pockets"):
            assert word in text
        path = f"/api/pdf/documents/{doc_id}/prose-override"
        result = client.post(path, json={"revision": doc["version"], "block_id": blocks[1]["id"], "action": "outside"})
        assert result.is_success, result.text
        after = client.get(f"/api/documents/{doc_id}").raise_for_status().json()
        assert "location" not in " ".join(b["text"] for b in after["blocks"])
        margin = [item for b in after["blocks"] for item in b.get("page_furniture", [])]
        assert next(item for item in margin if item["id"] == blocks[1]["id"])["role"] == "excluded"
        result = client.post(path, json={"revision": after["version"], "block_id": blocks[1]["id"], "action": "reset"})
        assert result.is_success, result.text
        restored = client.get(f"/api/documents/{doc_id}").raise_for_status().json()
        assert restored["version"] == doc["version"]
