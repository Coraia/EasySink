"""全书搜索后端测试：FTS5、兜底扫描、游标分页、UTF-16 锚点、同步触发器、PDF 隔离与千页性能。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time

from fastapi.testclient import TestClient

from wise_reader import content
from wise_reader.app import create_app
from wise_reader.plugins import search as search_plugin
from wise_reader.settings import Settings
from wise_reader.store import Store


def _insert_chapter(
    store: Store,
    book_id: int,
    idx: int,
    title: str,
    text: str,
    blocks: list[dict] | None = None,
) -> int:
    doc_id = store.save_document(
        title=title,
        text=text,
        word_count=len(text.split()),
        text_hash=hashlib.sha256(text.encode()).hexdigest(),
        l0=[],
        l1=[],
    )
    content.put_content(store, doc_id, text, blocks=blocks)
    content.add_chapter(store, book_id, idx, title, doc_id)
    return doc_id


def _create_multi_chapter_book(store: Store, title: str, chapters: list[tuple[str, str, list[dict] | None]]) -> tuple[int, list[int]]:
    book_id = content.add_book(store, title, source="epub")
    doc_ids = []
    for idx, (ch_title, ch_text, ch_blocks) in enumerate(chapters):
        doc_ids.append(_insert_chapter(store, book_id, idx, ch_title, ch_text, ch_blocks))
    return book_id, doc_ids


def test_book_search_fts_word_prefix_phrase_case_and_diacritics():
    app = create_app(Settings(_env_file=None))
    with TestClient(app) as client:
        store = app.state.store
        book_id, doc_ids = _create_multi_chapter_book(
            store,
            "Philosophy Volume",
            [
                ("Chapter 1", "A naïve approach to Epistemology and logic.", None),
                ("Chapter 2", "The Categorical Imperative in moral philosophy.", None),
                ("Chapter 3", "Boolean terms like NOT or NEAR appear here.", None),
            ],
        )

        # Prefix search + chapter order
        res = client.get(f"/api/library/books/{book_id}/search", params={"q": "epistem"})
        assert res.status_code == 200
        data = res.json()
        assert data["matched_chapters"] == 1
        assert len(data["hits"]) == 1
        assert data["hits"][0]["doc_id"] == doc_ids[0]
        assert data["hits"][0]["snippet_match"] == "Epistem"
        assert data["hits"][0]["snippet_after"].startswith("ology")

        # Case-insensitive phrase search
        res = client.get(
            f"/api/library/books/{book_id}/search",
            params={"q": "categorical imperative"},
        )
        assert res.status_code == 200
        hits = res.json()["hits"]
        assert len(hits) == 1
        assert hits[0]["doc_id"] == doc_ids[1]
        assert hits[0]["chapter_idx"] == 1
        assert hits[0]["anchor"]["quote"] == "Categorical Imperative"

        # Diacritics + exact match
        res = client.get(f"/api/library/books/{book_id}/search", params={"q": "naïve"})
        assert res.status_code == 200
        assert len(res.json()["hits"]) == 1

        # FTS5 operator words safely quoted
        res = client.get(f"/api/library/books/{book_id}/search", params={"q": "NOT"})
        assert res.status_code == 200
        assert len(res.json()["hits"]) == 1
        assert res.json()["hits"][0]["doc_id"] == doc_ids[2]


def test_book_search_fallback_substring_and_cjk():
    app = create_app(Settings(_env_file=None))
    with TestClient(app) as client:
        store = app.state.store
        book_id, doc_ids = _create_multi_chapter_book(
            store,
            "Bilingual Text",
            [
                ("Intro", "Exploring epistemology and phenomenology.", None),
                ("Note", "关于认识论与现象学的简短笔记。", None),
            ],
        )

        # Mid-word substring triggers single-book fallback
        res = client.get(f"/api/library/books/{book_id}/search", params={"q": "ology"})
        assert res.status_code == 200
        hits = res.json()["hits"]
        assert len(hits) == 2
        assert [h["snippet_match"] for h in hits] == ["ology", "ology"]

        # CJK substring
        res = client.get(f"/api/library/books/{book_id}/search", params={"q": "现象学"})
        assert res.status_code == 200
        hits = res.json()["hits"]
        assert len(hits) == 1
        assert hits[0]["doc_id"] == doc_ids[1]
        assert hits[0]["anchor"]["quote"] == "现象学"


def test_book_search_headings_only_and_is_heading():
    app = create_app(Settings(_env_file=None))
    with TestClient(app) as client:
        store = app.state.store
        ch1_text = "# Method Overview\n\nThis method applies everywhere."
        ch2_text = "Another paragraph mentioning method.\n\n## Conclusion on Method"
        book_id, doc_ids = _create_multi_chapter_book(
            store,
            "Structured Book",
            [
                ("Chapter 1", ch1_text, None),
                ("Chapter 2", ch2_text, None),
            ],
        )

        all_res = client.get(f"/api/library/books/{book_id}/search", params={"q": "method"})
        assert all_res.status_code == 200
        all_hits = all_res.json()["hits"]
        assert len(all_hits) == 4
        assert [h["is_heading"] for h in all_hits] == [True, False, False, True]

        heading_res = client.get(
            f"/api/library/books/{book_id}/search",
            params={"q": "method", "headings_only": "true"},
        )
        assert heading_res.status_code == 200
        heading_hits = heading_res.json()["hits"]
        assert len(heading_hits) == 2
        assert all(h["is_heading"] for h in heading_hits)
        assert [h["doc_id"] for h in heading_hits] == [doc_ids[0], doc_ids[1]]


def test_book_search_cursor_pagination():
    app = create_app(Settings(_env_file=None))
    with TestClient(app) as client:
        store = app.state.store
        book_id, _ = _create_multi_chapter_book(
            store,
            "Paginated Book",
            [
                ("Ch 1", "Signal one and signal two.\n\nSignal three in next block.", None),
                ("Ch 2", "Signal four here.\n\nSignal five and signal six.", None),
            ],
        )

        collected = []
        cursor = None
        while True:
            params = {"q": "signal", "limit": 2}
            if cursor:
                params["cursor"] = cursor
            res = client.get(f"/api/library/books/{book_id}/search", params=params)
            assert res.status_code == 200
            page = res.json()
            assert len(page["hits"]) <= 2
            collected.extend(page["hits"])
            if not page["has_more"]:
                assert page["next_cursor"] is None
                break
            cursor = page["next_cursor"]
            assert cursor is not None

        assert len(collected) == 6
        positions = [
            (h["doc_id"], h["block_id"], h["anchor"]["start"]) for h in collected
        ]
        assert len(set(positions)) == 6

        bad = client.get(
            f"/api/library/books/{book_id}/search",
            params={"q": "signal", "cursor": "bad-cursor"},
        )
        assert bad.status_code == 422


def test_book_search_utf16_offsets():
    app = create_app(Settings(_env_file=None))
    with TestClient(app) as client:
        store = app.state.store
        # 😀 is 1 Python code point but 2 UTF-16 code units.
        text = "Prefix 😀 target phrase end."
        book_id, _ = _create_multi_chapter_book(
            store,
            "Emoji UTF16 Book",
            [("Ch 1", text, None)],
        )

        res = client.get(f"/api/library/books/{book_id}/search", params={"q": "target"})
        assert res.status_code == 200
        hit = res.json()["hits"][0]
        anchor = hit["anchor"]
        assert anchor["quote"] == "target"
        # "Prefix " (7) + "😀" (2 UTF-16 units) + " " (1) = 10
        assert anchor["start"] == 10
        assert anchor["end"] == 16
        raw_u16 = text.encode("utf-16-le")
        sliced = raw_u16[anchor["start"] * 2 : anchor["end"] * 2].decode("utf-16-le")
        assert sliced == "target"


def test_fts_triggers_and_legacy_rebuild_migration(tmp_path):
    db_path = tmp_path / "legacy.db"
    store = Store(db_path)
    book_id, doc_ids = _create_multi_chapter_book(
        store,
        "Legacy Book",
        [
            ("Ch 1", "Initial ontology text.", None),
            ("Ch 2", "Second chapter phenomenology.", None),
        ],
    )
    # Simulate an existing DB upgraded before wr_doc_fts existed.
    store.executescript(
        """
        DROP TRIGGER IF EXISTS wr_doc_fts_ai;
        DROP TRIGGER IF EXISTS wr_doc_fts_ad;
        DROP TRIGGER IF EXISTS wr_doc_fts_au;
        DROP TABLE IF EXISTS wr_doc_fts;
        """
    )
    search_plugin.migrate(store)

    res = search_plugin.search_book(store, book_id, "ontology")
    assert len(res["hits"]) == 1

    # Update document text and verify AU trigger syncs FTS immediately.
    new_text = "Replaced with hermeneutics text."
    store.execute("UPDATE document SET text = ? WHERE id = ?", (new_text, doc_ids[0]))
    content.put_content(store, doc_ids[0], new_text)
    assert search_plugin.search_book(store, book_id, "ontology")["hits"] == []
    assert len(search_plugin.search_book(store, book_id, "hermeneutics")["hits"]) == 1

    # Delete document and verify AD trigger removes it from FTS.
    store.delete_document(doc_ids[1])
    assert search_plugin.search_book(store, book_id, "phenomenology")["hits"] == []
    store.close()


def test_pdf_book_search_coverage_source_and_recycled_isolation(tmp_path):
    app = create_app(Settings(_env_file=None))
    with TestClient(app) as client:
        store = app.state.store
        pdf = app.state.pdf

        raw_pdf = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"
        tmp_pdf = tmp_path / "book.pdf"
        tmp_pdf.write_bytes(raw_pdf)
        digest = hashlib.sha256(raw_pdf).hexdigest()
        source, task, _ = pdf.originals.register(
            tmp_pdf, "Academic PDF", digest, len(raw_pdf), 24, 1.0
        )
        mapping = pdf._ensure_book(source)
        book_id = mapping["book_id"]

        pdf_source = {
            "page_number": 12,
            "bbox": [10.0, 20.0, 200.0, 60.0],
            "width": 600.0,
            "height": 800.0,
            "coordinate_space": "rotated_crop_top_left",
            "book_id": book_id,
            "source_sha256": digest,
        }
        block_text = "Transcendental deduction in Kantian philosophy."
        blocks = [
            {
                "id": "pdf-b1",
                "type": "heading",
                "text": block_text,
                "start": 0,
                "end": len(block_text),
                "source": pdf_source,
                "source_page": 12,
            }
        ]
        doc_id = _insert_chapter(
            store,
            book_id,
            1,
            "Academic PDF · 原页 9–16",
            block_text,
            blocks=blocks,
        )
        store.execute(
            "INSERT INTO wr_pdf_range VALUES(?,?,?,?,?,?,?,?)",
            (book_id, 9, 16, doc_id, json.dumps(list(range(9, 17))), 8, "rev1", time.time()),
        )

        res = client.get(f"/api/library/books/{book_id}/search", params={"q": "deduction"})
        assert res.status_code == 200
        data = res.json()
        assert data["coverage"] == {"ready_pages": 8, "page_count": 24}
        assert len(data["hits"]) == 1
        hit = data["hits"][0]
        assert hit["page_number"] == 12
        assert hit["is_heading"] is True
        assert hit["anchor"]["pdf_source"] == pdf_source

        # Recycled PDF books must not be searchable.
        store.execute(
            "UPDATE wr_pdf_book SET lifecycle='recycled' WHERE book_id=?", (book_id,)
        )
        recycled = client.get(f"/api/library/books/{book_id}/search", params={"q": "deduction"})
        assert recycled.status_code == 404


def test_search_plugin_toggle():
    app = create_app(Settings(_env_file=None))
    with TestClient(app) as client:
        book_id, _ = _create_multi_chapter_book(
            app.state.store,
            "Toggle Book",
            [("Ch 1", "Alpha beta gamma.", None)],
        )
        assert (
            client.get(f"/api/library/books/{book_id}/search", params={"q": "beta"}).status_code
            == 200
        )
        client.patch("/api/plugins/search", json={"enabled": False})
        assert (
            client.get(f"/api/library/books/{book_id}/search", params={"q": "beta"}).status_code
            == 404
        )
        client.patch("/api/plugins/search", json={"enabled": True})
        assert (
            client.get(f"/api/library/books/{book_id}/search", params={"q": "beta"}).status_code
            == 200
        )


def test_thousand_page_book_search_performance(tmp_path):
    store = Store(tmp_path / "perf.db")
    search_plugin.migrate(store)
    book_id = content.add_book(store, "1000-Page Treatise", source="pdf")

    common_para = (
        "Relationships help us understand how knowledge develops through careful "
        "attention and systematic reflection across chapters. "
    ) * 40  # ~4.8 KB per block
    blocks_template = [
        {"id": f"b-{j}", "type": "paragraph", "text": common_para}
        for j in range(5)
    ]
    base_text = "\n\n".join(common_para for _ in range(5))  # ~24 KB/chapter => 125 * 24 KB = ~3 MB

    with store.transaction():
        for idx in range(125):
            if idx == 99:
                special = "RareHeadingMilestone in chapter hundred."
                ch_text = special + "\n\n" + base_text
                ch_blocks = [
                    {"id": "b-rare", "type": "heading", "text": special, "source_page": 793},
                    *[
                        {**b, "id": f"b-{idx}-{j}", "source_page": idx * 8 + 1}
                        for j, b in enumerate(blocks_template)
                    ],
                ]
            else:
                ch_text = base_text
                ch_blocks = [
                    {**b, "id": f"b-{idx}-{j}", "source_page": idx * 8 + 1}
                    for j, b in enumerate(blocks_template)
                ]
            doc_id = store.save_document(
                title=f"Ch {idx + 1}",
                text=ch_text,
                word_count=len(ch_text.split()),
                text_hash=f"h-{idx}",
                l0=[],
                l1=[],
            )
            content.put_content(store, doc_id, ch_text, blocks=ch_blocks)
            content.add_chapter(store, book_id, idx, f"Ch {idx + 1}", doc_id)

    t0 = time.perf_counter()
    rare_res = search_plugin.search_book(store, book_id, "RareHeadingMilestone")
    rare_elapsed_ms = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    freq_res = search_plugin.search_book(store, book_id, "systematic", limit=30)
    freq_elapsed_ms = (time.perf_counter() - t1) * 1000

    store.close()

    assert len(rare_res["hits"]) == 1
    assert rare_res["hits"][0]["page_number"] == 793
    assert rare_res["hits"][0]["is_heading"] is True
    assert len(freq_res["hits"]) == 30
    assert freq_res["has_more"] is True
    assert rare_elapsed_ms < 100.0
    assert freq_elapsed_ms < 100.0
