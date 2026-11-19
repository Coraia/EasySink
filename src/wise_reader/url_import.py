"""Prepare immutable URL assets without database or publication authority."""
from __future__ import annotations

import hashlib
import io
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin

from . import url_transport as transport
from .url_commit import AssetBytes, FrozenDocument, SourceSnapshot

IMAGE_LIMIT = 5 * 1024 * 1024
PIXEL_LIMIT = 16_000_000
IMAGE_COUNT = 10
MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_NODES = 50_000
MAX_DEPTH = 128

_IMAGE_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}
_VOID_TAGS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "param", "source", "track", "wbr",
})
_DROP_TAGS = frozenset({
    "script", "style", "svg", "math", "iframe", "object", "embed",
    "noscript", "template", "nav", "footer", "aside", "form",
    "button", "input", "select", "textarea", "canvas", "audio", "video",
})
_KEEP_ATTRS = frozenset({
    "href", "src", "alt", "start", "scope", "rowspan",
    "colspan", "datetime", "name", "property", "content",
})
_INLINE_TAGS = frozenset({
    "a", "span", "em", "strong", "b", "i", "u", "s", "del", "ins",
    "code", "kbd", "samp", "var", "mark", "small", "sub", "sup",
    "abbr", "cite", "q", "time", "dfn", "data", "bdi", "bdo",
    "ruby", "rt", "rp", "br", "wbr",
})
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


@dataclass(frozen=True)
class ImageReference:
    url: str
    caption: str


@dataclass(frozen=True)
class PreparedImage:
    ordinal: int
    original_url: str
    final_url: str
    caption: str
    body: bytes
    mime: str
    width: int
    height: int
    sha256: str


@dataclass(frozen=True)
class HTMLPreparation:
    source: SourceSnapshot
    document: FrozenDocument
    assets: tuple[AssetBytes, ...]
    raw_html: bytes


class ImageFailure(transport.ImportFailure):
    def __init__(self, code: str, ordinal: int, caption: str):
        super().__init__(code, f"Image {ordinal} could not be preserved ({code})")
        self.ordinal = ordinal
        self.caption = caption


class _BoundedImageOutput(io.BytesIO):
    def __init__(self, control: transport.Control):
        super().__init__()
        self.control = control

    def write(self, data):
        self.control.remaining()
        if self.tell() + len(data) > IMAGE_LIMIT:
            raise transport.ImportFailure("size_limit")
        self.control.consume(len(data))
        return super().write(data)


def _decode_image(fetched: transport.Fetched, control: transport.Control) -> tuple[bytes, int, int]:
    control.remaining()
    if len(fetched.body) > IMAGE_LIMIT:
        raise transport.ImportFailure("size_limit")
    expected = _IMAGE_FORMATS.get(fetched.mime)
    if expected is None:
        raise transport.ImportFailure("unsupported_image")
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
    except ImportError as exc:
        raise transport.ImportFailure("decoder_unavailable") from exc

    try:
        with Image.open(io.BytesIO(fetched.body), formats=list(_IMAGE_FORMATS.values())) as image:
            if image.format != expected:
                raise transport.ImportFailure("image_format")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > PIXEL_LIMIT:
                raise transport.ImportFailure("image_pixels")
            apng = image.format == "PNG" and "loop" in image.info
            webp_anim = (
                image.format == "WEBP"
                and fetched.body[12:16] == b"VP8X"
                and len(fetched.body) > 20
                and bool(fetched.body[20] & 2)
            )
            if getattr(image, "n_frames", 1) != 1 or getattr(image, "is_animated", False) or apng or webp_anim:
                raise transport.ImportFailure("animated_image")
            image.load()
            control.remaining()
            with ImageOps.exif_transpose(image) as oriented:
                mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
                with oriented.convert(mode) as converted:
                    control.remaining()
                    with Image.frombytes(mode, converted.size, converted.tobytes()) as clean:
                        with _BoundedImageOutput(control) as output:
                            clean.save(output, format="PNG")
                            return output.getvalue(), clean.width, clean.height
    except transport.ImportFailure:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise transport.ImportFailure("image_pixels") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError) as exc:
        raise transport.ImportFailure("image_decode") from exc


def prepare_images(
    references: tuple[ImageReference, ...], final_url: str, control: transport.Control
) -> tuple[PreparedImage, ...]:
    if len(references) > IMAGE_COUNT:
        raise ImageFailure("image_count", IMAGE_COUNT + 1, references[IMAGE_COUNT].caption)
    parent = transport.normalize_url(final_url)
    prepared: list[PreparedImage] = []
    for ordinal, reference in enumerate(references, 1):
        try:
            control.remaining()
            if not reference.url:
                raise transport.ImportFailure("missing_image")
            url = urljoin(parent.url, reference.url)
            fetched = transport.fetch(url, "image", control, secure_parent=parent.secure)
            body, width, height = _decode_image(fetched, control)
            prepared.append(
                PreparedImage(
                    ordinal, url, fetched.final_url, reference.caption,
                    body, "image/png", width, height, hashlib.sha256(body).hexdigest(),
                )
            )
        except transport.ImportFailure as exc:
            raise ImageFailure(exc.code, ordinal, reference.caption) from exc
    control.remaining()
    return tuple(prepared)


@dataclass
class _Node:
    tag: str
    attrs: dict[str, str]
    children: list[_Node | str] = field(default_factory=list)


class _HTMLTree(HTMLParser):
    """Tolerant HTML5 parser that strips non-content/unsafe subtrees."""

    def __init__(self, control: transport.Control):
        super().__init__(convert_charrefs=True)
        self.control = control
        self.root = _Node("root", {})
        self.stack: list[_Node] = [self.root]
        self.skip_stack: list[str] = []
        self.count = 0

    def _tick(self) -> None:
        self.control.remaining()
        self.count += 1
        if self.count > MAX_NODES:
            raise transport.ImportFailure("html_limit")

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if self.skip_stack:
            if tag in _DROP_TAGS and tag not in _VOID_TAGS:
                self.skip_stack.append(tag)
            return
        self._tick()
        if tag in _DROP_TAGS:
            if tag not in _VOID_TAGS:
                self.skip_stack.append(tag)
            return
        if len(self.stack) > MAX_DEPTH:
            raise transport.ImportFailure("html_limit")
        kept = {k.lower(): (v or "") for k, v in attrs if k and k.lower() in _KEEP_ATTRS}
        node = _Node(tag, kept)
        self.stack[-1].children.append(node)
        if tag not in _VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        self.handle_starttag(tag, attrs)
        if not self.skip_stack and tag not in _VOID_TAGS and tag not in _DROP_TAGS and self.stack[-1].tag == tag:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip_stack:
            for i in range(len(self.skip_stack) - 1, -1, -1):
                if self.skip_stack[i] == tag:
                    del self.skip_stack[i:]
                    break
            return
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data: str) -> None:
        if self.skip_stack:
            return
        self._tick()
        if "\x00" in data:
            raise transport.ImportFailure("html_encoding")
        self.stack[-1].children.append(data)


def _html_tree(raw: bytes, control: transport.Control) -> _Node:
    control.remaining()
    if len(raw) > MAX_HTML_BYTES:
        raise transport.ImportFailure("size_limit")
    try:
        text = raw.decode("utf-8-sig", errors="strict")
    except UnicodeError as exc:
        raise transport.ImportFailure("html_encoding") from exc
    if "\x00" in text:
        raise transport.ImportFailure("html_encoding")
    parser = _HTMLTree(control)
    for start in range(0, len(text), 4096):
        parser.feed(text[start : start + 4096])
    parser.close()
    return parser.root


def _nodes(node: _Node, tag: str) -> list[_Node]:
    found: list[_Node] = []
    for child in node.children:
        if isinstance(child, _Node):
            if child.tag == tag:
                found.append(child)
            else:
                found.extend(_nodes(child, tag))
    return found


def _node_text(node: _Node) -> str:
    parts: list[str] = []
    def visit(cur: _Node) -> None:
        for child in cur.children:
            if isinstance(child, str):
                parts.append(child)
            else:
                visit(child)
    visit(node)
    return " ".join("".join(parts).split())


def _has_non_inline(node: _Node) -> bool:
    for child in node.children:
        if isinstance(child, _Node):
            if child.tag not in _INLINE_TAGS or _has_non_inline(child):
                return True
    return False


def _select_article(root: _Node) -> _Node:
    articles = _nodes(root, "article")
    if len(articles) == 1:
        return articles[0]
    mains = _nodes(root, "main")
    if len(articles) > 1:
        if len(mains) == 1:
            inner = _nodes(mains[0], "article")
            if len(inner) == 1:
                return inner[0]
        ranked = sorted(((len(_node_text(a)), a) for a in articles), key=lambda pair: pair[0], reverse=True)
        if ranked[0][0] >= 200 and ranked[0][0] >= 2 * ranked[1][0]:
            return ranked[0][1]
    if len(mains) == 1:
        return mains[0]
    raise transport.ImportFailure("ambiguous_article")


def _extract_metadata(root: _Node, article: _Node) -> dict[str, str | None]:
    author: str | None = None
    published_at: str | None = None
    for meta in _nodes(root, "meta"):
        key = (meta.attrs.get("name") or meta.attrs.get("property") or "").strip().lower()
        val = (meta.attrs.get("content") or "").strip()
        if not val:
            continue
        if key == "author" and author is None:
            author = val
        elif key in ("article:published_time", "og:published_time", "pubdate", "date") and published_at is None:
            published_at = val
    if published_at is None:
        for tm in _nodes(article, "time") or _nodes(root, "time"):
            dt = (tm.attrs.get("datetime") or "").strip()
            if dt:
                published_at = dt
                break
    return {"author": author, "published_at": published_at}


class _HTMLContent:
    def __init__(self, final_url: str, control: transport.Control, image_inputs: tuple[transport.Fetched, ...]):
        self.url = transport.normalize_url(final_url)
        self.control = control
        self.images = image_inputs
        self.blocks: list[dict] = []
        self.assets: list[AssetBytes] = []
        self.length = 0
        self.tables = 0

    def inline(self, children: list[_Node | str], preserve: bool = False) -> tuple[str, list[dict]]:
        chars: list[str] = []
        owners: list[str | None] = []

        def visit(items: list[_Node | str], href: str | None = None) -> None:
            for child in items:
                self.control.remaining()
                if isinstance(child, str):
                    for ch in child:
                        if len(chars) >= 500_000:
                            raise transport.ImportFailure("text_limit")
                        if not preserve and ch in " \t\r\n\f":
                            if not chars or chars[-1] == " ":
                                continue
                            ch = " "
                        chars.append(ch)
                        owners.append(href)
                elif child.tag == "br":
                    chars.append("\n" if preserve else " ")
                    owners.append(None)
                elif child.tag == "wbr":
                    continue
                elif child.tag == "a":
                    link = href
                    raw_href = (child.attrs.get("href") or "").strip()
                    if link is None and raw_href and not raw_href.startswith("#"):
                        try:
                            link = transport.normalize_url(urljoin(self.url.url, raw_href)).url
                        except transport.ImportFailure:
                            link = None
                    visit(child.children, link)
                else:
                    visit(child.children, href)

        visit(children)
        if not preserve:
            while chars and chars[-1] == " ":
                chars.pop()
                owners.pop()
        links: list[dict] = []
        index = 0
        while index < len(owners):
            end = index + 1
            while end < len(owners) and owners[end] == owners[index]:
                end += 1
            if owners[index] is not None:
                links.append({"start": index, "end": end, "href": owners[index]})
            index = end
        return "".join(chars), links

    def add(self, kind: str, text: str, links: list[dict] | tuple = (), **fields) -> None:
        start = self.length + bool(self.blocks)
        end = start + len(text)
        if end > 500_000:
            raise transport.ImportFailure("text_limit")
        block: dict = {"id": f"b{len(self.blocks)}", "type": kind, "text": text, "start": start, "end": end, **fields}
        if links:
            block["links"] = list(links)
        self.blocks.append(block)
        self.length = end

    def _emit_inline(self, nodes: list[_Node | str], kind: str = "paragraph", preserve: bool = False, **fields) -> None:
        text, links = self.inline(nodes, preserve=preserve)
        if text:
            self.add(kind, text, links, **fields)

    def _walk_container(self, children: list[_Node | str]) -> None:
        buf: list[_Node | str] = []
        for child in children:
            if isinstance(child, str) or (child.tag in _INLINE_TAGS and not _has_non_inline(child)):
                buf.append(child)
            else:
                if buf:
                    self._emit_inline(buf, "paragraph")
                    buf.clear()
                self.walk(child)
        if buf:
            self._emit_inline(buf, "paragraph")

    def listing(self, node: _Node, depth: int) -> None:
        raw = node.attrs.get("start", "1")
        ordinal = int(raw) if raw.isascii() and raw.isdigit() and len(raw) <= 6 else 1
        for child in node.children:
            if not isinstance(child, _Node) or child.tag != "li":
                continue
            inline_items: list[_Node | str] = []
            nested: list[_Node] = []
            for item_child in child.children:
                if isinstance(item_child, _Node) and item_child.tag in {"ul", "ol"}:
                    nested.append(item_child)
                else:
                    inline_items.append(item_child)
            text, links = self.inline(inline_items)
            if text:
                self.add("list-item", text, links, depth=depth, ordered=node.tag == "ol", ordinal=ordinal)
                ordinal += 1
            for sub in nested:
                self.listing(sub, depth + 1)

    def table(self, node: _Node) -> None:
        rows: list[_Node] = []
        for child in node.children:
            if not isinstance(child, _Node):
                continue
            if child.tag == "caption":
                self._emit_inline(child.children, "caption")
            elif child.tag == "tr":
                rows.append(child)
            elif child.tag in {"thead", "tbody", "tfoot"}:
                rows.extend(c for c in child.children if isinstance(c, _Node) and c.tag == "tr")
        if not rows:
            return
        parsed_rows: list[list[tuple[str, list[dict], bool, str | None]]] = []
        widths: set[int] = set()
        uniform = True
        for row_index, row in enumerate(rows):
            row_cells: list[tuple[str, list[dict], bool, str | None]] = []
            for col, cell in enumerate(row.children):
                if not isinstance(cell, _Node) or cell.tag not in {"td", "th"}:
                    continue
                if "rowspan" in cell.attrs or "colspan" in cell.attrs:
                    uniform = False
                text, spans = self.inline(cell.children)
                header = cell.tag == "th"
                scope = cell.attrs.get("scope", "col" if row_index == 0 else "row") if header else None
                if scope not in {None, "col", "row"} or (scope == "row" and col != 0) or (scope == "col" and row_index != 0):
                    scope = "col" if row_index == 0 else "row" if col == 0 else None
                    if header and scope is None:
                        uniform = False
                row_cells.append((text, spans, header, scope))
            if row_cells:
                widths.add(len(row_cells))
                parsed_rows.append(row_cells)
        if not parsed_rows:
            return
        if not uniform or len(widths) != 1:
            for row_cells in parsed_rows:
                joined = " ".join(text for text, _, _, _ in row_cells if text).strip()
                if joined:
                    self.add("paragraph", joined)
            return
        table_id = f"t{self.tables}"
        self.tables += 1
        for row_index, row_cells in enumerate(parsed_rows):
            cells, texts, links, pos = [], [], [], 0
            for text, spans, header, scope in row_cells:
                cells.append({"text": text, "start": pos, "end": pos + len(text), "header": header, "scope": scope})
                links.extend({"start": s["start"] + pos, "end": s["end"] + pos, "href": s["href"]} for s in spans)
                texts.append(text)
                pos += len(text) + 1
            self.add("table-row", "\t".join(texts), links, table_id=table_id, row=row_index, cells=cells)

    def image_reference(self, node: _Node, ordinal: int) -> ImageReference | None:
        raw_src = (node.attrs.get("src") or "").strip()
        if not raw_src or raw_src.startswith("data:"):
            return None
        caption = node.attrs.get("alt", "")
        if ordinal > IMAGE_COUNT:
            raise ImageFailure("image_count", ordinal, caption)
        url = transport.normalize_url(urljoin(self.url.url, raw_src))
        if self.url.secure and not url.secure:
            raise ImageFailure("https_downgrade", ordinal, caption)
        return ImageReference(url.url, caption)

    def image(self, node: _Node) -> None:
        ordinal = len(self.assets) + 1
        reference = self.image_reference(node, ordinal)
        if reference is None:
            return
        matches = [img for img in self.images if img.original_url == reference.url]
        if len(matches) != 1:
            raise ImageFailure("missing_image", ordinal, reference.caption)
        img = matches[0]
        if self.url.secure and not transport.normalize_url(img.final_url).secure:
            raise ImageFailure("https_downgrade", ordinal, reference.caption)
        try:
            self.control.consume(len(img.body))
            body, width, height = _decode_image(img, self.control)
        except transport.ImportFailure as exc:
            raise ImageFailure(exc.code, ordinal, reference.caption) from exc
        asset_id = f"image{ordinal}"
        self.assets.append(AssetBytes(asset_id, body, "image/png", width, height))
        self.add("image", "", asset_id=asset_id)

    def walk(self, node: _Node) -> None:
        self.control.remaining()
        tag = node.tag
        if tag in {"meta", "link", "title", "hr", "wbr", "source"}:
            return
        if tag in {"blockquote", "pre", "figcaption"}:
            self._emit_inline(
                node.children,
                {"blockquote": "quote", "pre": "code", "figcaption": "caption"}[tag],
                preserve=(tag == "pre"),
            )
        elif tag in _HEADING_TAGS:
            self._emit_inline(node.children, "heading", level=int(tag[1]))
        elif tag == "p" and not _has_non_inline(node):
            self._emit_inline(node.children, "paragraph")
        elif tag in {"ul", "ol"}:
            self.listing(node, 0)
        elif tag == "table":
            self.table(node)
        elif tag == "img":
            self.image(node)
        else:
            self._walk_container(node.children)


class _HTMLReferences(_HTMLContent):
    def __init__(self, final_url: str, control: transport.Control):
        super().__init__(final_url, control, ())
        self.references: list[ImageReference] = []

    def image(self, node: _Node) -> None:
        ordinal = len(self.references) + 1
        ref = self.image_reference(node, ordinal)
        if ref is None:
            return
        self.references.append(ref)
        self.add("image", "", asset_id=f"image{ordinal}")


def _finish_html(fetched: transport.Fetched, control: transport.Control, prepare_import, root: _Node, selected: _Node, content: _HTMLContent) -> HTMLPreparation:
    h1s = [b["text"] for b in content.blocks if b["type"] == "heading" and b["level"] == 1]
    titles = _nodes(root, "title")
    if h1s:
        title = h1s[0]
    elif titles:
        title = _node_text(titles[0])
    else:
        title = ""
    text = "\n".join(b["text"] for b in content.blocks)
    if not title or not text.strip():
        raise transport.ImportFailure("empty_article")
    control.remaining()
    transport.normalize_url(fetched.original_url)
    prepared = prepare_import(title, text, content.blocks)
    control.remaining()
    assets = tuple(content.assets)
    observation = json.dumps(
        {
            "original_url": fetched.original_url,
            "final_url": content.url.url,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "raw_html_sha256": hashlib.sha256(fetched.body).hexdigest(),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    metadata = json.dumps(_extract_metadata(root, selected), ensure_ascii=False).encode("utf-8")
    source, document = SourceSnapshot.freeze(
        prepared, content.url.url, "strict-html-1", "safe-html-1", metadata, observation, assets
    )
    control.remaining()
    return HTMLPreparation(source, document, assets, fetched.body)


def _select_html(fetched: transport.Fetched, control: transport.Control) -> tuple[_Node, _Node]:
    control.remaining()
    if fetched.mime not in ("text/html", "application/xhtml+xml"):
        raise transport.ImportFailure("unsupported_html")
    root = _html_tree(fetched.body, control)
    return root, _select_article(root)


def prepare_html(
    fetched: transport.Fetched,
    control: transport.Control,
    prepare_import,
    *,
    image_inputs: tuple[transport.Fetched, ...] = (),
) -> HTMLPreparation:
    control.remaining()
    if len(image_inputs) > IMAGE_COUNT:
        raise transport.ImportFailure("image_count")
    root, selected = _select_html(fetched, control)
    control.consume(len(fetched.body))
    content = _HTMLContent(fetched.final_url, control, image_inputs)
    content.walk(selected)
    return _finish_html(fetched, control, prepare_import, root, selected, content)


class URLPreparer:
    """Synchronous preparation for ExecutionOwner; no Store or publication rights."""

    def __init__(self, prepare_import):
        self._prepare_import = prepare_import

    def prepare(self, url: str, control: transport.Control) -> HTMLPreparation:
        control.remaining()
        fetched = transport.fetch(url, "html", control, same_host_redirects=True)
        root, selected = _select_html(fetched, control)
        content = _HTMLReferences(fetched.final_url, control)
        content.walk(selected)
        images = prepare_images(tuple(content.references), fetched.final_url, control)
        content.assets = [AssetBytes(f"image{img.ordinal}", img.body, img.mime, img.width, img.height) for img in images]
        control.remaining()
        return _finish_html(fetched, control, self._prepare_import, root, selected, content)
