"""Core content and selectors. Independent of optional library/progress interfaces."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser

from pydantic import BaseModel, Field


def migrate(store):
    store.executescript("""
    CREATE TABLE IF NOT EXISTS wr_schema(version INTEGER PRIMARY KEY, applied_at TEXT);
    CREATE TABLE IF NOT EXISTS wr_book(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wr_chapter(id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER NOT NULL,
      idx INTEGER NOT NULL, title TEXT NOT NULL, doc_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wr_content(doc_id INTEGER PRIMARY KEY, version TEXT NOT NULL, blocks TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wr_anchor(owner TEXT NOT NULL, owner_id INTEGER NOT NULL, doc_id INTEGER NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(owner,owner_id));
    CREATE TABLE IF NOT EXISTS wr_archive(doc_id INTEGER PRIMARY KEY, archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wr_target(target TEXT PRIMARY KEY, verdict TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT OR IGNORE INTO wr_schema VALUES(2, datetime('now'));
    """)


class Anchor(BaseModel):
    version: str = Field(default="", max_length=64)
    block_id: str = Field(default="", max_length=80)
    start: int = Field(default=0, ge=0)
    end: int = Field(default=0, ge=0)
    quote: str = Field(default="", max_length=10000)
    prefix: str = Field(default="", max_length=80)
    suffix: str = Field(default="", max_length=80)
    ratio: float = Field(default=0, ge=0, le=1)


def save_anchor(store, owner, owner_id, doc_id, anchor):
    if anchor is not None:
        store.execute(
            "INSERT OR REPLACE INTO wr_anchor VALUES(?,?,?,?)",
            (owner, owner_id, doc_id, anchor.model_dump_json()),
        )


def with_anchor(store, owner, row):
    if not row:
        return row
    a = store.query_one(
        "SELECT payload FROM wr_anchor WHERE owner=? AND owner_id=?",
        (owner, row.get("id", row.get("doc_id"))),
    )
    return {**row, "anchor": json.loads(a["payload"]) if a else None}


def add_book(store, title, author="", source="manual"):
    return int(
        store.execute(
            "INSERT INTO wr_book(title,author,source,created_at) VALUES(?,?,?,?)",
            (title, author, source, datetime.now(timezone.utc).isoformat()),
        ).lastrowid
    )


def add_chapter(store, book_id, idx, title, doc_id):
    return int(
        store.execute(
            "INSERT INTO wr_chapter(book_id,idx,title,doc_id) VALUES(?,?,?,?)",
            (book_id, idx, title, doc_id),
        ).lastrowid
    )


def blocks_from_text(text):
    """Keep exact original offsets, including legacy single-newline paragraphs."""
    blocks = []
    for m in re.finditer(r"[^\n]+(?:\n(?=[^\n]))?", text):
        s = m.group().rstrip("\n")
        if s.strip():
            kind = "heading" if re.match(r"^#{1,6}\s", s) else "paragraph"
            blocks.append(
                {"type": kind, "text": s, "start": m.start(), "end": m.start() + len(s)}
            )
    return identify(blocks)


def identify(blocks):
    seen = {}
    for b in blocks:
        key = hashlib.sha256((b["type"] + "\0" + b["text"]).encode()).hexdigest()[:16]
        seen[key] = seen.get(key, 0) + 1
        b["id"] = f"b-{key}-{seen[key]}"
    return blocks


class SemanticHTML(HTMLParser):
    """Extract safe semantic blocks; never execute or retain active HTML."""

    TYPES = {
        "p": "paragraph",
        "h1": "heading",
        "h2": "heading",
        "h3": "heading",
        "h4": "heading",
        "h5": "heading",
        "h6": "heading",
        "li": "list-item",
        "pre": "code",
        "blockquote": "quote",
        "figcaption": "caption",
        "dt": "heading",
        "dd": "paragraph",
        "tr": "paragraph",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.buf = []
        self.kind = "paragraph"
        self.skip = 0

    def flush(self):
        text = "".join(self.buf)
        text = (
            text.strip() if self.kind == "code" else re.sub(r"\s+", " ", text).strip()
        )
        if text:
            self.blocks.append({"type": self.kind, "text": text})
        self.buf = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        if self.skip:
            return
        if tag in self.TYPES:
            self.flush()
            self.kind = self.TYPES[tag]
        elif tag == "br":
            self.buf.append("\n")
        elif tag == "img":
            self.flush()
            alt = dict(attrs).get("alt", "插图")
            self.blocks.append({"type": "caption", "text": f"[图片：{alt}]"})
        elif tag in ("td", "th"):
            self.buf.append(" · ")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self.skip = max(0, self.skip - 1)
            return
        if not self.skip and (tag in self.TYPES or tag == "div"):
            self.flush()
            self.kind = "paragraph"

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)


def html_blocks(raw):
    parser = SemanticHTML()
    parser.feed(raw)
    parser.flush()
    pos = 0
    for b in parser.blocks:
        b["start"] = pos
        b["end"] = pos + len(b["text"])
        pos = b["end"] + 2
    return identify(parser.blocks)


def put_content(store, doc_id, text, blocks=None):
    version = hashlib.sha256(text.encode()).hexdigest()
    blocks = blocks if blocks is not None else blocks_from_text(text)
    store.execute(
        "INSERT OR REPLACE INTO wr_content VALUES(?,?,?)",
        (doc_id, version, json.dumps(blocks, ensure_ascii=False)),
    )
    return version, blocks


def get_content(store, row):
    existing = store.query_one("SELECT * FROM wr_content WHERE doc_id=?", (row["id"],))
    if existing:
        return existing["version"], json.loads(existing["blocks"])
    return put_content(store, row["id"], row["text"])
