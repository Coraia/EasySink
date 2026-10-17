"""Prepare immutable URL assets without database or publication authority."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
import hashlib
import io
import json
import re

from .url_commit import SourceSnapshot, FrozenDocument, AssetBytes
from urllib.parse import urljoin

from . import url_transport as transport

IMAGE_LIMIT = 5 * 1024 * 1024
PIXEL_LIMIT = 16_000_000
IMAGE_COUNT = 10
_IMAGE_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


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


def _decode_image(fetched: transport.Fetched, control: transport.Control):
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

    def check(image):
        control.remaining()
        if image.format != expected:
            raise transport.ImportFailure("image_format")
        width, height = image.size
        if width <= 0 or height <= 0 or width * height > PIXEL_LIMIT:
            raise transport.ImportFailure("image_pixels")
        apng = image.format == "PNG" and "loop" in image.info
        webp_animation = (image.format == "WEBP" and fetched.body[12:16] == b"VP8X"
                          and len(fetched.body) > 20 and fetched.body[20] & 2)
        if (getattr(image, "n_frames", 1) != 1 or getattr(image, "is_animated", False)
                or apng or webp_animation):
            raise transport.ImportFailure("animated_image")

    try:
        # verify checks the PNG stream including CRCs; load alone can accept a
        # truncated container. Reopen because verify invalidates the decoder.
        with Image.open(io.BytesIO(fetched.body), formats=list(_IMAGE_FORMATS.values())) as image:
            check(image)
            image.verify()
        control.remaining()
        with Image.open(io.BytesIO(fetched.body), formats=list(_IMAGE_FORMATS.values())) as image:
            check(image)
            image.load()
            control.remaining()
            with ImageOps.exif_transpose(image) as oriented:
                mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
                with oriented.convert(mode) as converted:
                    control.remaining()
                    # A fresh image prevents EXIF, ICC, text and encoder state
                    # from propagating into the retained, executable-free asset.
                    with Image.frombytes(mode, converted.size, converted.tobytes()) as clean:
                        with _BoundedImageOutput(control) as output:
                            clean.save(output, format="PNG")
                            control.remaining()
                            return output.getvalue(), clean.width, clean.height
    except transport.ImportFailure:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise transport.ImportFailure("image_pixels") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError) as exc:
        raise transport.ImportFailure("image_decode") from exc


def prepare_images(references: tuple[ImageReference, ...], final_url: str,
                   control: transport.Control) -> tuple[PreparedImage, ...]:
    """All necessary images or an explicit failure; never a partial result.

    Run on the library ExecutionOwner thread. Cancellation can invalidate a
    decode but cannot kill a native decoder; its execution slot stays occupied
    until this function actually exits. The transport accounts downloaded bytes;
    encoded bytes are additionally charged conservatively to the same budget.
    """
    if len(references) > IMAGE_COUNT:
        raise ImageFailure("image_count", IMAGE_COUNT + 1, references[IMAGE_COUNT].caption)
    parent = transport.normalize_url(final_url)
    prepared = []
    for ordinal, reference in enumerate(references, 1):
        try:
            control.remaining()
            if not reference.url:
                raise transport.ImportFailure("missing_image")
            url = urljoin(parent.url, reference.url)
            fetched = transport.fetch(url, "image", control, secure_parent=parent.secure)
            body, width, height = _decode_image(fetched, control)
            control.remaining()
            prepared.append(PreparedImage(
                ordinal, url, fetched.final_url, reference.caption, body,
                "image/png", width, height, hashlib.sha256(body).hexdigest(),
            ))
        except transport.ImportFailure as exc:
            raise ImageFailure(exc.code, ordinal, reference.caption) from exc
    control.remaining()
    return tuple(prepared)


@dataclass(frozen=True)
class HTMLPreparation:
    source: SourceSnapshot
    document: FrozenDocument
    assets: tuple[AssetBytes, ...]
    raw_html: bytes


@dataclass
class _Node:
    tag: str
    attrs: dict[str, str]
    children: list[_Node | str] = field(default_factory=list)


class _HTMLTree(HTMLParser):
    # Strict balanced subset rather than browser error recovery, which could
    # silently relocate a chart or turn malformed markup into different text.
    def __init__(self, control, *, template=False):
        super().__init__(convert_charrefs=True)
        self.control = control
        self.template = template
        self.root = _Node('root', {})
        self.stack = [self.root]
        self.count = 0

    def _tick(self):
        self.control.remaining()
        self.count += 1
        if self.count > 20000:
            raise transport.ImportFailure('html_limit')

    def handle_starttag(self, tag, attrs):
        self._tick()
        if len(self.stack) > 64 or len(attrs) > 32:
            raise transport.ImportFailure('html_limit')
        values = {}
        for key, value in attrs:
            value = value or ''
            if len(key) > 128 or len(value) > 2048:
                raise transport.ImportFailure('html_limit')
            if key in values:
                raise transport.ImportFailure('malformed_html')
            if not self.template and (key.startswith('on') or key in {'style', 'srcdoc', 'hidden'}):
                raise transport.ImportFailure('unsafe_html')
            values[key] = value
        if not self.template and tag in {'script', 'style', 'svg', 'math', 'iframe', 'object', 'embed',
                   'form', 'input', 'button', 'video', 'audio', 'canvas', 'picture',
                   'source', 'base', 'template', 'noscript'}:
            raise transport.ImportFailure('unsafe_html')
        if not self.template and tag == 'link' and 'stylesheet' in values.get('rel', '').lower().split():
            raise transport.ImportFailure('unsafe_html')
        if tag == 'meta':
            if 'http-equiv' in values or values.get('charset', 'utf-8').lower() not in {'utf-8', 'utf8'}:
                raise transport.ImportFailure('html_encoding')
        node = _Node(tag, values)
        self.stack[-1].children.append(node)
        if tag not in {'img', 'br', 'meta', 'link', 'hr'}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in {'img', 'br', 'meta', 'link', 'hr'}:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        self.control.remaining()
        if len(self.stack) == 1 or self.stack[-1].tag != tag:
            raise transport.ImportFailure('malformed_html')
        self.stack.pop()

    def handle_data(self, data):
        self._tick()
        if '\x00' in data or '\ufffd' in data:
            raise transport.ImportFailure('html_encoding')
        self.stack[-1].children.append(data)

    def handle_decl(self, decl):
        if decl.lower() != 'doctype html':
            raise transport.ImportFailure('unsafe_html')

    def unknown_decl(self, data):
        raise transport.ImportFailure('unsafe_html')

    def handle_pi(self, data):
        raise transport.ImportFailure('unsafe_html')


def _html_tree(raw, control, *, template=False):
    control.remaining()
    if type(raw) is not bytes or len(raw) > 5 * 1024 * 1024:
        raise transport.ImportFailure('size_limit')
    try:
        text = raw.decode('utf-8-sig', errors='strict')
    except UnicodeError as exc:
        raise transport.ImportFailure('html_encoding') from exc
    # Bound a token before HTMLParser allocates its attribute list. Quotes are
    # tracked so a greater-than sign inside an attribute cannot reset the cap.
    tag_start, quote = None, None
    for i, ch in enumerate(text):
        if i % 4096 == 0:
            control.remaining()
        if tag_start is None:
            if ch == '<':
                tag_start = i
        else:
            if i - tag_start > 8192:
                raise transport.ImportFailure('html_limit')
            if quote:
                if ch == quote:
                    quote = None
            elif ch in {'"', "'"}:
                quote = ch
            elif ch == '>':
                tag_start = None
    if tag_start is not None:
        raise transport.ImportFailure('malformed_html')
    parser = _HTMLTree(control, template=template)
    for start in range(0, len(text), 4096):
        parser.feed(text[start:start + 4096])
    parser.close()
    if len(parser.stack) != 1:
        raise transport.ImportFailure('malformed_html')
    return parser.root


def _nodes(node, tag):
    found = []
    for child in node.children:
        if isinstance(child, _Node):
            if child.tag == tag:
                found.append(child)
            else:
                found.extend(_nodes(child, tag))
    return found


def _template_classes(node):
    return frozenset(re.sub(r'([A-Za-z]+-module-scss-module)__[A-Za-z0-9_-]+?__',
                            r'\1__', value) for value in node.attrs.get('class', '').split())


def _template_node(node, tag, classes='', attributes=()):
    expected = frozenset(classes.split())
    if (node.tag != tag or _template_classes(node) != expected
            or set(node.attrs) - ({'class'} | set(attributes))):
        raise transport.ImportFailure('unsupported_template')
    return node


def _template_children(node):
    children = []
    for child in node.children:
        if isinstance(child, str):
            if child.strip():
                raise transport.ImportFailure('unsupported_template')
        else:
            children.append(child)
    return children


def _template_sequence(node, specs):
    children = _template_children(node)
    if len(children) != len(specs):
        raise transport.ImportFailure('unsupported_template')
    for child, spec in zip(children, specs):
        _template_node(child, *spec)
    return children


def _template_text(node):
    if not node.children or any(not isinstance(c, str) for c in node.children):
        raise transport.ImportFailure('unsupported_template')
    if not ''.join(node.children).strip():
        raise transport.ImportFailure('unsupported_template')


def _template_icon(node, size, viewbox):
    _template_node(node, 'svg', 'Icon-module-scss-module__icon', ('width', 'height', 'viewbox'))
    if (node.attrs.get('width'), node.attrs.get('height'), node.attrs.get('viewbox')) != (size, size, viewbox):
        raise transport.ImportFailure('unsupported_template')
    path, = _template_sequence(node, [('path', '', ('d', 'fill'))])
    if (path.children or not re.fullmatch(r'[MmLlHhVvCcSsQqTtAaZz0-9., +\-]+', path.attrs.get('d', ''))
            or path.attrs.get('fill') not in {'#191919', '#141413', 'currentColor'}):
        raise transport.ImportFailure('unsupported_template')


def _template_image(node, *, hero=False):
    _template_node(node, 'img', 'PostDetail-module-scss-module__heroImage' if hero else '',
                   ('alt', 'width', 'height', 'decoding', 'data-nimg', 'style', 'src', 'srcset', 'loading'))
    if (node.children or node.attrs.get('style') != 'color:transparent'
            or node.attrs.get('decoding') != 'async' or node.attrs.get('data-nimg') != '1'
            or node.attrs.get('loading') not in {None, 'lazy'}):
        raise transport.ImportFailure('unsupported_template')
    for key in ('width', 'height'):
        value = node.attrs.get(key, '')
        if not value.isascii() or not value.isdigit() or not 0 < int(value) <= PIXEL_LIMIT:
            raise transport.ImportFailure('unsupported_template')
    # Responsive candidates must be the same source image, not art direction.
    from urllib.parse import urlsplit, parse_qs
    def identity(src):
        parts = urlsplit(src)
        query = parse_qs(parts.query, strict_parsing=True)
        if (parts.scheme or parts.netloc or parts.path != '/_next/image' or parts.fragment
                or set(query) != {'url', 'w', 'q'} or any(len(v) != 1 for v in query.values())
                or query['q'] != ['75'] or not query['w'][0].isdigit()):
            raise transport.ImportFailure('unsupported_template')
        image = transport.normalize_url(query['url'][0]).url
        if not image.startswith('https://www-cdn.anthropic.com/images/'):
            raise transport.ImportFailure('unsupported_template')
        return image
    try:
        src = node.attrs['src']
        original = identity(src)
        variants = [s.strip().rsplit(' ', 1) for s in node.attrs['srcset'].split(',')]
        if (len(variants) != 2 or [v[1] for v in variants] != ['1x', '2x']
                or any(identity(v[0]) != original for v in variants) or variants[1][0] != src):
            raise transport.ImportFailure('unsupported_template')
    except (KeyError, ValueError, IndexError) as exc:
        raise transport.ImportFailure('unsupported_template') from exc
    return _Node('img', {'src': src, 'alt': node.attrs.get('alt', '')})


def _template_inline(node):
    clean = []
    for child in node.children:
        if isinstance(child, str):
            clean.append(child)
        else:
            if child.tag not in {'a', 'em', 'strong'}:
                raise transport.ImportFailure('unsupported_template')
            _template_node(child, child.tag, '', ('href',) if child.tag == 'a' else ())
            attrs = {}
            if child.tag == 'a':
                href = child.attrs.get('href', '')
                transport.normalize_url(urljoin('https://www.anthropic.com/', href))
                attrs['href'] = href
            clean.append(_Node(child.tag, attrs, _template_inline(child)))
    return clean


def _anthropic_selection(raw, final_url, control):
    """PostDetail-v1 is a closed template policy, not a generic article heuristic."""
    url = transport.normalize_url(final_url).url
    if not url.startswith('https://www.anthropic.com/'):
        raise transport.ImportFailure('unsupported_template')
    root = _html_tree(raw, control, template=True)
    articles = _nodes(root, 'article')
    if len(articles) != 1:
        raise transport.ImportFailure('ambiguous_article')
    outer = _template_node(articles[0], 'article')
    mains = _nodes(root, 'main')
    if len(mains) != 1:
        raise transport.ImportFailure('unsupported_template')
    main = _template_node(mains[0], 'main', '', ('id',))
    members = _template_children(main)
    if main.attrs.get('id') != 'main-content' or len(members) != 1 or members[0] is not outer:
        raise transport.ImportFailure('unsupported_template')
    branches = _template_children(outer)
    classified = {}
    roles = {
        frozenset({'page-wrapper', 'PostDetail-module-scss-module__hero'}): 'hero',
        frozenset({'page-wrapper'}): 'body',
        frozenset({'page-wrapper', 'PostDetail-module-scss-module__postFooter'}): 'share',
        frozenset({'LandingPageSection-module-scss-module__root'}): 'related',
    }
    for branch in branches:
        role = roles.get(_template_classes(branch))
        if role is None or role in classified:
            raise transport.ImportFailure('unsupported_template')
        classified[role] = branch
    if set(classified) != {'hero', 'body', 'share', 'related'}:
        raise transport.ImportFailure('unsupported_template')
    hero = _template_node(classified['hero'], 'div', 'page-wrapper PostDetail-module-scss-module__hero')
    header, illustration = _template_sequence(hero, [
        ('div', 'PostDetail-module-scss-module__header'),
        ('div', 'PostDetail-module-scss-module__illustrationHeroWrapper')])
    subjects, title, date = _template_sequence(header, [
        ('div', 'PostDetail-module-scss-module__subjects body-3 bold'),
        ('h1', 'headline-1 PostDetail-module-scss-module__title'), ('div', 'body-3 agate')])
    subject, = _template_sequence(subjects, [('span', '')])
    _template_text(subject)
    _template_text(title)
    time, = _template_sequence(date, [('time', '', ('datetime',))])
    _template_text(time)
    if not time.attrs.get('datetime'):
        raise transport.ImportFailure('unsupported_template')
    try:
        if datetime.fromisoformat(time.attrs['datetime']).tzinfo is None:
            raise ValueError('date has no timezone')
    except ValueError as exc:
        raise transport.ImportFailure('unsupported_template') from exc
    image, = _template_sequence(illustration, [('img', 'PostDetail-module-scss-module__heroImage',
        ('alt', 'width', 'height', 'decoding', 'data-nimg', 'style', 'src', 'srcset', 'loading'))])
    hero_image = _template_image(image, hero=True)
    body_wrapper = _template_node(classified['body'], 'div', 'page-wrapper')
    body, = _template_sequence(body_wrapper, [('article', '')])
    wrapper, = _template_sequence(body, [('div', '')])
    prose, = _template_sequence(wrapper, [('div', 'Body-module-scss-module__body', ('data-theme',))])
    if prose.attrs.get('data-theme') != 'ivory':
        raise transport.ImportFailure('unsupported_template')
    clean_body = []
    for node in _template_children(prose):
        control.remaining()
        if node.tag == 'p':
            _template_node(node, 'p', 'Body-module-scss-module__reading-column body-2 serif post-text')
            clean_body.append(_Node('p', {}, _template_inline(node)))
        elif node.tag == 'h2':
            _template_node(node, 'h2', 'Body-module-scss-module__reading-column headline-5 post-section', ('id',))
            clean_body.append(_Node('h2', {}, _template_inline(node)))
        else:
            _template_node(node, 'div', 'Body-module-scss-module__media-column')
            figure, = _template_sequence(node, [('figure', 'ImageWithCaption-module-scss-module__e-imageWithCaption')])
            image, caption = _template_sequence(figure, [
                ('img', '', ('alt', 'width', 'height', 'decoding', 'data-nimg', 'style', 'src', 'srcset', 'loading')),
                ('figcaption', 'caption')])
            clean_body.append(_Node('figure', {}, [_template_image(image),
                _Node('figcaption', {}, _template_inline(caption))]))
    if not clean_body:
        raise transport.ImportFailure('unsupported_template')
    footer = _template_node(classified['share'], 'div', 'page-wrapper PostDetail-module-scss-module__postFooter')
    share, = _template_sequence(footer, [('div', 'PostDetail-module-scss-module__socialShare')])
    targets = {'Share on Twitter': 'https://twitter.com/intent/tweet?text=' + url,
               'Share on LinkedIn': 'https://www.linkedin.com/shareArticle?mini=true&url=' + url}
    for link in _template_children(share):
        _template_node(link, 'a', '', ('href', 'target', 'rel', 'aria-label'))
        label = link.attrs.get('aria-label')
        if (label not in targets or link.attrs.get('href') != targets.pop(label)
                or link.attrs.get('target') != '_blank' or link.attrs.get('rel') != 'noopener'):
            raise transport.ImportFailure('unsupported_template')
        icon, = _template_sequence(link, [('svg', 'Icon-module-scss-module__icon', ('width', 'height', 'viewbox'))])
        _template_icon(icon, '32', '0 0 32 32')
    if targets:
        raise transport.ImportFailure('unsupported_template')
    related = _template_node(classified['related'], 'section', 'LandingPageSection-module-scss-module__root', ('data-theme',))
    if related.attrs.get('data-theme') != 'ivory':
        raise transport.ImportFailure('unsupported_template')
    wrapper, = _template_sequence(related, [('div', 'page-wrapper')])
    intro, grid = _template_sequence(wrapper, [
        ('div', 'SectionIntro-module-scss-module__root LinkGrid-module-scss-module__intro'),
        ('div', 'LinkGrid-module-scss-module__root')])
    heading, = _template_sequence(intro, [('h2', 'headline-4 SectionIntro-module-scss-module__title')])
    _template_text(heading)
    items, = _template_sequence(grid, [('div', 'LinkGrid-module-scss-module__items LinkGrid-module-scss-module__threeItems')])
    cards = _template_children(items)
    if len(cards) != 3:
        raise transport.ImportFailure('unsupported_template')
    destinations = set()
    for card in cards:
        _template_node(card, 'div', 'LinkGrid-module-scss-module__item')
        heading, paragraph, link = _template_sequence(card, [
            ('h3', 'headline-6'), ('p', 'body-3 serif'),
            ('a', 'ButtonTextLink-module-scss-module__textLink LinkGrid-module-scss-module__cta', ('href', 'referrerpolicy'))])
        _template_text(heading)
        _template_text(paragraph)
        href = link.attrs.get('href', '')
        destination = transport.normalize_url(urljoin(url, href)).url
        if (not re.fullmatch(r'/research/[a-z0-9-]+', href) or destination == url
                or destination in destinations or link.attrs.get('referrerpolicy') != 'no-referrer-when-downgrade'):
            raise transport.ImportFailure('unsupported_template')
        destinations.add(destination)
        label, icon_wrapper = _template_sequence(link, [('span', 'body-3'), ('span', 'ButtonTextLink-module-scss-module__icon')])
        _template_text(label)
        icon, = _template_sequence(icon_wrapper, [('svg', 'Icon-module-scss-module__icon', ('width', 'height', 'viewbox'))])
        _template_icon(icon, '20', '0 0 21 21')
    control.remaining()
    return _Node('div', {'published_at': time.attrs['datetime']}, [_Node('h1', {}, list(title.children)), hero_image, _Node('article', {}, clean_body)])


class _HTMLContent:
    def __init__(self, final_url, control, image_inputs):
        self.url = transport.normalize_url(final_url)
        self.control = control
        self.images = image_inputs
        self.blocks = []
        self.assets = []
        self.length = 0
        self.tables = 0

    def inline(self, children, preserve=False):
        chars, owners = [], []

        def visit(items, href=None):
            for child in items:
                self.control.remaining()
                if isinstance(child, str):
                    for ch in child:
                        if len(chars) % 4096 == 0:
                            self.control.remaining()
                        if len(chars) >= 500000:
                            raise transport.ImportFailure('text_limit')
                        if not preserve and ch in ' \t\r\n\f':
                            if not chars or chars[-1] == ' ':
                                continue
                            ch = ' '
                        chars.append(ch)
                        owners.append(href)
                elif child.tag == 'br':
                    chars.append('\n' if preserve else ' ')
                    owners.append(None)
                elif child.tag in {'a', 'span', 'em', 'strong', 'b', 'i', 'code'}:
                    link = href
                    if child.tag == 'a':
                        if href is not None or not child.attrs.get('href'):
                            raise transport.ImportFailure('unsupported_link')
                        link = transport.normalize_url(urljoin(self.url.url, child.attrs['href'])).url
                    visit(child.children, link)
                else:
                    raise transport.ImportFailure('unsupported_structure')
        visit(children)
        if not preserve:
            while chars and chars[-1] == ' ':
                chars.pop()
                owners.pop()
        links, index = [], 0
        while index < len(owners):
            end = index + 1
            while end < len(owners) and owners[end] == owners[index]:
                end += 1
            if owners[index] is not None:
                links.append(dict(start=index, end=end, href=owners[index]))
            index = end
        return ''.join(chars), links

    def add(self, kind, text, links=(), **fields):
        start = self.length + bool(self.blocks)
        end = start + len(text)
        if end > 500000:
            raise transport.ImportFailure('text_limit')
        block: dict = dict(id=f'b{len(self.blocks)}', type=kind, text=text, start=start, end=end, **fields)
        if links:
            block['links'] = list(links)
        self.blocks.append(block)
        self.length = end

    def simple(self, node, kind, **fields):
        text, links = self.inline(node.children, preserve=kind == 'code')
        if text:
            self.add(kind, text, links, **fields)

    def children(self, node, allowed=None):
        result = []
        for child in node.children:
            if isinstance(child, str):
                if child.strip():
                    raise transport.ImportFailure('unsupported_structure')
            elif allowed is not None and child.tag not in allowed:
                raise transport.ImportFailure('unsupported_structure')
            else:
                result.append(child)
        return result

    def listing(self, node, depth):
        raw = node.attrs.get('start', '1')
        if not raw.isascii() or not raw.isdigit() or len(raw) > 6 or 'reversed' in node.attrs:
            raise transport.ImportFailure('unsupported_list')
        ordinal = int(raw)
        for item in self.children(node, {'li'}):
            if 'value' in item.attrs:
                raise transport.ImportFailure('unsupported_list')
            inline, nested = [], []
            for child in item.children:
                if isinstance(child, _Node) and child.tag in {'ul', 'ol'}:
                    nested.append(child)
                elif nested and (not isinstance(child, str) or child.strip()):
                    raise transport.ImportFailure('unsupported_list')
                else:
                    inline.append(child)
            text, links = self.inline(inline)
            if not text:
                raise transport.ImportFailure('unsupported_list')
            self.add('list-item', text, links, depth=depth, ordered=node.tag == 'ol', ordinal=ordinal)
            for child in nested:
                self.listing(child, depth + 1)
            ordinal += 1

    def table(self, node):
        table_id = f't{self.tables}'
        self.tables += 1
        rows = []
        for child in self.children(node, {'tr', 'thead', 'tbody', 'tfoot', 'caption'}):
            if child.tag == 'caption':
                self.simple(child, 'caption')
            elif child.tag == 'tr':
                rows.append(child)
            else:
                rows.extend(self.children(child, {'tr'}))
        width = None
        for row_index, row in enumerate(rows):
            cells, texts, links, position = [], [], [], 0
            for col, cell in enumerate(self.children(row, {'td', 'th'})):
                if set(cell.attrs) & {'rowspan', 'colspan', 'headers'}:
                    raise transport.ImportFailure('unsupported_table')
                text, spans = self.inline(cell.children)
                header = cell.tag == 'th'
                scope = cell.attrs.get('scope', 'col' if row_index == 0 else 'row') if header else None
                if (scope not in {None, 'col', 'row'} or (scope == 'row' and col != 0)
                        or (scope == 'col' and row_index != 0)):
                    raise transport.ImportFailure('unsupported_table')
                cells.append(dict(text=text, start=position, end=position + len(text), header=header, scope=scope))
                links.extend(dict(start=p['start'] + position, end=p['end'] + position, href=p['href']) for p in spans)
                texts.append(text)
                position += len(text) + 1
            if not cells or (width is not None and width != len(cells)):
                raise transport.ImportFailure('unsupported_table')
            width = len(cells)
            self.add('table-row', '\t'.join(texts), links, table_id=table_id, row=row_index, cells=cells)
        if not rows:
            raise transport.ImportFailure('unsupported_table')

    def image_reference(self, node, ordinal):
        caption = node.attrs.get('alt', '')
        if ordinal > IMAGE_COUNT:
            raise ImageFailure('image_count', ordinal, caption)
        if not node.attrs.get('src') or 'srcset' in node.attrs or 'loading' in node.attrs:
            raise ImageFailure('missing_image', ordinal, caption)
        url = transport.normalize_url(urljoin(self.url.url, node.attrs['src']))
        if self.url.secure and not url.secure:
            raise ImageFailure('https_downgrade', ordinal, caption)
        return ImageReference(url.url, caption)

    def image(self, node):
        ordinal = len(self.assets) + 1
        reference = self.image_reference(node, ordinal)
        caption = reference.caption
        url = transport.normalize_url(reference.url)
        matches = [image for image in self.images if image.original_url == url.url]
        if len(matches) != 1:
            raise ImageFailure('missing_image', ordinal, caption)
        image = matches[0]
        final = transport.normalize_url(image.final_url)
        if self.url.secure and (not url.secure or not final.secure):
            raise ImageFailure('https_downgrade', ordinal, caption)
        try:
            self.control.consume(len(image.body))
            body, width, height = _decode_image(image, self.control)
        except transport.ImportFailure as exc:
            raise ImageFailure(exc.code, ordinal, caption) from exc
        asset_id = f'image{ordinal}'
        self.assets.append(AssetBytes(asset_id, body, 'image/png', width, height))
        self.add('image', '', asset_id=asset_id)

    def walk(self, node):
        self.control.remaining()
        tag = node.tag
        if tag in {'article', 'main', 'section', 'div', 'figure'}:
            for child in self.children(node):
                self.walk(child)
        elif tag in {'nav', 'footer'}:
            return
        elif tag in {'p', 'blockquote', 'pre', 'figcaption'}:
            self.simple(node, {'p': 'paragraph', 'blockquote': 'quote', 'pre': 'code', 'figcaption': 'caption'}[tag])
        elif tag in {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}:
            self.simple(node, 'heading', level=int(tag[1]))
        elif tag in {'ul', 'ol'}:
            self.listing(node, 0)
        elif tag == 'table':
            self.table(node)
        elif tag == 'img':
            self.image(node)
        else:
            raise transport.ImportFailure('unsupported_structure')


def _select_html(fetched, control):
    control.remaining()
    if fetched.mime != 'text/html':
        raise transport.ImportFailure('unsupported_html')
    template = (transport.normalize_url(fetched.final_url).url.startswith('https://www.anthropic.com/')
                and b'PostDetail-module-scss-module__' in fetched.body)
    if template:
        root = selected = _anthropic_selection(fetched.body, fetched.final_url, control)
    else:
        root = _html_tree(fetched.body, control)
        articles = _nodes(root, 'article')
        candidates = articles or _nodes(root, 'main')
        if len(candidates) != 1:
            raise transport.ImportFailure('ambiguous_article')
        selected = candidates[0]
    return root, selected, template


def _finish_html(fetched, control, prepare_import, root, content, template):
    headings = [b['text'] for b in content.blocks if b['type'] == 'heading' and b['level'] == 1]
    titles = _nodes(root, 'title')
    if len(headings) == 1:
        title = headings[0]
    elif not headings and len(titles) == 1:
        title, _ = content.inline(titles[0].children)
    else:
        raise transport.ImportFailure('ambiguous_title')
    text = '\n'.join(b['text'] for b in content.blocks)
    if not title or not text.strip():
        raise transport.ImportFailure('empty_article')
    control.remaining()
    transport.normalize_url(fetched.original_url)
    prepared = prepare_import(title, text, content.blocks)
    control.remaining()
    assets = tuple(content.assets)
    observation = json.dumps(dict(original_url=fetched.original_url,
        final_url=content.url.url, fetched_at=datetime.now(timezone.utc).isoformat(),
        raw_html_sha256=hashlib.sha256(fetched.body).hexdigest()), ensure_ascii=False).encode('utf-8')
    source, document = SourceSnapshot.freeze(prepared, content.url.url,
        'anthropic-postdetail-1' if template else 'strict-html-1',
        'anthropic-safe-1' if template else 'safe-html-1',
        json.dumps({'author': None, 'published_at': root.attrs.get('published_at') if template else None}).encode('utf-8'),
        observation, assets)
    control.remaining()
    return HTMLPreparation(source, document, assets, fetched.body)


def prepare_html(fetched: transport.Fetched, control: transport.Control, prepare_import,
                 *, image_inputs: tuple[transport.Fetched, ...] = ()) -> HTMLPreparation:
    """Validate offline bytes; this seam cannot attest to their transport history."""
    control.remaining()
    if len(image_inputs) > IMAGE_COUNT:
        raise transport.ImportFailure('image_count')
    root, selected, template = _select_html(fetched, control)
    control.consume(len(fetched.body))
    content = _HTMLContent(fetched.final_url, control, image_inputs)
    content.walk(selected)
    return _finish_html(fetched, control, prepare_import, root, content, template)


class _HTMLReferences(_HTMLContent):
    def __init__(self, final_url, control):
        super().__init__(final_url, control, ())
        self.references: list[ImageReference] = []

    def image(self, node):
        ordinal = len(self.references) + 1
        self.references.append(self.image_reference(node, ordinal))
        self.add('image', '', asset_id=f'image{ordinal}')


class URLPreparer:
    """Synchronous preparation for ExecutionOwner; no Store or publication rights.

    The owner must retain its slot until this call exits, even after cancellation.
    Download bytes are charged by transport, encoded bytes by prepare_images.
    """
    def __init__(self, prepare_import):
        self._prepare_import = prepare_import

    def prepare(self, url: str, control: transport.Control) -> HTMLPreparation:
        control.remaining()
        fetched = transport.fetch(url, 'html', control, same_host_redirects=True)
        root, selected, template = _select_html(fetched, control)
        content = _HTMLReferences(fetched.final_url, control)
        content.walk(selected)
        images = prepare_images(tuple(content.references), fetched.final_url, control)
        content.assets = [AssetBytes(f'image{image.ordinal}', image.body, image.mime,
                                    image.width, image.height) for image in images]
        control.remaining()
        return _finish_html(fetched, control, self._prepare_import, root, content, template)

