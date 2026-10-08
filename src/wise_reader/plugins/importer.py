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
EPUB_CONTAINER = "META-INF/container.xml"


def _epub_roots(archive):
    """Mac packages may be zipped beneath one or more wrapper directories."""
    return sorted(
        {
            name[: -len(EPUB_CONTAINER)]
            for name in archive.namelist()
            if (name == EPUB_CONTAINER or name.endswith("/" + EPUB_CONTAINER))
            and not name.startswith("__MACOSX/")
        }
    )


def _epub_root(archive):
    roots = _epub_roots(archive)
    if not roots:
        raise ValueError("EPUB 缺少容器清单 META-INF/container.xml，尚未导入")
    if len(roots) != 1:
        raise ValueError("压缩包中包含多本 EPUB，请每次选择一本书（尚未导入）")
    root = roots[0]
    if root.startswith("/") or ".." in root.split("/") or "\\" in root:
        raise ValueError("EPUB 路径越界")
    return root


def is_epub_upload(data, filename, content_type):
    """A transport name is not authoritative; EPUB's container identifies it."""
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if (
        filename.lower().endswith((".epub", ".epub.zip"))
        or mime == "application/epub+zip"
    ):
        return True
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            # Detection only: the parser still enforces bounds and validates the
            # container, package and every chapter before anything is persisted.
            return bool(_epub_roots(archive))
    except (zipfile.BadZipFile, KeyError, OSError):
        return False


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
    if data.startswith(b"__CLOUDSYNC_ENC__"):
        raise ValueError(
            "这是群晖 Cloud Sync 加密的文件，暂不能直接读取。"
            "请从 NAS 获取未加密的 EPUB 原文件，或先解密后再导入（尚未导入）。"
        )
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()
            if len(infos) > 5000 or sum(i.file_size for i in infos) > MAX_EXPANDED:
                raise ValueError("EPUB 解压后超过 100 MB 或文件数超过 5000")
            if any(i.file_size > 8 * 1024 * 1024 for i in infos):
                raise ValueError("EPUB 单个资源超过 8 MB")
            root = _epub_root(z)
            encryption_path = root + "META-INF/encryption.xml"
            if encryption_path in z.namelist():
                # Font obfuscation can coexist with readable chapters; encrypted text cannot.
                enc = z.read(encryption_path).decode("utf-8")
                if "xmlenc#aes" in enc:
                    raise ValueError("不支持加密的 EPUB 内容")
            container = ET.fromstring(z.read(root + EPUB_CONTAINER))
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
            opf = ET.fromstring(z.read(root + _resolve("", opf_path)))
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
                raw = z.read(root + path).decode("utf-8-sig")
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
        name = (file.filename or "upload.txt").strip()
        try:
            if is_epub_upload(data, name, file.content_type):
                title, author, chapters = parse_epub_structured(data)
                source = "epub"
            elif name.lower().endswith((".txt", ".md", ".markdown")):
                title, author, plain = parse_plain(data, name)
                source = "txt"
                chapters = [(t, s, content.blocks_from_text(s)) for t, s in plain]
            else:
                display_name = posixpath.basename(name.replace("\\", "/"))[:120]
                raise ValueError(
                    "支持 EPUB、TXT 和 Markdown 文件"
                    f"（收到的文件名：{display_name}）。"
                    "支持完整 EPUB 文件包的 ZIP，不支持只上传书籍中的单个资源。"
                )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        # Parsing, lexical analysis, cache compression and JSON serialization
        # happen in this sync endpoint's worker, before taking the Store lock.
        prepared = [ctx.engine.prepare_import(heading, text, blocks)
                    for heading, text, blocks in chapters]
        saved = []
        # Only writes enter the book-wide atomic transaction.
        with ctx.store.transaction():
            book_id = content.add_book(ctx.store, title, author, source)
            for idx, entry in enumerate(prepared):
                doc = ctx.engine.persist_import(entry)
                heading = doc["title"]
                content.add_chapter(ctx.store, book_id, idx, heading, doc["id"])
                saved.append(
                    {
                        "title": heading,
                        "doc_id": doc["id"],
                        "word_count": doc["word_count"],
                    }
                )

        return {
            "book_id": book_id,
            "title": title,
            "author": author,
            "source": source,
            "chapters": saved,
            "notice": "已保留章节、标题、段落、列表和代码。图片显示替代文字；本原型不保留原书版式与脚注链接。",
        }

    app.include_router(router)
