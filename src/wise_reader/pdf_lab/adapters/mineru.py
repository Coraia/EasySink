"""CPU-only, isolated source-first MinerU adapter and normalized output bridge."""
from __future__ import annotations
from collections import Counter
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
from statistics import median
import subprocess
import time

from .mineru_runtime import discover_mineru_runtime, runtime_environment

TOKEN = re.compile(r'WRFORMULA\d{10}')


def _visible_pdf_literal(digital, number, glyph_box, literal, ink_box=None):
    """Cross-check glyphs in opaque, filled PDFium text objects."""
    import ctypes
    import pypdfium2 as pdfium

    rendered = digital.renderer[number - 1]
    try:
        textpage = rendered.get_textpage()
        try:
            visible = []
            height = digital.pdf.pages[number - 1].height
            for i in range(textpage.count_chars()):
                char = chr(pdfium.raw.FPDFText_GetUnicode(textpage, i))
                if char.isspace():
                    continue
                left, bottom, right, top = textpage.get_charbox(i)
                x, y = (left + right) / 2, height - (bottom + top) / 2
                if not (glyph_box[0] <= x <= glyph_box[2] and glyph_box[1] <= y <= glyph_box[3]):
                    continue
                obj = pdfium.raw.FPDFText_GetTextObject(textpage, i)
                rgba = [ctypes.c_uint() for _ in range(4)]
                if (not obj or pdfium.raw.FPDFTextObj_GetTextRenderMode(obj) != 0
                        or not pdfium.raw.FPDFText_GetFillColor(textpage, i, *rgba) or rgba[3].value != 255):
                    return False
                if ink_box and not (ink_box[0] <= left < right <= ink_box[2]
                                    and ink_box[1] <= height - top < height - bottom <= ink_box[3]):
                    return False
                visible.append((left, char))
            return ''.join(c for _, c in sorted(visible)) == literal
        finally:
            textpage.close()
    finally:
        rendered.close()


def _quoted_character_text(digital, number, bbox, visible_crop):
    """Recover a quoted single punctuation character explicitly named in prose.

    Quoted variables, numbers and expressions remain images. The PDF itself must
    supply both the literal and the adjacent word 'character(s)' on one baseline.
    """
    import string

    page = digital.pdf.pages[number - 1]
    if (page.rotation or list(page.mediabox) != [0, 0, page.width, page.height]
            or visible_crop != [0, 0, page.width, page.height]):
        return None
    chars = [c for c in page.chars if c.get('text', '').strip()]
    selected = sorted((c for c in chars
                       if bbox[0] <= (c['x0'] + c['x1']) / 2 <= bbox[2]
                       and bbox[1] <= (c['top'] + c['bottom']) / 2 <= bbox[3]), key=lambda c: c['x0'])
    literal = ''.join(c['text'] for c in selected)
    pairs = {'“': '”', '‘': '’', '"': '"', "'": "'"}
    if (len(selected) != 3 or len(literal) != 3 or pairs.get(literal[0]) != literal[-1]
            or literal[1] not in string.punctuation or literal[1] in pairs):
        return None
    size = selected[0].get('size', 0)
    if type(size) not in (float, int) or not math.isfinite(size) or not 4 <= size <= 48:
        return None
    tolerance = min(1., size * .1)
    # Font boxes include unused descender space. Allow at most .15 em while
    # independently requiring every tight PDFium ink box inside the detector.
    font_margin = min(1.5, size * .15)
    if any(not c.get('upright') or abs(c.get('size', 0) - size) > .05 * size
           or abs(c['top'] - selected[0]['top']) > tolerance
           or abs(c['bottom'] - selected[0]['bottom']) > tolerance
           or c['x0'] < bbox[0] - font_margin or c['x1'] > bbox[2] + font_margin
           or c['top'] < bbox[1] - font_margin or c['bottom'] > bbox[3] + font_margin for c in selected):
        return None
    if (selected[0].get('fontname') != selected[-1].get('fontname')
            or any(not -.1 <= b['x0'] - a['x1'] <= size * .25 for a, b in zip(selected, selected[1:]))):
        return None
    following = sorted((c for c in chars if c['x0'] >= selected[-1]['x1'] - .1
                        and abs(c['top'] - selected[0]['top']) <= tolerance), key=lambda c: c['x0'])
    word = []
    for c in following:
        if not c['text'].isalpha() or (word and c['x0'] - word[-1]['x1'] > size * .12):
            break
        word.append(c)
    noun = ''.join(c['text'] for c in word)
    if (noun not in ('character', 'characters')
            or not size * .12 < word[0]['x0'] - selected[-1]['x1'] <= size * .75
            or any(not c.get('upright') or c.get('fontname') != selected[0].get('fontname')
                   or abs(c.get('size', 0) - size) > .05 * size
                   or abs(c['bottom'] - selected[0]['bottom']) > tolerance for c in word)
            or any(b['x0'] < a['x1'] - size * .06 for a, b in zip(word, word[1:]))):
        return None
    glyph_box = [min(c['x0'] for c in selected), min(c['top'] for c in selected),
                 max(c['x1'] for c in selected), max(c['bottom'] for c in selected)]
    context_box = [glyph_box[0], min(glyph_box[1], *(c['top'] for c in word)),
                   word[-1]['x1'], max(glyph_box[3], *(c['bottom'] for c in word))]
    if (not _visible_pdf_literal(digital, number, glyph_box, literal, ink_box=bbox)
            or not _visible_pdf_literal(digital, number, context_box, literal + noun)):
        return None
    return {'text': literal, 'following_word': noun, 'glyph_bbox': glyph_box, 'context_bbox': context_box,
            'font_name': selected[0]['fontname'], 'font_size_pt': size,
            'proof': 'visible_pdf_glyphs_and_quoted_character_prose'}


def _linked_citation_text(digital, number, bbox, visible_crop):
    """Recover only a visible, same-baseline numeric PDF cross-reference.

    A detector label alone cannot distinguish a citation from math. Require the
    original PDF's glyphs, a matching labelled internal link, and PDFium's visible
    text objects. Unsupported geometry or incomplete proof keeps the source crop.
    """
    page = digital.pdf.pages[number - 1]
    if (page.rotation or list(page.mediabox) != [0, 0, page.width, page.height]
            or visible_crop != [0, 0, page.width, page.height]):
        return None
    def inside(char, rect):
        return rect[0] <= (char['x0'] + char['x1']) / 2 <= rect[2] and rect[1] <= (char['top'] + char['bottom']) / 2 <= rect[3]
    chars = [c for c in page.chars if c.get('text', '').strip()]
    selected = sorted((c for c in chars if inside(c, bbox)), key=lambda c: c['x0'])
    literal = ''.join(c['text'] for c in selected)
    if not 1 <= len(selected) <= 24 or not re.fullmatch(r'[0-9]+(?:\.[0-9]+)*[,.;:]?', literal):
        return None
    size = selected[0].get('size', 0)
    if type(size) not in (float, int) or not math.isfinite(size) or not 4 <= size <= 48:
        return None
    tolerance = min(1., size * .1)
    if any(not c.get('upright') or c['x0'] < bbox[0] - tolerance or c['x1'] > bbox[2] + tolerance
           or c['top'] < bbox[1] - tolerance or c['bottom'] > bbox[3] + tolerance for c in selected):
        return None
    glyph_box = [min(c['x0'] for c in selected), min(c['top'] for c in selected),
                 max(c['x1'] for c in selected), max(c['bottom'] for c in selected)]
    for annotation in page.annots:
        data = annotation.get('data', {})
        action = data.get('A', {})
        if (getattr(data.get('Subtype'), 'name', None) != 'Link' or not isinstance(action, dict)
                or getattr(action.get('S'), 'name', None) != 'GoTo' or not action.get('D')):
            continue
        link_box = [annotation[k] for k in ('x0', 'top', 'x1', 'bottom')]
        linked = sorted((c for c in chars if inside(c, link_box)), key=lambda c: c['x0'])
        if not linked or any(not inside(c, link_box) for c in selected if c['text'].isdigit()):
            continue
        # Superscripts, mathematical fonts/baselines and overlapping text layers
        # do not qualify even when their strings happen to look like a number.
        if any(not c.get('upright') or c.get('fontname') != linked[0].get('fontname')
               or abs(c.get('size', 0) - size) > .05 * size
               or abs(c['top'] - linked[0]['top']) > tolerance
               or abs(c['bottom'] - linked[0]['bottom']) > tolerance for c in linked + selected):
            continue
        if any(b['x0'] < a['x1'] - .1 or b['x0'] - a['x1'] > size * .75 for a,b in zip(linked, linked[1:])):
            continue
        label_text = ''.join((' ' if i and c['x0'] - linked[i-1]['x1'] > size * .12 else '') + c['text']
                             for i,c in enumerate(linked))
        label = re.fullmatch(r'(Section|Sec\.|Figure|Fig\.|Table|Appendix|Chapter) ([0-9]+(?:\.[0-9]+)*)', label_text)
        if label is None or label[2] != literal.rstrip(',.;:'):
            continue
        if not _visible_pdf_literal(digital, number, glyph_box, literal, ink_box=bbox):
            return None
        return {'text': literal, 'label': label[1], 'glyph_bbox': glyph_box, 'link_bbox': link_box,
                'font_name': selected[0]['fontname'], 'font_size_pt': size,
                'proof': 'visible_pdf_glyphs_and_labelled_internal_link'}
    return None


def _equation_reference_pair(digital, number, boxes, paragraph, visible_crop):
    """Prove a native Eq./Eqs. + parenthesized numeric reference, atomically.

    This is prose-reference recovery, never formula interpretation. Both source
    crops and their immediate native prose context must independently verify.
    """
    parts = [sorted(_native_chars(digital, number, b, visible_crop), key=lambda c: c['x0']) for b in boxes]
    if not all(parts):
        return None
    literals = [''.join(c['text'] for c in part) for part in parts]
    if literals[0] not in ('Eq.', 'Eqs.'):
        return None
    reference = re.fullmatch(r'\(([1-9][0-9]{0,3})\)(?:[–-]\(([1-9][0-9]{0,3})\))?', literals[1])
    if not reference or (reference[2] and int(reference[2]) <= int(reference[1])):
        return None
    size = parts[0][0]['size']
    font = parts[0][0]['fontname']
    if not 4 <= size <= 48:
        return None
    tolerance = min(1., size * .1)
    glyph_boxes = []
    for part, bbox, literal in zip(parts, boxes, literals):
        if any(c['fontname'] != font or abs(c['size'] - size) > size * .05
               or abs(c['top'] - part[0]['top']) > tolerance
               or abs(c['bottom'] - part[0]['bottom']) > tolerance for c in part):
            return None
        if any(not -.1 <= b['x0'] - a['x1'] <= size * .5 for a, b in zip(part, part[1:])):
            return None
        gb = _union_boxes([[c['x0'], c['top'], c['x1'], c['bottom']] for c in part])
        ink_box = [max(paragraph[0], bbox[0] - .02), max(paragraph[1], bbox[1] - .02),
                   min(paragraph[2], bbox[2] + .02), min(paragraph[3], bbox[3] + .02)]
        if not _visible_pdf_literal(digital, number, gb, literal, ink_box=ink_box):
            return None
        glyph_boxes.append(gb)
    chars = _native_chars(digital, number, paragraph, visible_crop)
    lines = [sorted((c for c in chars if abs(c['top'] - part[0]['top']) <= tolerance
                     and abs(c['bottom'] - part[0]['bottom']) <= tolerance), key=lambda c: c['x0']) for part in parts]
    try:
        first = lines[0].index(parts[0][0])
        second = lines[1].index(parts[1][0])
    except ValueError:
        return None
    delta = parts[1][0]['top'] - parts[0][0]['top']
    if abs(delta) <= tolerance:
        if second != first + len(parts[0]) or not 0 <= parts[1][0]['x0'] - parts[0][-1]['x1'] <= size:
            return None
    else:
        # Exactly the next native line, within this same paragraph/column.
        if (not size * .8 <= delta <= size * 1.8 or first + len(parts[0]) != len(lines[0]) or second != 0
                or parts[1][0]['x0'] - paragraph[0] > size or paragraph[2] - parts[0][-1]['x1'] > size
                or any(parts[0][0]['top'] + tolerance < c['top'] < parts[1][0]['top'] - tolerance for c in chars)):
            return None
    before = lines[0][:first]
    after = lines[1][second + len(parts[1]):]
    while after and after[0]['text'] in ',.;:':
        after = after[1:]
    contexts = [before[-2:], after[:2]]
    for context in contexts:
        if (len(context) != 2 or any(not c['text'].isalpha() or c['fontname'] != font
                                    or abs(c['size'] - size) > size * .05 for c in context)
                or not -.1 <= context[1]['x0'] - context[0]['x1'] <= size * .5):
            return None
        cb = _union_boxes([[c['x0'], c['top'], c['x1'], c['bottom']] for c in context])
        if not _visible_pdf_literal(digital, number, cb, ''.join(c['text'] for c in context), ink_box=paragraph):
            return None
    return [{'text': literal, 'glyph_bbox': gb, 'font_name': font, 'font_size_pt': size,
             'reference_source_boxes': boxes, 'reference_literal': ' '.join(literals), 'ink_tolerance_pt': .02,
             'proof': 'visible_pdf_ink_and_native_equation_reference_syntax'} for literal, gb in zip(literals, glyph_boxes)]


def _union_boxes(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _layout_blocks(raws):
    """Resolve source-image ownership, then order a proven two-column section."""
    from copy import deepcopy

    def literal(value):
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return ''.join(literal(v) for v in value)
        return literal(value.get('content', '')) if isinstance(value, dict) else ''
    raws = deepcopy(raws)
    removed = set()
    images = [i for i, r in enumerate(raws) if r['type'] in ('image', 'chart')]
    area = lambda b: (b[2] - b[0]) * (b[3] - b[1])
    for i in sorted(images, key=lambda i: area(raws[i]['bbox']), reverse=True):
        if i in removed:
            continue
        owner = raws[i]
        for j in images:
            if j == i or j in removed:
                continue
            a, b = owner['bbox'], raws[j]['bbox']
            overlap = max(0., min(a[2], b[2]) - max(a[0], b[0])) * max(0., min(a[3], b[3]) - max(a[1], b[1]))
            if area(a) < area(b) or overlap < .98 * area(b):
                continue
            owner['bbox'] = _union_boxes([a, b])
            captions = [v for v in raws[j].get('content', []) if isinstance(v, dict)
                        and str(v.get('type', '')).endswith(('_caption', '_footnote'))]
            content = owner.get('content', [])
            owner['content'] = list(content) if isinstance(content, list) else []
            for caption in captions:
                if caption not in owner['content']:
                    owner['content'].append(caption)
            removed.add(j)
        # A short panel label beside the illustration belongs to its source crop.
        for j, raw in enumerate(raws):
            if j in removed or raw['type'] != 'text':
                continue
            if not re.fullmatch(r'\(?[a-zA-Z]\)', literal(raw.get('content', '')).strip()):
                continue
            a, b = owner['bbox'], raw['bbox']
            if a[1] <= b[1] < b[3] <= a[3] and a[0] - .03 <= b[0] and b[2] <= a[2] + .03:
                owner['bbox'] = _union_boxes([a, b]); removed.add(j)
    raws = [r for i, r in enumerate(raws) if i not in removed]
    content = [r for r in raws if r['type'] not in ('header', 'footer', 'page_header', 'page_footer', 'page_number')]
    refs = [r for r in content if r['type'] == 'ref_text']
    # A references section occupying both columns supplies a shared band boundary.
    # Without that evidence retain the engine order (including spanning figures).
    if len(refs) < 4 or any(r['bbox'][0] < .5 < r['bbox'][2] for r in content):
        return raws
    left = [r for r in refs if r['bbox'][2] <= .5]
    right = [r for r in refs if r['bbox'][0] >= .5]
    if min(len(left), len(right)) < 2:
        return raws
    top_left, top_right = min(r['bbox'][1] for r in left), min(r['bbox'][1] for r in right)
    if abs(top_left - top_right) > .025:
        return raws
    boundary = min(top_left, top_right)
    headings = [r for r in content if r['type'] in ('title', 'paragraph_title')
                and 0 <= boundary - r['bbox'][3] <= .025]
    if len(headings) == 1:
        boundary = headings[0]['bbox'][1] - .001
    if any(r['bbox'][1] < boundary < r['bbox'][3] for r in content):
        return raws
    ordered = sorted(content, key=lambda r: (r['bbox'][1] >= boundary, r['bbox'][0] >= .5, r['bbox'][1], r['bbox'][0]))
    headers = [r for r in raws if r['type'] in ('header', 'page_header')]
    footers = [r for r in raws if r not in content and r not in headers]
    return headers + ordered + footers


def _native_chars(digital, number, bbox, visible_crop):
    page = digital.pdf.pages[number - 1]
    if (page.rotation or list(page.mediabox) != [0, 0, page.width, page.height]
            or any(abs(a - b) > .001 for a, b in zip(visible_crop, [0, 0, page.width, page.height]))):
        return []
    return [c for c in page.chars if c.get('text', '').strip() and c.get('upright')
            and bbox[0] <= (c['x0'] + c['x1']) / 2 <= bbox[2]
            and bbox[1] <= (c['top'] + c['bottom']) / 2 <= bbox[3]]


def _unverified_math_box(digital, number, bbox, value, visible_crop):
    """Only suspect a short isolated row with a special-font '?' and raised glyph."""
    if not isinstance(value, str) or '?' not in value or len(value) > 100 or TOKEN.search(value):
        return None
    margin = min(4., (bbox[3] - bbox[1]) * .3)
    expanded = [bbox[0], max(0., bbox[1] - margin), bbox[2], bbox[3]]
    chars = _native_chars(digital, number, expanded, visible_crop)
    if len(chars) < 4:
        return None
    size = median(c['size'] for c in chars)
    base = [c for c in chars if c['size'] >= size * .9]
    if not base or max(c['bottom'] for c in base) - min(c['bottom'] for c in base) > size * .35:
        return None
    for question in (c for c in chars if c['text'] == '?'):
        others = [c for c in base if c['text'] != '?']
        raised = [c for c in chars if .45 * size <= c['size'] < .85 * size
                  and c['bottom'] < question['bottom'] - size * .2
                  and abs(c['x0'] - question['x0']) < size]
        if raised and others and all(c['fontname'] != question['fontname'] for c in others):
            return _union_boxes([bbox, *[[c['x0'], c['top'], c['x1'], c['bottom']] for c in chars]])
    return None


def _visible_native_glyphs(digital, number):
    """Read each opaque PDFium glyph once; retain its actual ink coordinates."""
    import ctypes
    import pypdfium2 as pdfium

    glyphs = {}
    page = digital.renderer[number - 1]
    try:
        textpage = page.get_textpage()
        try:
            height = digital.pdf.pages[number - 1].height
            for i in range(textpage.count_chars()):
                char = chr(pdfium.raw.FPDFText_GetUnicode(textpage, i))
                if char.isspace():
                    continue
                obj = pdfium.raw.FPDFText_GetTextObject(textpage, i)
                rgba = [ctypes.c_uint() for _ in range(4)]
                if (not obj or pdfium.raw.FPDFTextObj_GetTextRenderMode(obj) not in (0, 2)
                        or not pdfium.raw.FPDFText_GetFillColor(textpage, i, *rgba) or rgba[3].value != 255):
                    continue
                left, bottom, right, top = textpage.get_charbox(i)
                if left < right and bottom < top:
                    x, y = ctypes.c_double(), ctypes.c_double()
                    if pdfium.raw.FPDFText_GetCharOrigin(textpage, i, x, y):
                        glyphs.setdefault(char, []).append((left, height - top, right, height - bottom, x.value, y.value))
        finally:
            textpage.close()
    finally:
        page.close()
    return glyphs


def _native_table_rows(digital, number, bbox, visible_crop):
    """Recover independently visible native baselines outside actual ruled cells.

    This is bounded recovery for an oversized table classification. It does not
    interpret table HTML, align interlinear words, or translate unknown glyphs.
    """
    import unicodedata

    chars = _native_chars(digital, number, bbox, visible_crop)
    if len(chars) < 80 or bbox[2] - bbox[0] < digital.pdf.pages[number - 1].width * .6:
        return [], False
    literal = ''.join(c['text'] for c in chars)
    greek = sum('\u0370' <= c <= '\u03ff' or '\u1f00' <= c <= '\u1fff' for c in literal)
    cjk = sum('\u4e00' <= c <= '\u9fff' for c in literal)
    if greek < 40 and cjk < 80:
        return [], False
    page = digital.pdf.pages[number - 1]
    size = median(c['size'] for c in chars)
    horizontal = [e for e in page.edges if e['orientation'] == 'h' and e['x1'] - e['x0'] > size * 3]
    vertical = [e for e in page.edges if e['orientation'] == 'v'
                and bbox[0] + size < e['x0'] < bbox[2] - size
                and e['bottom'] - e['top'] > size * 1.3]
    grid, dividers = [], []
    for e in vertical:
        cross = [h for h in horizontal if e['top'] - 2 <= h['top'] <= e['bottom'] + 2
                 and h['x0'] - 2 <= e['x0'] <= h['x1'] + 2]
        parallels = [v for v in vertical if abs(v['x0'] - e['x0']) > size
                     and abs(v['top'] - e['top']) < 2 and abs(v['bottom'] - e['bottom']) < 2]
        if len({round(h['top']) for h in cross}) >= 3 or parallels:
            grid.append((e['top'] - 2, e['bottom'] + 2))
        elif len(cross) >= 2 and e['bottom'] - e['top'] > size * 5:
            dividers.append(e)
    merged = []
    for a, b in sorted(grid):
        if merged and a - merged[-1][1] < size * 2:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    # A repeated shaded grid can lack vertical ink on its header row. Include
    # only a nearby row with native text on both sides of a proven separator.
    for band in merged:
        above = [c for c in chars if band[0] - size * 1.5 <= c['top'] < band[0]
                 and c['bottom'] <= band[0] + 2]
        separators = [v['x0'] for v in vertical if band[0] <= v['top'] <= band[1]]
        above.sort(key=lambda c: c['x0'])
        separated = any(b['x0'] - a['x1'] > size * 2 for a, b in zip(above, above[1:]))
        if separated and any(any(c['x1'] < x for c in above) and any(c['x0'] > x for c in above) for x in separators):
            band[0] = min(c['top'] for c in above) - 2
    grid = merged
    def column(c):
        return tuple(c['x0'] >= d['x0'] for d in dividers
                     if d['top'] <= (c['top'] + c['bottom']) / 2 <= d['bottom'])
    rows = []
    for c in sorted(chars, key=lambda c: (c['bottom'], c['x0'])):
        if any(a <= (c['top'] + c['bottom']) / 2 <= b for a, b in grid):
            continue
        if (any(unicodedata.category(t) in ('Co', 'Cc', 'Cs') or t == '\ufffd' for t in c['text'])
                or '(cid:' in c['text']):
            continue
        row = next((r for r in reversed(rows) if abs(r[0]['bottom'] - c['bottom']) < min(1., c['size'] * .1)
                    and abs(r[0]['size'] - c['size']) < c['size'] * .12
                    and column(r[0]) == column(c)), None)
        if row is None:
            rows.append([c])
        else:
            row.append(c)
    visible = _visible_native_glyphs(digital, number)
    proven = []
    for row in rows:
        row.sort(key=lambda c: c['x0'])
        if not any(c['text'].isalpha() for c in row):
            continue
        rb = _union_boxes([[c['x0'], c['top'], c['x1'], c['bottom']] for c in row])
        if not (0 <= rb[0] < rb[2] <= page.width and 0 <= rb[1] < rb[3] <= page.height):
            continue
        # Interlinear indices/arrows use other baselines. Prove each native
        # language glyph individually instead of absorbing those adjacent rows.
        ink, verified = [], True
        for c in row:
            matched = [(char, b) for char in set(c['text']) for b in visible.get(char, [])
                       if abs(b[4] - c['matrix'][4]) < .01 and abs(b[5] - c['matrix'][5]) < .01]
            # PDFium expands multi-codepoint ligatures at the same ink box.
            if Counter(char for char, _ in matched) != Counter(c['text']):
                verified = False
                break
            ink.extend(b[:4] for _, b in matched)
        if not verified:
            continue
        text = ''.join((' ' if i and c['x0'] - row[i-1]['x1'] > c['size'] * .18 else '') + c['text']
                       for i, c in enumerate(row))
        proven.append({'text': text, 'bbox': _union_boxes(ink), 'ink_boxes': ink, 'font_bbox': rb,
                       'font_size_pt': median(c['size'] for c in row),
                       'proof': 'visible_native_pdf_baseline_outside_ruled_cells'})
    # Interlinear text needs its full source composition as a parallel reference.
    def reading_order(row):
        b = row['bbox']
        divider = next((d for d in dividers if d['top'] <= (b[1] + b[3]) / 2 <= d['bottom']), None)
        return (divider['top'], b[0] >= divider['x0'], b[1]) if divider else (b[1], False, b[0])
    return sorted(proven, key=reading_order), greek >= 40 and not grid


def asset_holders(page):
    """Every asset-bearing object in the publication contract (including lookup-only crops)."""
    for block in page.get('blocks', []) + page.get('non_content_objects', []):
        yield block
        if block.get('marker'):
            yield block['marker']
        yield from block.get('inline_objects', [])
    yield from page.get('formula_regions', [])


def validate_formula_contract(page):
    """Validate links and Python/codepoint offsets before any publication or resume."""
    regions = page.get('formula_regions', [])
    if not isinstance(regions, list):
        raise ValueError('Formula regions must be an array.')
    by_id = {}
    def geometry(item):
        source = item.get('source', {})
        box = source.get('bbox')
        if (source.get('page_number') != page['page_number'] or not isinstance(box, list) or len(box) != 4
                or any(type(v) not in (int, float) or not math.isfinite(v) for v in box)
                or not (0 <= box[0] < box[2] <= page['width'] and 0 <= box[1] < box[3] <= page['height'])):
            raise ValueError('Invalid formula source geometry.')
        if not isinstance(item.get('asset'), str) or not item['asset']:
            raise ValueError('Formula has no registered source asset.')
    for region in regions:
        if not isinstance(region, dict):
            raise ValueError('Invalid formula region.')
        identity = region.get('formula_id')
        if not isinstance(identity, str) or not re.fullmatch(r'p\d{6,}-f[0-9a-f]{20}', identity) or identity in by_id:
            raise ValueError('Formula region ID is invalid or duplicated.')
        geometry(region)
        by_id[identity] = region
    for block in page['blocks']:
        text = block['text']
        if 'WRFORMULA' in text:
            raise ValueError('Internal formula marker leaked into source text.')
        objects = block.get('inline_objects', [])
        if not isinstance(objects, list):
            raise ValueError('Inline objects must be an array.')
        positions = set()
        for obj in objects:
            if not isinstance(obj, dict):
                raise ValueError('Invalid inline object.')
            start, end = obj.get('start'), obj.get('end')
            if type(start) is not int or type(end) is not int or end != start + 1 or not 0 <= start < len(text) or text[start:end] != '\ufffc' or start in positions:
                raise ValueError('Inline formula offsets do not match one source object character.')
            positions.add(start)
            geometry(obj)
            for name in ('font_size_pt', 'width', 'height'):
                if type(obj.get(name)) not in (float, int) or not math.isfinite(obj[name]) or obj[name] <= 0:
                    raise ValueError('Invalid inline formula dimensions.')
            region = by_id.get(obj.get('formula_id'))
            if region is None or obj['asset'] != region['asset'] or obj['source'] != region['source']:
                raise ValueError('Inline formula does not match its trusted region.')
        if objects or by_id or page.get('extraction_method') == 'mineru_source':
            if positions != {i for i, char in enumerate(text) if char == '\ufffc'}:
                raise ValueError('An inline source formula has no registered object.')
        if block.get('formula_id') or (page.get('extraction_method') == 'mineru_source' and block.get('source_type') == 'formula'):
            geometry(block)
            region = by_id.get(block.get('formula_id'))
            if region is None:
                raise ValueError('Display formula has no trusted recognition region.')
            box, inner = block['source']['bbox'], region['source']['bbox']
            if not (box[0] <= inner[0] + .1 and box[1] <= inner[1] + .1 and box[2] + .1 >= inner[2] and box[3] + .1 >= inner[3]):
                raise ValueError('Display formula does not contain its recognition crop.')
    if 'WRFORMULA' in page['text']:
        raise ValueError('Internal formula marker leaked into page source text.')


class MinerUSourceProcess:
    def __init__(self, source, output, digital):
        self.source, self.output, self.digital = source, output, digital
        self.runtime = discover_mineru_runtime()
        self.timeout = self.runtime.settings['page_timeout_seconds']
        self.process = self.log = self.lock = self.fallback = None
        self.peak = 0

    def close(self):
        if self.process is not None:
            if not self.process.stdin.closed:
                self.process.stdin.close()
            if self.process.poll() is None:
                try:
                    self.process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self.process.terminate()
                try:
                    self.process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self.process.kill(); self.process.wait(timeout=2)
            for stream in (self.process.stdin, self.process.stdout):
                stream.close()
            self.process = None
        if self.log is not None:
            self.log.close(); self.log = None
        if self.lock is not None:
            self.lock.close(); self.lock = None
        if self.fallback is not None:
            self.fallback.close(); self.fallback = None

    def _launch(self):
        from ..conversion import PageAttemptError
        self.lock = (self.runtime.manifest.parent / 'inference.lock').open('a+')
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as error:
                if time.monotonic() >= deadline:
                    self.close()
                    raise PageAttemptError('Local MinerU runtime remained busy.', category='runtime_busy', retryable=True) from error
                time.sleep(.1)
        self.log = (self.output / 'mineru-stderr.log').open('ab')
        env = runtime_environment(self.runtime, self.output / 'mineru-runtime')
        self.process = subprocess.Popen([str(self.runtime.python), '-u', str(Path(__file__).with_name('mineru_engine.py'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=env, bufsize=0)
        # Inherit the task's private process group: worker cancel kills the entire tree.

    def _read(self):
        from ..conversion import MAX_PAGE_JSON_BYTES, PageAttemptError
        import psutil
        deadline = time.monotonic() + self.timeout
        buffer = bytearray()
        pid = self.process.pid
        peak = 0
        while True:
            if (self.output / 'mineru-stderr.log').stat().st_size > 16 * 1024**2:
                self.close()
                raise PageAttemptError('MinerU diagnostic log exceeds budget.', category='resource_limit')
            if time.monotonic() >= deadline:
                self.close()
                raise PageAttemptError('MinerU page exceeded its deadline.', category='page_timeout', retryable=True)
            try:
                process = psutil.Process(pid)
                memory = sum(p.memory_info().rss for p in [process, *process.children(recursive=True)])
                peak = max(peak, memory)
                if memory > self.runtime.settings['max_worker_bytes'] or psutil.virtual_memory().available < self.runtime.settings['min_available_bytes']:
                    self.close()
                    raise PageAttemptError('MinerU memory budget reached; completed pages retained.', category='resource_limit')
            except psutil.NoSuchProcess:
                pass
            ready, _, _ = select.select([self.process.stdout], [], [], .1)
            if not ready:
                continue
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                self.close()
                raise PageAttemptError('MinerU process exited; see mineru-stderr.log.', category='page_engine_interrupted')
            buffer.extend(chunk)
            if len(buffer) > MAX_PAGE_JSON_BYTES:
                self.close()
                raise PageAttemptError('MinerU IPC exceeds page budget.', category='resource_limit')
            if b'\n' in buffer:
                line, remainder = buffer.split(b'\n', 1)
                if remainder:
                    self.close()
                    raise ValueError('Unexpected MinerU protocol data.')
                payload = json.loads(line)
                self.peak = max(self.peak, peak)
                return payload

    def _input(self, number):
        width, height, _, crop, media = self.digital.geometry(number)
        if not self.digital.pdf.pages[number - 1].rotation and crop == media and width * height * 4 <= self.runtime.settings['max_input_pixels']:
            return self.source, number
        # A visible raster removes all ambiguity about intrinsic rotation/CropBox.
        import pypdfium2 as pdfium
        page = self.digital.renderer[number - 1]
        scale = min(2., (self.runtime.settings['max_input_pixels'] / (width * height)) ** .5)
        bitmap = page.render(scale=scale, limit_image_cache=True)
        document = pdfium.PdfDocument.new()
        try:
            normalized = document.new_page(width, height)
            image = pdfium.PdfImage.new(document)
            image.set_bitmap(bitmap)
            image.set_matrix(pdfium.PdfMatrix(width, 0, 0, height, 0, 0))
            normalized.insert_obj(image); normalized.gen_content()
            path = self.output / 'inputs' / f'p{number:06d}-mineru-visible.pdf'
            path.parent.mkdir(exist_ok=True)
            document.save(path)
            normalized.close()
            return path, 1
        finally:
            document.close(); bitmap.close(); page.close()

    def convert(self, number, attempt, *, fallback=False):
        from ..conversion import PageAttemptError, PageProcess, atomic_json, MAX_PAGE_JSON_BYTES
        if fallback:
            self.close()
            self.fallback = PageProcess(self.source, self.output, 'digital', False)
            payload = self.fallback.convert(number, attempt, fallback=True)
            payload['worker_peak_rss_bytes'] = max(self.peak, payload['worker_peak_rss_bytes'])
            return payload
        try:
            if self.process is None:
                self._launch()
            source, page_number = self._input(number)
            self.process.stdin.write((json.dumps({'source': str(source), 'page': page_number}) + '\n').encode())
            self.process.stdin.flush()
            payload = self._read()
            if 'error' in payload:
                error = payload['error']
                self.close()
                raise PageAttemptError(error['message'], category=error['category'], retryable=error['retryable'], error_type=error['type'])
            if payload['runtime_identity'] != self.runtime.identity:
                raise ValueError('MinerU runtime identity changed before conversion.')
            atomic_json(self.output / 'raw' / f'p{number:06d}-attempt{attempt}.json', payload, max_bytes=MAX_PAGE_JSON_BYTES)
            self.digital.asset_metadata.clear()
            page = normalize_page(payload, number, self.digital)
            page['runtime_identity'] = self.runtime.identity
            page['formula_model_calls'] = 0
            page['model_sessions'] = payload['sessions']
            page['engine_timings'] = payload.get('engine_timings', {})
            validate_formula_contract(page)
            return {'page': page, 'asset_metadata': dict(self.digital.asset_metadata), 'worker_peak_rss_bytes': self.peak}
        except (BrokenPipeError, ConnectionResetError) as error:
            self.close()
            raise PageAttemptError('MinerU IPC interrupted.', category='page_engine_interrupted') from error


def normalize_page(payload, number, digital):
    width, height, visible_crop, crop, _ = digital.geometry(number)
    blocks, regions, by_token, used = [], [], {}, set()
    recovered = set()
    def box(value):
        if not isinstance(value, list) or len(value) != 4 or any(type(v) not in (int, float) or not math.isfinite(v) for v in value):
            raise ValueError('Missing MinerU source bbox.')
        result = [max(0., min(1., n)) * (width if i % 2 == 0 else height) for i, n in enumerate(value)]
        if not (result[0] < result[2] and result[1] < result[3]):
            raise ValueError('Empty MinerU source bbox.')
        return result
    def source(bbox):
        return {'page_number': number, 'bbox': bbox}
    def identity(bbox):
        digest = hashlib.sha256(json.dumps([number, *[round(v, 4) for v in bbox]], separators=(',', ':')).encode()).hexdigest()[:20]
        return f'p{number:06d}-f{digest}'
    seen = {}
    for token, detection in payload['detections'].items():
        bbox = box(detection['bbox'])
        fid = identity(bbox)
        if fid not in seen:
            region = {'formula_id': fid, 'source': source(bbox), 'kind': detection['kind'],
                      'asset': digital.crop_asset(number, bbox, fid + '-recognition'),
                      'width': bbox[2] - bbox[0], 'height': bbox[3] - bbox[1],
                      'recognition_state': 'not_requested'}
            regions.append(region); seen[fid] = region
        by_token[token] = seen[fid]
    # A formula's bounding box is not its surrounding font size. Exclude formula
    # glyphs, then use one robust source-body baseline for the whole paragraph.
    source_page = digital.pdf.pages[number - 1]
    body_chars = []
    if not source_page.rotation:
        formula_boxes = [r['source']['bbox'] for r in regions]
        for char in source_page.chars:
            size = char.get('size')
            if not char.get('text', '').strip() or type(size) not in (float, int) or not math.isfinite(size) or not 4 <= size <= 48:
                continue
            x = (char['x0'] + char['x1']) / 2 - visible_crop[0]
            y = (char['top'] + char['bottom']) / 2 - visible_crop[1]
            if not (0 <= x <= width and 0 <= y <= height) or any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in formula_boxes):
                continue
            body_chars.append((x, y, float(size)))
    def body_font(bbox):
        sizes = [size for x, y, size in body_chars if bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3]]
        if len(sizes) >= 5:
            return round(median(sizes), 3), 'paragraph_source_chars'
        if len(body_chars) >= 20:
            return round(median(c[2] for c in body_chars), 3), 'page_source_chars_median'
        return 10., 'explicit_10pt_fallback'
    def flatten(value):
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return ''.join(flatten(item) for item in value)
        if isinstance(value, dict):
            return flatten(value.get('content', ''))
        return ''
    marker_uses = Counter(TOKEN.findall(flatten(payload['raw_page']['blocks'])))
    region_uses = Counter()
    for token, region in by_token.items():
        region_uses[region['formula_id']] += marker_uses[token]
    def prose(raw, bbox, role=None):
        value = flatten(raw)
        text, objects, recoveries, pos = '', [], [], 0
        font_size, font_origin = body_font(bbox)
        reference_proofs = {}
        matches = list(TOKEN.finditer(value))
        for left, right in zip(matches, matches[1:]):
            if value[left.end():right.start()].strip():
                continue
            pair = [by_token.get(m.group()) for m in (left, right)]
            if any(r is None or r['kind'] != 'inline_formula' or region_uses[r['formula_id']] != 1
                   or not (bbox[0] <= r['source']['bbox'][0] < r['source']['bbox'][2] <= bbox[2]
                           and bbox[1] <= r['source']['bbox'][1] < r['source']['bbox'][3] <= bbox[3]) for r in pair):
                continue
            try:
                proofs = _equation_reference_pair(digital, number, [r['source']['bbox'] for r in pair], bbox, visible_crop)
            except (AttributeError, KeyError, TypeError, ValueError, RuntimeError):
                proofs = None
            if proofs:
                reference_proofs.update((m.group(), proof) for m, proof in zip((left, right), proofs))
        for match in matches:
            text += value[pos:match.start()]
            region = by_token.get(match.group())
            if region is None:
                raise ValueError('Unknown formula marker.')
            inner = region['source']['bbox']
            if (region['kind'] == 'inline_formula' and region_uses[region['formula_id']] == 1
                    and bbox[0] <= inner[0] < inner[2] <= bbox[2]
                    and bbox[1] <= inner[1] < inner[3] <= bbox[3]):
                try:
                    proof = reference_proofs.get(match.group())
                    if proof is None:
                        proof = _linked_citation_text(digital, number, inner, visible_crop)
                    if proof and 'label' in proof and not re.search(r'\b' + re.escape(proof['label']) + r'\s+$', value[:match.start()]):
                        proof = None
                    if proof is None:
                        proof = _quoted_character_text(digital, number, inner, visible_crop)
                        if proof and not re.match(r'\s+' + re.escape(proof['following_word']) + r'\b', value[match.end():]):
                            proof = None
                except (AttributeError, KeyError, TypeError, ValueError, RuntimeError):
                    # Optional source-text proof cannot invalidate a usable crop.
                    proof = None
                if proof:
                    recoveries.append({**proof, 'start': len(text), 'end': len(text) + len(proof['text']),
                                       'source': region['source']})
                    text += proof['text']; pos = match.end()
                    recovered.add(region['formula_id']); used.add(region['formula_id'])
                    continue
            obj = dict(region)
            obj.update(start=len(text), end=len(text) + 1, font_size_pt=font_size, font_size_origin=font_origin)
            objects.append(obj); used.add(region['formula_id'])
            text += '\ufffc'; pos = match.end()
        text += value[pos:]
        if not text:
            return
        block = {'type': 'heading' if role in ('title', 'paragraph_title') else 'paragraph',
                 'text': text, 'source': source(bbox), 'asset': None}
        if role:
            block['role'] = role
        if objects:
            block['inline_objects'] = objects
        if recoveries:
            block['source_text_recoveries'] = recoveries
        blocks.append(block)
    raw_blocks = _layout_blocks(payload['raw_page']['blocks'])
    emitted = set()
    for raw in raw_blocks:
        if id(raw) in emitted:
            continue
        emitted.add(id(raw))
        kind, value = raw['type'], raw.get('content', '')
        if kind in ('page_number', 'page_header', 'page_footer'):
            continue
        bbox = box(raw['bbox'])
        if kind not in ('equation', 'image', 'chart', 'table'):
            suspect = _unverified_math_box(digital, number, bbox, flatten(value), visible_crop)
            if suspect:
                blocks.append({'type': 'image_fallback', 'source_type': 'equation_unmatched', 'text': '',
                               'source': source(suspect),
                               'asset': digital.crop_asset(number, suspect, f'mineru-block{len(blocks):05d}'),
                               'fallback_reason': 'unverified_native_math_glyphs'})
            else:
                prose(value, bbox, kind)
            continue
        captions = [v for v in value if isinstance(v, dict) and str(v.get('type', '')).endswith(('_caption', '_footnote'))] if isinstance(value, list) else []
        before, after = [], []
        for caption in captions:
            cb = box(caption['bbox']) if caption.get('bbox') else bbox
            (before if cb[1] < bbox[1] else after).append((caption, cb))
        for caption, cb in before:
            prose(caption.get('content', ''), cb, caption['type'])
        rows, interlinear = _native_table_rows(digital, number, bbox, visible_crop) if kind == 'table' else ([], False)
        if rows:
            formula_boxes = [r['source']['bbox'] for r in regions]
            rows = [r for r in rows if not any(r['bbox'][0] < b[2] and b[0] < r['bbox'][2]
                    and r['bbox'][1] < b[3] and b[1] < r['bbox'][3] for b in formula_boxes)]
            other_text = [box(r['bbox']) for r in raw_blocks if r is not raw
                          and r['type'] not in ('table', 'image', 'chart', 'equation')]
            rows = [r for r in rows if not any(b[0] <= (r['bbox'][0] + r['bbox'][2]) / 2 <= b[2]
                    and b[1] <= (r['bbox'][1] + r['bbox'][3]) / 2 <= b[3] for b in other_text)]
        if rows:
            first_row_top = min(r['bbox'][1] for r in rows)
            leading = [r for r in raw_blocks if id(r) not in emitted
                       and r['type'] in ('header', 'title', 'paragraph_title')
                       and box(r['bbox'])[3] <= first_row_top]
            for heading in sorted(leading, key=lambda r: r['bbox'][1]):
                prose(heading.get('content', ''), box(heading['bbox']), heading['type'])
                emitted.add(id(heading))
        if rows and not interlinear:
            # Remove only source bands whose entire native ink is proven. Unknown
            # bullets/symbols and ruled cells stay in the residual source images.
            cuts = []
            visible_ink = [b[:4] for boxes in _visible_native_glyphs(digital, number).values() for b in boxes
                           if bbox[0] < b[2] and b[0] < bbox[2] and bbox[1] < b[3] and b[1] < bbox[3]]
            images = digital.pdf.pages[number - 1].images
            for row in rows:
                rb = row['bbox']
                other_ink = [b for b in visible_ink if b not in row['ink_boxes']
                             and rb[1] - .5 < b[3] and b[1] < rb[3] + .5]
                if (not other_ink
                        and not any(rb[1] < image['bottom'] and image['top'] < rb[3]
                                    and bbox[0] < image['x1'] and image['x0'] < bbox[2] for image in images)):
                    cuts.append((max(bbox[1], rb[1] - .5), min(bbox[3], rb[3] + .5)))
            remainder, top = [], bbox[1]
            for a, b in sorted(cuts):
                if a > top:
                    remainder.append([bbox[0], top, bbox[2], a])
                top = max(top, b)
            if top < bbox[3]:
                remainder.append([bbox[0], top, bbox[2], bbox[3]])
            items = [(r['bbox'][1], 'text', r) for r in rows]
            text_order = iter(rows)
            for rb in remainder:
                if (any(rb[1] < b[3] and b[1] < rb[3] for b in visible_ink)
                        or any(rb[1] < image['bottom'] and image['top'] < rb[3]
                               and bbox[0] < image['x1'] and image['x0'] < bbox[2] for image in images)):
                    items.append((rb[1], 'image', rb))
            for _, item_kind, item in sorted(items, key=lambda entry: entry[0]):
                if item_kind == 'text':
                    item = next(text_order)
                    blocks.append({'type': 'paragraph', 'text': item['text'], 'source': source(item['bbox']),
                                   'asset': None, 'role': 'recovered_native_body', 'source_text_proof': item['proof']})
                else:
                    blocks.append({'type': 'table', 'text': '', 'source': source(item), 'source_type': 'table',
                                   'asset': digital.crop_asset(number, item, f'mineru-block{len(blocks):05d}'),
                                   'fallback_reason': 'ruled_cells_or_unverified_native_remainder'})
            for caption, cb in after:
                prose(caption.get('content', ''), cb, caption['type'])
            continue
        asset = digital.crop_asset(number, bbox, f'mineru-block{len(blocks):05d}')
        block = {'type': 'formula' if kind == 'equation' else ('image' if kind == 'chart' else kind), 'text': '', 'source': source(bbox),
                 'source_type': 'formula' if kind == 'equation' else kind, 'asset': asset,
                 'fallback_reason': 'source_formula_not_recognized' if kind == 'equation' else 'source_image_preserved'}
        if kind == 'equation':
            links = [by_token[token] for token in TOKEN.findall(flatten(value)) if token in by_token]
            if not links:
                # Do not pretend a display crop containing a label is a trusted recognition crop.
                block.update(type='image_fallback', source_type='equation_unmatched', fallback_reason='formula_detection_unmatched')
            else:
                region = links[0]
                block['formula_id'] = region['formula_id']
                block['formula_ids'] = list(dict.fromkeys(r['formula_id'] for r in links))
                used.update(block['formula_ids'])
                # Detector may slightly exceed rounded block bbox. Include both in display crop.
                boxes = [bbox, *[r['source']['bbox'] for r in links]]
                outer = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
                block['source'] = source(outer)
                if outer != bbox:
                    block['asset'] = digital.crop_asset(number, outer, f'mineru-block{len(blocks):05d}')
        blocks.append(block)
        if rows and interlinear:
            block['role'] = 'interlinear_source_reference'
            for row in rows:
                blocks.append({'type': 'paragraph', 'text': row['text'], 'source': source(row['bbox']),
                               'asset': None, 'role': 'recovered_native_interlinear_row',
                               'source_text_proof': row['proof']})
        for caption, cb in after:
            prose(caption.get('content', ''), cb, caption['type'])
    for region in regions:
        fid, inner = region['formula_id'], region['source']['bbox']
        if fid in used:
            continue
        enclosing = next((b for b in blocks if b['type'] in ('image', 'table') and
                          b['source']['bbox'][0] <= inner[0] and b['source']['bbox'][1] <= inner[1] and
                          b['source']['bbox'][2] >= inner[2] and b['source']['bbox'][3] >= inner[3]), None)
        if enclosing is not None:
            region['contained_in_source_image'] = True
        else:
            blocks.append({'type': 'formula', 'source_type': 'formula', 'text': '', 'source': source(inner),
                           'asset': region['asset'], 'formula_id': fid, 'role': 'unplaced_source_region'})
    for i, block in enumerate(blocks):
        block['id'] = f'p{number:06d}-b{i + 1:05d}'
    regions = [region for region in regions if region['formula_id'] not in recovered]
    return {'page_number': number, 'width': width, 'height': height,
            'rotation': digital.pdf.pages[number - 1].rotation, 'crop_box': crop,
            'coordinate_space': 'rotated_crop_top_left', 'extraction_method': 'mineru_source',
            'quality_state': 'source_preserved' if regions else ('extracted' if blocks else 'blank'),
            'text': '\n\n'.join(b['text'] for b in blocks if b['text']), 'blocks': blocks,
            'formula_regions': regions, 'formula_raster_target_dpi': 288, 'warnings': ['Formulas and tables retain source images; formula recognition was not run.']}
