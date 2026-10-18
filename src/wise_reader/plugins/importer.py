"""Bounded EPUB extraction with explicit errors and transactional import."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import posixpath
import zipfile
from uuid import UUID
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from markdown_it import MarkdownIt

from wise_reader import content
from wise_reader.plugins.runtime import PluginContext, require_plugin

PLUGIN_ID = "importer"
MAX_BYTES = 20 * 1024 * 1024
MAX_CHAPTERS = 500
MAX_EXPANDED = 100 * 1024 * 1024
EPUB_CONTAINER = "META-INF/container.xml"


def start_url_import(app: FastAPI, store):
    from wise_reader.url_commit import URLCommitter
    from wise_reader.url_transport import ImportFailure

    app.state.url_committer = None
    app.state.url_import_error = None
    try:
        committer = URLCommitter(store)
    except Exception as exc:
        app.state.url_import_error = exc.code if isinstance(exc, ImportFailure) else "initialization_failed"
        logging.getLogger(__name__).exception("URL import unavailable; existing reading remains available")
    else:
        app.state.url_committer = committer
        if not committer.recovery_ready:
            app.state.url_import_error = "recovery_incomplete"


def migrate(store):
    store.executescript("""
    CREATE TABLE IF NOT EXISTS wr_import_source(
      fingerprint TEXT PRIMARY KEY, book_id INTEGER NOT NULL, chapter_count INTEGER NOT NULL);
    """)


def epub_fingerprint(data):
    """Ignore transport wrappers and ZIP timestamps, not publication contents.

    Call only after parse_epub_structured has validated the extraction bounds.
    Old books without this identity are deliberately not merged by title/text.
    """
    digest = hashlib.sha256(b"epub-package-v1\0")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        root = _epub_root(archive)
        entries = []
        for info in archive.infolist():
            if info.is_dir() or not info.filename.startswith(root):
                continue
            name = info.filename[len(root):]
            parts = name.split("/")
            if any(p == "__MACOSX" or p == ".DS_Store" or p.startswith("._") for p in parts):
                continue
            entries.append((name, info))
        names = [name for name, _ in entries]
        if len(names) != len(set(names)):
            raise ValueError("EPUB 包含重复资源路径，尚未导入")
        for name, info in sorted(entries, key=lambda item: item[0]):
            payload = archive.read(info)
            digest.update(json.dumps([name, len(payload)], ensure_ascii=False).encode())
            digest.update(b"\0")
            digest.update(payload)
    return digest.hexdigest()


def existing_import(store, fingerprint):
    row = store.query_one(
        "SELECT b.*, s.chapter_count FROM wr_import_source s"
        " JOIN wr_book b ON b.id=s.book_id WHERE s.fingerprint=?", (fingerprint,))
    if not row:
        return None
    chapters = store.query(
        "SELECT c.title, c.doc_id, d.word_count FROM wr_chapter c"
        " JOIN document d ON d.id=c.doc_id WHERE c.book_id=? ORDER BY c.idx", (row["id"],))
    if len(chapters) != row["chapter_count"]:
        return None
    resume = store.query_one(
        "SELECT p.doc_id FROM wr_progress p JOIN wr_chapter c ON c.doc_id=p.doc_id"
        " WHERE c.book_id=? ORDER BY p.updated_at DESC LIMIT 1", (row["id"],))
    return {"book_id": row["id"], "title": row["title"], "author": row["author"],
            "source": row["source"], "chapters": chapters, "reused": True,
            "reading_doc_id": resume["doc_id"] if resume else chapters[0]["doc_id"],
            "notice": "已保留已有章节和阅读记录。"}


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


def _url_request_id(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError
    except (ValueError, AttributeError):
        raise HTTPException(422, "request_id must be a canonical UUID") from None
    return value


def _url_origin(request: Request, *, write: bool):
    hosts = request.headers.getlist('host')
    server = request.scope.get('server')
    scheme = request.scope.get('scheme')
    if len(hosts) != 1 or not server or scheme not in ('http', 'https'):
        raise HTTPException(403, "URL import requires a trusted local authority")
    host = hosts[0]
    server_host, port = server
    allowed = {server_host.lower()}
    if server_host in ('127.0.0.1', '::1'):
        allowed.add('localhost')
    authorities = set()
    for name in allowed:
        name = f'[{name}]' if ':' in name else name
        authorities.add(f'{name}:{port}')
        if port == (443 if scheme == 'https' else 80):
            authorities.add(name)
    if host.lower() not in authorities:
        raise HTTPException(403, "Host does not match this server")
    origins = request.headers.getlist('origin')
    if (write or origins) and origins != [f'{scheme}://{host}']:
        raise HTTPException(403, "A same-origin request is required")
    sites = request.headers.getlist('sec-fetch-site')
    if sites and sites not in (['same-origin'], ['none']):
        raise HTTPException(403, "Cross-site request rejected")


async def _url_json(request: Request):
    _url_origin(request, write=True)
    types = request.headers.getlist('content-type')
    if len(types) != 1 or types[0].lower().strip() not in (
            'application/json', 'application/json; charset=utf-8'):
        raise HTTPException(415, "application/json required")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > 16384:
            raise HTTPException(413, "URL request exceeds 16 KiB")
        data.extend(chunk)

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate key')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('invalid JSON constant')

    try:
        body = json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid_constant)
        if not isinstance(body, dict):
            raise ValueError('object required')
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(422, "Invalid JSON object") from None
    return body


def _url_expected_library(request: Request):
    values = request.headers.getlist('x-wr-library-id')
    if not values:
        raise HTTPException(428, 'X-WR-Library-ID required; retrieve URL identity first')
    if len(values) != 1:
        raise HTTPException(422, 'Exactly one library identity required')
    return _url_request_id(values[0])


def _url_response(receipt, store, library_id=None):
    state = receipt.state
    value = {'request_id': receipt.request_id, 'state': state, 'library_id': library_id}
    codes = {'committed': 200, 'running': 202, 'cancelled': 200, 'failed': 422,
             'interrupted': 422, 'not_found': 404, 'unknown': 503,
             'unavailable': 409, 'source_removed': 410}
    if state == 'committed':
        try:
            source = store.query_one(
                'SELECT o.original_url,o.final_url,o.fetched_at,s.metadata_json '
                'FROM wr_url_observation o JOIN wr_url_snapshot s ON s.snapshot_id=o.snapshot_id '
                'WHERE o.request_id=? AND s.snapshot_id=? AND s.doc_id=? AND s.availability=\'ready\'',
                (receipt.request_id, receipt.snapshot_id, receipt.doc_id))
            if source is None:
                raise ValueError('source unavailable')
            metadata = json.loads(source.pop('metadata_json'))
            source.update(author=metadata['author'], published_at=metadata['published_at'])
        except Exception:
            value.update(state='unknown', code='source_read_failed', message='保存结果待核对，请保留请求编号。',
                         stage='status', retryable=False)
            return JSONResponse(value, status_code=503, headers={'Cache-Control': 'no-store'})
        value.update(doc_id=receipt.doc_id, snapshot_id=receipt.snapshot_id, reused=receipt.reused,
                     source=source, notice='已保留已有文章和阅读记录。' if receipt.reused else '已独立保存；旧文章和记录保留。')
    elif state != 'running':
        messages = {
            'redirect_host_changed': '页面跳转到了另一个网站；请粘贴最终地址并重新确认。',
            'unsupported_html': '该地址没有返回可读取的 HTML 文章。',
            'ambiguous_article': '该页面没有可明确识别的单篇正文。',
            'empty_article': '该页面没有可读取的正文。',
            'unsupported_content': '该地址返回的内容类型暂不支持。',
        }
        value.update(code=receipt.error_code or state, stage='status', retryable=state in ('failed', 'interrupted'),
                     message=('结果待核对，请保留请求编号。' if state == 'unknown' else
                              messages.get(receipt.error_code, '导入失败；未保存可阅读文章。')))
    return JSONResponse(value, status_code=codes.get(state, 503), headers={'Cache-Control': 'no-store'})


def _register_url_routes(app: FastAPI, ctx: PluginContext):
    from wise_reader.url_commit import Execution, Receipt
    from wise_reader.url_import import URLPreparer
    from wise_reader.url_sources import source_policy
    from wise_reader.url_transport import Control, ImportFailure, normalize_url

    def current_owner():
        owner = getattr(app.state, 'url_committer', None)
        if owner is None or owner.store is not ctx.store:
            raise ImportFailure('url_unavailable')
        return owner, owner.identity()

    @app.get('/api/import/url/identity')
    def url_identity(request: Request):
        _url_origin(request, write=False)
        try:
            _, library_id = current_owner()
        except Exception:
            return JSONResponse({'code': 'library_identity_unavailable'}, status_code=503,
                                headers={'Cache-Control': 'no-store'})
        return JSONResponse({'library_id': library_id}, headers={'Cache-Control': 'no-store'})

    def invoke(request_id, action, expected_library, url: str = '', user_approved: bool = False):
        try:
            owner, library_id = current_owner()
        except Exception:
            return _url_response(Receipt(request_id, 'unknown', error_code='url_unavailable'), ctx.store)
        if library_id != expected_library:
            return JSONResponse({'code': 'library_mismatch', 'request_id': request_id,
                                 'library_id': library_id}, status_code=409,
                                headers={'Cache-Control': 'no-store'})
        try:
            if action == 'submit':
                if not ctx.store.is_plugin_enabled(PLUGIN_ID):
                    raise HTTPException(404, 'plugin importer is off')
                if not source_policy(url)['builtin'] and not user_approved:
                    raise HTTPException(403, 'This website requires explicit user approval')
                control = Control()
                begun = owner.begin(request_id, url, control)
                if begun.attempt is None:
                    receipt = begun.receipt
                else:
                    def work():
                        prepared = URLPreparer(ctx.engine.prepare_import).prepare(url, control)
                        sealed = owner.staging.prepare(prepared.source, prepared.document, prepared.assets,
                                                       prepared.raw_html, control)
                        return owner.commit(begun.attempt, sealed, ctx.engine)
                    receipt = owner.execute(begun.attempt, Execution(control, work))
            elif action == 'cancel':
                receipt = owner.cancel(request_id)
            else:
                receipt = owner.status(request_id)
        except ImportFailure as exc:
            if exc.code in ('request_conflict', 'busy'):
                return JSONResponse({'request_id': request_id, 'library_id': library_id, 'code': exc.code}, status_code=409,
                                    headers={'Cache-Control': 'no-store'})
            # A start race or an I/O failure cannot authorize a replacement request.
            try:
                receipt = owner.status(request_id)
            except Exception:
                receipt = Receipt(request_id, 'unknown', error_code=exc.code)
            if receipt.state in ('not_found', 'running'):
                receipt = Receipt(request_id, 'unknown', error_code=exc.code)
        except HTTPException:
            raise
        except Exception:
            logging.getLogger(__name__).exception('URL request requires reconciliation')
            receipt = Receipt(request_id, 'unknown', error_code='request_unconfirmed')
        return _url_response(receipt, owner.store, library_id)

    @app.post('/api/import/url', dependencies=[Depends(require_plugin(PLUGIN_ID))])
    async def submit_url(request: Request):
        body = await _url_json(request)
        if (set(body) not in ({'request_id', 'url'}, {'request_id', 'url', 'user_approved'})
                or not isinstance(body['url'], str) or not 1 <= len(body['url']) <= 4096
                or not isinstance(body.get('user_approved', False), bool)):
            raise HTTPException(422, 'Expected request_id, bounded url, and optional user approval')
        request_id = _url_request_id(body['request_id'])
        try:
            normalize_url(body['url'])
        except ImportFailure as exc:
            raise HTTPException(422, exc.code) from None
        return await run_in_threadpool(
            invoke, request_id, 'submit', _url_expected_library(request),
            body['url'], body.get('user_approved', False))

    @app.post('/api/import/url/policy', dependencies=[Depends(require_plugin(PLUGIN_ID))])
    async def url_policy(request: Request):
        body = await _url_json(request)
        if set(body) != {'url'} or not isinstance(body['url'], str) or not 1 <= len(body['url']) <= 4096:
            raise HTTPException(422, 'Expected one bounded url')
        try:
            value = source_policy(body['url'])
        except ImportFailure as exc:
            raise HTTPException(422, exc.code) from None
        return JSONResponse(value, headers={'Cache-Control': 'no-store'})

    @app.get('/api/import/url/requests/{request_id}')
    async def url_status(request: Request, request_id: str):
        _url_origin(request, write=False)
        return await run_in_threadpool(invoke, _url_request_id(request_id), 'status', _url_expected_library(request))

    @app.get('/api/import/url/snapshots/{snapshot_id}/assets/{asset_id}')
    def url_asset(request: Request, snapshot_id: str, asset_id: str):
        _url_origin(request, write=False)
        headers = {'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}
        owner = getattr(app.state, 'url_committer', None)
        code = 'unknown'
        if owner is not None:
            try:
                asset = owner.read_asset(snapshot_id, asset_id)
                return Response(content=asset.data, media_type=asset.mime, headers=headers)
            except ImportFailure as exc:
                if exc.code in ('invalid_snapshot_id', 'invalid_asset_id', 'not_found', 'unavailable'):
                    code = exc.code
            except Exception:
                logging.getLogger(__name__).exception('URL asset read could not be confirmed')
        status = {'invalid_snapshot_id': 422, 'invalid_asset_id': 422,
                  'not_found': 404, 'unavailable': 409, 'unknown': 503}[code]
        return JSONResponse({'code': code, 'message': '图片不可用或读取结果待核对。'},
                            status_code=status, headers=headers)

    @app.post('/api/import/url/requests/{request_id}/cancel')
    async def cancel_url(request: Request, request_id: str):
        if await _url_json(request) != {}:
            raise HTTPException(422, 'Cancel expects an empty JSON object')
        return await run_in_threadpool(invoke, _url_request_id(request_id), 'cancel', _url_expected_library(request))


def register(app: FastAPI, ctx: PluginContext):
    _register_url_routes(app, ctx)
    router = APIRouter(dependencies=[Depends(require_plugin(PLUGIN_ID))])

    @router.post("/api/import")
    def import_file(file: UploadFile = File(...)):
        data = file.file.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "文件超过 20 MB")
        name = (file.filename or "upload.txt").strip()
        fingerprint = None
        try:
            if is_epub_upload(data, name, file.content_type):
                title, author, chapters = parse_epub_structured(data)
                source = "epub"
                fingerprint = epub_fingerprint(data)
                existing = existing_import(ctx.store, fingerprint)
                if existing:
                    return existing
            elif name.lower().endswith((".md", ".markdown")):
                title, author, plain = parse_plain(data, name)
                # CommonMark + tables; raw HTML is text, never active markup.
                parser = MarkdownIt("commonmark", {"html": False}).enable("table")
                blocks = content.html_blocks(parser.render(plain[0][1]))
                if not blocks:
                    raise ValueError("文件没有可读取的文字")
                text = "\n\n".join(b["text"] for b in blocks)
                source = "markdown"
                chapters = [(title, text, blocks)]
            elif name.lower().endswith(".txt"):
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
        except (zipfile.BadZipFile, RuntimeError, OSError) as e:
            raise HTTPException(400, "EPUB 资源损坏或无法读取，尚未导入") from e
        # Parsing, lexical analysis, cache compression and JSON serialization
        # happen in this sync endpoint's worker, before taking the Store lock.
        prepared = [ctx.engine.prepare_import(heading, text, blocks)
                    for heading, text, blocks in chapters]
        saved = []
        # Only writes enter the book-wide atomic transaction.
        with ctx.store.transaction():
            if fingerprint:
                # Two uploads may parse concurrently; serialize identity and all
                # chapter writes together so only one complete book is created.
                existing = existing_import(ctx.store, fingerprint)
                if existing:
                    return existing
                ctx.store.execute("DELETE FROM wr_import_source WHERE fingerprint=?", (fingerprint,))
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
            if fingerprint:
                ctx.store.execute("INSERT INTO wr_import_source VALUES(?,?,?)",
                                  (fingerprint, book_id, len(saved)))

        return {
            "book_id": book_id,
            "title": title,
            "author": author,
            "source": source,
            "reused": False,
            "chapters": saved,
            "notice": "已保留章节、标题、段落、列表和代码。图片显示替代文字；本原型不保留原书版式与脚注链接。",
        }

    app.include_router(router)
