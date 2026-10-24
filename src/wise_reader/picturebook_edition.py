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


def children_document_ids(store):
    # Exact text identity of the old bundled six-scene sample, exported by
    # web/picturebook-story.js. Keep its data, but retire its adult-shelf entry.
    demo_hash = "f0924fcf1c3d9c7626970113e5baa9b37b1da8769b74d69d4f477393c36bcd50"
    return {row["doc_id"] for row in store.query(
        "SELECT c.doc_id FROM wr_chapter c JOIN wr_book b ON b.id=c.book_id"
        " WHERE b.source LIKE 'picturebook:%'"
        " UNION SELECT id AS doc_id FROM document WHERE text_hash=?", (demo_hash,))}


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
    @app.get("/api/picturebook/shelf")
    def shelf():
        # Ownership comes from the installed catalog source, never a book title
        # or the adult reader's last selected presentation mode.
        book = edition()
        installed = store.query_one(
            "SELECT * FROM wr_book WHERE source=? ORDER BY id LIMIT 1",
            ("picturebook:" + book["id"],),
        )
        chapters = store.query(
            "SELECT c.idx,c.title,c.doc_id FROM wr_chapter c"
            " JOIN document d ON d.id=c.doc_id WHERE c.book_id=? ORDER BY c.idx",
            (installed["id"],),
        ) if installed else []
        return {"purchases_enabled": False, "books": [{
            "catalog_id": book["id"], "title": "小王子", "english_title": "The Little Prince",
            "author": book["author"], "book_id": installed["id"] if installed else None,
            "chapter_count": len(book["chapters"]), "chapters": chapters,
        }]}

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
