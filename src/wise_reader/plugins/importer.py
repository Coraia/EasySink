"""导入 EPUB / TXT / Markdown。EPUB 用 zip+xml，不引入 ebooklib。"""

from __future__ import annotations

import html as htmlmod
import io
import re
import zipfile
from xml.etree import ElementTree as ET

from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, UploadFile

from wise_reader.plugins import library as lib
from wise_reader.plugins.runtime import PluginContext, require_plugin

PLUGIN_ID = "importer"
MAX_BYTES = 20 * 1024 * 1024
MAX_CHAPTERS = 80


def migrate(_store) -> None:
    return


def html_to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?i)</(p|div|h[1-6]|li|tr)>", "\n", raw)
    raw = re.sub(r"<[^>]+>", "", raw)
    raw = htmlmod.unescape(raw.replace("&nbsp;", " "))
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in raw.splitlines()]
    text = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _local(tag: str) -> str:
    return tag.split("}")[-1]


def parse_epub(data: bytes) -> tuple[str, str, list[tuple[str, str]]]:
    z = zipfile.ZipFile(io.BytesIO(data))
    names = {n.replace("\\", "/") for n in z.namelist()}
    if "META-INF/container.xml" not in names:
        raise ValueError("not an EPUB")
    container = ET.fromstring(z.read("META-INF/container.xml"))
    opf_path = None
    for el in container.iter():
        if _local(el.tag) == "rootfile":
            opf_path = el.attrib.get("full-path")
            break
    if not opf_path:
        raise ValueError("missing OPF")
    opf_path = opf_path.replace("\\", "/")
    opf = ET.fromstring(z.read(opf_path))
    base = opf_path.rsplit("/", 1)[0] if "/" in opf_path else ""

    def join(p: str) -> str:
        p = p.replace("\\", "/")
        if not base or p.startswith("/"):
            return p.lstrip("/")
        return f"{base}/{p}"

    title = "untitled"
    author = ""
    for el in opf.iter():
        loc = _local(el.tag)
        if loc == "title" and el.text and title == "untitled":
            title = el.text.strip()[:120]
        if loc == "creator" and el.text and not author:
            author = el.text.strip()[:80]

    manifest: dict[str, str] = {}
    spine: list[str] = []
    for el in opf.iter():
        loc = _local(el.tag)
        if loc == "item" and "id" in el.attrib:
            manifest[el.attrib["id"]] = el.attrib.get("href", "")
        if loc == "itemref" and "idref" in el.attrib:
            spine.append(el.attrib["idref"])

    chapters: list[tuple[str, str]] = []
    for i, idref in enumerate(spine):
        href = manifest.get(idref)
        if not href:
            continue
        path = join(href.split("#")[0])
        if path not in names:
            continue
        raw = z.read(path).decode("utf-8", errors="ignore")
        text = html_to_text(raw)
        if len(text) < 40:
            continue
        heading = text.splitlines()[0][:80]
        chapters.append((heading or f"Chapter {i + 1}", text))
        if len(chapters) >= MAX_CHAPTERS:
            break
    if not chapters:
        raise ValueError("empty EPUB")
    return title, author, chapters


def parse_plain(data: bytes, filename: str) -> tuple[str, str, list[tuple[str, str]]]:
    text = data.decode("utf-8", errors="ignore").strip()
    if not text:
        raise ValueError("empty file")
    title = filename.rsplit(".", 1)[0] or "untitled"
    return title, "", [(title, text)]


def register(app: FastAPI, ctx: PluginContext) -> None:
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.post("/api/import")
    async def import_file(file: UploadFile = File(...)):
        data = await file.read()
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "file too large")
        name = (file.filename or "upload").lower()
        try:
            if name.endswith(".epub"):
                title, author, chapters = parse_epub(data)
                source = "epub"
            else:
                title, author, chapters = parse_plain(data, file.filename or "upload")
                source = "txt"
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

        profile = ctx.store.get_profile()
        book_id = lib.add_book(ctx.store, title, author, source)
        saved = []
        for i, (ch_title, text) in enumerate(chapters):
            doc = ctx.engine.ingest(ch_title, text, profile)
            lib.add_chapter(ctx.store, book_id, i, ch_title, doc["id"])
            saved.append({"title": ch_title, "doc_id": doc["id"], "word_count": doc["word_count"]})
        return {
            "book_id": book_id,
            "title": title,
            "author": author,
            "source": source,
            "chapters": saved,
        }

    app.include_router(router)
