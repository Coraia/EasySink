"""Core content and selectors. Independent of optional library/progress interfaces."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Literal

from pydantic import BaseModel, Field, FiniteFloat, model_validator


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


class PDFSource(BaseModel):
    page_number: int = Field(ge=1)
    bbox: list[FiniteFloat] = Field(min_length=4, max_length=4)
    width: FiniteFloat | None = Field(default=None, gt=0)
    height: FiniteFloat | None = Field(default=None, gt=0)
    coordinate_space: Literal["rotated_crop_top_left"] = "rotated_crop_top_left"
    book_id: int | None = Field(default=None, ge=1)
    source_sha256: str = Field(default="", max_length=64)
    rotation: int = 0
    crop_box: list[FiniteFloat] | None = Field(default=None, min_length=4, max_length=4)
    asset_url: str | None = Field(default=None, max_length=2048)
    object_id: str = Field(default="", max_length=80)
    revision: str = Field(default="", max_length=128)
    conversion_task_id: str = Field(default="", max_length=100)

    @model_validator(mode="after")
    def valid_region(self):
        x0, y0, x1, y1 = self.bbox
        if x0 < 0 or y0 < 0 or x1 < x0 or y1 < y0:
            raise ValueError("Invalid PDF source region")
        if self.width is not None and x1 > self.width + 0.1:
            raise ValueError("PDF region exceeds visible width")
        if self.height is not None and y1 > self.height + 0.1:
            raise ValueError("PDF region exceeds visible height")
        return self


class AnchorSegment(BaseModel):
    block_id: str = Field(default="", max_length=80)
    start: int = Field(default=0, ge=0)
    end: int = Field(default=0, ge=0)
    quote: str = Field(default="", max_length=10000)
    prefix: str = Field(default="", max_length=80)
    suffix: str = Field(default="", max_length=80)
    kind: Literal["text", "image"] = "text"
    pdf_source: PDFSource | None = None


class Anchor(AnchorSegment):
    version: str = Field(default="", max_length=64)
    ratio: float = Field(default=0, ge=0, le=1)
    segments: list[AnchorSegment] = Field(default_factory=list, max_length=256)


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
        "tr": "table-row",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.buf = []
        self.kind = "paragraph"
        self.skip = 0
        self.stack = []
        self.rows = []

    def current_kind(self):
        if "pre" in self.stack:
            return "code"
        for tag in reversed(self.stack):
            if tag in ("li", "blockquote"):
                return self.TYPES[tag]
        return next((self.TYPES[tag] for tag in reversed(self.stack)
                     if tag in self.TYPES), "paragraph")

    def finish_cell(self):
        row = self.rows[-1]
        if row["cell"] is not None:
            row["cells"].append(re.sub(r"\s+", " ", "".join(row["cell"])).strip())
            row["cell"] = None

    def flush(self):
        if self.rows:
            return
        text = "".join(self.buf)
        text = (
            text.strip("\r\n") if self.kind == "code" else re.sub(r"\s+", " ", text).strip()
        )
        if text:
            self.blocks.append({"type": self.kind, "text": text})
        self.buf = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        if self.skip:
            return
        if tag == "tr":
            self.flush()
            self.rows.append({"cells": [], "cell": None})
        elif tag in ("td", "th") and self.rows:
            self.finish_cell()
            self.rows[-1]["cell"] = []
        elif self.rows and tag in self.TYPES:
            if self.rows[-1]["cell"] is not None:
                self.rows[-1]["cell"].append(" ")
        if tag in self.TYPES:
            self.flush()
        elif tag == "br":
            self.handle_data("\n")
        elif tag == "img":
            self.flush()
            alt = dict(attrs).get("alt", "插图")
            if self.rows:
                self.handle_data(f"[图片：{alt}]")
            else:
                self.blocks.append({"type": "caption", "text": f"[图片：{alt}]"})
        if tag not in ("br", "img", "hr", "meta", "link", "input", "wbr", "source"):
            self.stack.append(tag)
        self.kind = self.current_kind()

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag in ("td", "th") and self.rows:
            self.finish_cell()
        elif tag == "tr" and self.rows:
            self.finish_cell()
            row = self.rows.pop()
            text = " · ".join(row["cells"])
            if any(row["cells"]):
                if self.rows:
                    self.handle_data(text)
                else:
                    self.blocks.append({"type": "table-row", "text": text,
                                        "cells": row["cells"]})
        elif tag in self.TYPES or tag == "div":
            self.flush()
        if tag in self.stack:
            # Tolerate missing closing tags without leaking a child role.
            i = len(self.stack) - 1 - self.stack[::-1].index(tag)
            del self.stack[i:]
        self.kind = self.current_kind()

    def handle_data(self, data):
        if not self.skip:
            if self.rows:
                if self.rows[-1]["cell"] is not None:
                    self.rows[-1]["cell"].append(data)
            else:
                self.buf.append(data)


def html_blocks(raw):
    parser = SemanticHTML()
    parser.feed(raw)
    parser.close()
    while parser.rows:
        parser.handle_endtag("tr")
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
