"""Bundled, attributed full-text edition with stable key-event anchors."""
from functools import lru_cache
import hashlib
import json
from pathlib import Path

from fastapi import HTTPException
from wise_reader import content

ASSETS = Path(__file__).resolve().parents[2] / "web" / "assets" / "picturebook-full"


@lru_cache(maxsize=1)
def edition():
    return json.loads((ASSETS / "book.json").read_text())


def story_plan(doc, blocks):
    book = edition()
    digest = hashlib.sha256(doc["text"].encode()).hexdigest()
    chapter = next((c for c in book["chapters"] if c["sha256"] == digest), None)
    if not chapter or [b.get("text") for b in blocks] != chapter["paragraphs"]:
        return None
    return {
        "id": book["id"], "chapter": chapter["number"], "chapter_count": len(book["chapters"]),
        "title": chapter["title"], "en": chapter["en"],
        "source": {k: book[k] for k in ("author", "translator", "publisher", "year", "isbn", "license", "license_url", "source_url", "changes", "dedication")},
        "frames": [{k: f[k] for k in ("id", "paragraph", "start", "title", "description", "file", "cell")} for f in chapter["frames"]],
        "asset_base": "/static/assets/picturebook-full/",
        "illustration_count": book["illustration_count"],
    }


def register_edition(app, store):
    @app.post("/api/picturebook/little-prince/install")
    def install():
        book = edition()
        source = "picturebook:" + book["id"]

        def existing():
            row = store.query_one("SELECT id FROM wr_book WHERE source=? ORDER BY id LIMIT 1", (source,))
            if not row:
                return None
            chapters = store.query("SELECT c.idx,c.doc_id,d.text FROM wr_chapter c LEFT JOIN document d ON c.doc_id=d.id WHERE c.book_id=? ORDER BY c.idx", (row["id"],))
            if len(chapters) != len(book["chapters"]) or any(
                c["idx"] != i or c["text"] != original["text"]
                for i, (c, original) in enumerate(zip(chapters, book["chapters"]))
            ):
                raise HTTPException(409, "这本绘本的章节已被更改，请先在书架检查；不会覆盖你的内容")
            return {"book_id": row["id"], "doc_id": chapters[0]["doc_id"], "chapters": len(chapters), "existing": True}

        found = existing()
        if found:
            return found
        files = {f["file"] for c in book["chapters"] for f in c["frames"]}
        if not all((ASSETS / name).is_file() for name in files):
            raise HTTPException(503, "全书插画正在制作，请稍后再打开")
        engine = app.state.engine
        prepared = [engine.prepare_import(c["title"], c["text"], content.blocks_from_text(c["text"])) for c in book["chapters"]]
        # The complete book appears atomically, including concurrent install clicks.
        with store.transaction():
            found = existing()
            if found:
                return found
            book_id = content.add_book(store, book["title"], book["author"], source)
            first = None
            for i, (chapter, data) in enumerate(zip(book["chapters"], prepared)):
                doc = engine.persist_import(data, cache_analysis=False)
                content.add_chapter(store, book_id, i, chapter["title"], doc["id"])
                first = first or doc["id"]
        return {"book_id": book_id, "doc_id": first, "chapters": len(prepared), "existing": False}
