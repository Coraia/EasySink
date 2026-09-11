"""Bounded EPUB extraction with explicit errors and transactional import."""

from __future__ import annotations

import io
import posixpath
import zipfile
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, UploadFile

from wise_reader import content
from wise_reader.plugins.runtime import PluginContext, require_plugin

PLUGIN_ID = "importer"
MAX_BYTES = 20 * 1024 * 1024
MAX_CHAPTERS = 500
MAX_EXPANDED = 100 * 1024 * 1024


def html_to_text(raw):
    return "\n\n".join(b["text"] for b in content.html_blocks(raw))


def _local(tag):
    return tag.split("}")[-1]


def _resolve(base, href):
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc:
        raise ValueError("EPUB 引用了外部章节，无法完整导入")
    path = posixpath.normpath(
        posixpath.join(base, unquote(parsed.path).replace("\\", "/"))
    )
    if path.startswith("../") or path.startswith("/"):
        raise ValueError("EPUB 路径越界")
    return path


def parse_epub_structured(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()
            if len(infos) > 5000 or sum(i.file_size for i in infos) > MAX_EXPANDED:
                raise ValueError("EPUB 解压后超过 100 MB 或文件数超过 5000")
            if any(i.file_size > 8 * 1024 * 1024 for i in infos):
                raise ValueError("EPUB 单个资源超过 8 MB")
            if "META-INF/encryption.xml" in z.namelist():
                # Font obfuscation can coexist with readable chapters; encrypted text cannot.
                enc = z.read("META-INF/encryption.xml").decode("utf-8")
                if "xmlenc#aes" in enc:
                    raise ValueError("不支持加密的 EPUB 内容")
            container = ET.fromstring(z.read("META-INF/container.xml"))
            opf_path = next(
                (
                    e.attrib.get("full-path")
                    for e in container.iter()
                    if _local(e.tag) == "rootfile"
                ),
                None,
            )
            if not opf_path:
                raise ValueError("EPUB 缺少书籍清单")
            opf = ET.fromstring(z.read(_resolve("", opf_path)))
            base = posixpath.dirname(opf_path)
            title = next(
                (e.text for e in opf.iter() if _local(e.tag) == "title" and e.text),
                "Untitled",
            )
            author = next(
                (e.text for e in opf.iter() if _local(e.tag) == "creator" and e.text),
                "",
            )
            manifest = {
                e.attrib["id"]: e.attrib.get("href", "")
                for e in opf.iter()
                if _local(e.tag) == "item" and "id" in e.attrib
            }
            spine = [
                e.attrib["idref"]
                for e in opf.iter()
                if _local(e.tag) == "itemref" and "idref" in e.attrib
            ]
            if len(spine) > MAX_CHAPTERS:
                raise ValueError("超过 500 章，请拆分书籍后导入（尚未保存任何章节）")
            chapters = []
            total_chars = 0
            for idx, ref in enumerate(spine):
                if ref not in manifest:
                    raise ValueError(f"第 {idx + 1} 章缺少清单记录")
                path = _resolve(base, manifest[ref])
                raw = z.read(path).decode("utf-8-sig")
                blocks = content.html_blocks(raw)
                if not blocks:
                    continue
                text = "\n\n".join(b["text"] for b in blocks)
                total_chars += len(text)
                if len(text) > 500000 or total_chars > 5000000:
                    raise ValueError(
                        "正文过长：每章最多 50 万字符，整书最多 500 万字符，请拆分后导入"
                    )
                heading = next(
                    (b["text"] for b in blocks if b["type"] == "heading"),
                    f"Chapter {idx + 1}",
                )
                chapters.append((heading[:120], text, blocks))
            if not chapters:
                raise ValueError("EPUB 中没有可读取的文字")
            return title.strip()[:200], author.strip()[:160], chapters
    except (
        zipfile.BadZipFile,
        KeyError,
        ET.ParseError,
        UnicodeDecodeError,
        RuntimeError,
        OSError,
    ) as e:
        raise ValueError("EPUB 文件损坏、编码不支持或章节缺失，尚未导入") from e


def parse_epub(data):
    title, author, chapters = parse_epub_structured(data)
    return title, author, [(t, s) for t, s, _ in chapters]


def parse_plain(data, filename):
    try:
        text = data.decode("utf-8-sig").strip()
    except UnicodeDecodeError as e:
        raise ValueError("请将文本保存为 UTF-8 编码后重试") from e
    if not text:
        raise ValueError("文件没有文字")
    if len(text) > 500000:
        raise ValueError("单篇文本最多 50 万字符，请拆分后导入")
    title = filename.rsplit(".", 1)[0] or "Untitled"
    return title, "", [(title, text)]


def register(app: FastAPI, ctx: PluginContext):
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.post("/api/import")
    def import_file(file: UploadFile = File(...)):
        data = file.file.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "文件超过 20 MB")
        name = file.filename or "upload.txt"
        try:
            if name.lower().endswith(".epub"):
                title, author, chapters = parse_epub_structured(data)
                source = "epub"
            elif name.lower().endswith((".txt", ".md", ".markdown")):
                title, author, plain = parse_plain(data, name)
                source = "txt"
                chapters = [(t, s, content.blocks_from_text(s)) for t, s in plain]
            else:
                raise ValueError("支持 EPUB、TXT 和 Markdown 文件")
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        saved = []
        # No model/network calls inside this atomic transaction. Other API requests remain responsive.
        with ctx.store.transaction():
            book_id = content.add_book(ctx.store, title, author, source)
            for idx, (heading, text, blocks) in enumerate(chapters):
                doc = ctx.engine.ingest(
                    heading, text, ctx.store.get_profile(), analyze=False
                )
                content.put_content(ctx.store, doc["id"], text, blocks)
                content.add_chapter(ctx.store, book_id, idx, heading, doc["id"])
                saved.append(
                    {
                        "title": heading,
                        "doc_id": doc["id"],
                        "word_count": doc["word_count"],
                    }
                )
        if ctx.l1_on and ctx.store.get_profile().l1_enabled:
            for chapter in saved:
                if len(ctx.store.get_document(chapter["doc_id"])["text"]) <= 20000:
                    app.state.jobs.enqueue([chapter["doc_id"]], "annotations")
        return {
            "book_id": book_id,
            "title": title,
            "author": author,
            "source": source,
            "chapters": saved,
            "notice": "已保留章节、标题、段落、列表和代码。图片显示替代文字；本原型不保留原书版式与脚注链接。",
        }

    app.include_router(router)
