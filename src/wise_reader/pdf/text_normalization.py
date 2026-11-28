"""Conservative reading-only repair of retained PDF text.

A dictionary entry is never sufficient evidence: require the same complete word
elsewhere in the original paragraph, exact reconstruction and adjacent same-column
geometry. Ambiguity preserves the old text. Original records are never mutated.
Offsets below are block-local and half-open, with both codepoint and UTF-16 units.
"""
from __future__ import annotations

import hashlib
import math
import re
import sqlite3
import unicodedata
from contextlib import closing
from pathlib import Path

POLICY = 'pdf-line-wrap-v1'
_WORD = re.compile(r"(?<![A-Za-z'-])[A-Za-z]+(?![A-Za-z'-])")
_END = re.compile(r"(?<![A-Za-z'-])([a-z]{2,})-$")
_START = re.compile(r"^([a-z]{2,})(?![A-Za-z'-])")
_NATIVE_END = re.compile(r"(?<![A-Za-z'-])([A-Za-z]+)(-?)$")
_NATIVE_START = re.compile(r"^([a-z]+)(?![A-Za-z'-])")


def _u16(text):
    return len(text.encode('utf-16-le')) // 2


def _range(text, start, end):
    return {'cp': [start, end], 'utf16': [_u16(text[:start]), _u16(text[:end])]}


def _dictionary_allows(combined, suffix, hyphenated):
    # Fresh immutable read-only handle, only for geometry/witness-qualified pairs.
    # No lemma inference, network, mutable process-global cache or shared connection.
    path = Path(__file__).resolve().parents[3] / 'data/stardict.db'
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
            words = {row[0].lower() for row in db.execute(
                'SELECT word FROM stardict WHERE word IN (?,?,?)', (combined, suffix, hyphenated))}
        return combined in words and suffix not in words and hyphenated not in words
    except (sqlite3.Error, OSError):
        return False


def _box(line):
    box = line.get('bbox')
    if (not isinstance(box, list) or len(box) != 4
            or any(type(v) not in (int, float) or not math.isfinite(v) for v in box)
            or box[0] >= box[2] or box[1] >= box[3]):
        return None
    return box


def native_lines(block):
    raw, glyphs = block.get('raw_text'), block.get('source', {}).get('glyphs')
    if not raw or not glyphs:
        return []
    chars = [(c, g['bbox']) for g in glyphs for c in unicodedata.normalize('NFKC', g['text'])
             if not c.isspace()]
    lines, cursor = [], 0
    for i, line in enumerate(raw.split('\n')):
        letters = [(j, c) for j, c in enumerate(line) if not c.isspace()]
        span = chars[cursor:cursor + len(letters)]
        if not letters or [c for _, c in letters] != [c for c, _ in span]:
            return []
        boxes = {j: box for (j, _), (_, box) in zip(letters, span)}
        bbox = [min(b[0] for b in boxes.values()), min(b[1] for b in boxes.values()),
                max(b[2] for b in boxes.values()), max(b[3] for b in boxes.values())]
        lines.append({'id': f"{block['id']}-line-{i}", 'text': line, 'bbox': bbox, 'glyphs': boxes})
        cursor += len(letters)
    return lines if cursor == len(chars) else []


def source_lines(block):
    return block.get('source', {}).get('lines') or native_lines(block)


def _native_word(left, right):
    a, b = _NATIVE_END.search(left), _NATIVE_START.match(right)
    if not a or not b or a[1].isupper() and len(a[1]) > 1:
        return None
    first, last = a[1].lower(), b[1]
    word = first + last
    if len(word) < 4:
        return None
    hyphen = first + '-' + last
    keys = {first, last, word, hyphen}
    keys |= {key[:-1] for key in keys if len(key) > 3 and key.endswith('s')}
    path = Path(__file__).resolve().parents[3] / 'data/stardict.db'
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
            words = {row[0] for row in db.execute(
                f"SELECT word FROM stardict WHERE word IN ({','.join('?' for _ in keys)})", tuple(keys))}
    except (sqlite3.Error, OSError):
        return None
    def known(value):
        return (value in {'a', 'i'} if len(value) == 1 else
                value in words or len(value) > 3 and value.endswith('s') and value[:-1] in words)
    if known(word) and not (known(first) and known(last)) and not (a[2] and hyphen in words):
        return a.start(1), len(a[2]), len(last)
    return None


def discretionary_hyphen(left, right):
    return left.endswith('-') and _native_word(left, right) is not None


def _native_edits(lines, texts, boxes):
    left, right = min(b[0] for b in boxes), max(b[2] for b in boxes)
    offset = 0
    for i, (line, value, box) in enumerate(zip(lines, texts, boxes)):
        glyphs = line['glyphs']
        height = box[3] - box[1]
        for gap in re.finditer(r"(?<=[A-Za-z]) (?=[a-z])", value):
            p = gap.start()
            a, b = glyphs[p - 1], glyphs[p + 1]
            if 0 <= b[0] - a[2] <= .23 * height and (word := _native_word(value[:p], value[p + 1:])):
                start, _, length = word
                yield offset + p, offset + p + 1, [offset + start, offset + p + 1 + length], [line['id']], 'tight_glyph_gap+dictionary'
        end = offset + len(value)
        if i + 1 < len(lines):
            following = boxes[i + 1]
            if (.8 <= height / (following[3] - following[1]) <= 1.25
                    and -.1 * height <= following[1] - box[3] <= .85 * height
                    and abs(following[0] - left) <= .6 * height and right - box[2] <= 2.6 * height
                    and (word := _native_word(value, texts[i + 1]))):
                start, hyphen, length = word
                yield end - hyphen, end + 1, [offset + start, end + 1 + length], [line['id'], lines[i + 1]['id']], 'adjacent_glyph_lines+dictionary'
        offset = end + 1


def normalize_block(block, page=None):
    """Return (reading text, optional mapping); unsupported/ambiguous => identity."""
    value = block.get('text', '').strip()
    source = block.get('source') or {}
    geometry = page or source
    lines = source_lines(block)
    native = bool(lines and 'glyphs' in lines[0])
    if (block.get('type') != 'paragraph' or block.get('asset') or block.get('asset_url')
            or block.get('inline_objects') or block.get('inline_styles')
            or geometry.get('rotation', 0) != 0 or len(lines) < (1 if native else 2)
            or geometry.get('coordinate_space') != 'rotated_crop_top_left'
            or not all(isinstance(line, dict) and isinstance(line.get('text'), str) for line in lines)):
        return value, None
    # Do not normalize a previously corrected version from stale original lines.
    # Other join conventions and line-trimming differences fail closed as well.
    texts = [line['text'].strip() for line in lines]
    if (' '.join(texts) != value or block.get('raw_text') != '\n'.join(line['text'] for line in lines)
            or native and any(text != line['text'] for text, line in zip(texts, lines))
            or any(line.get('page_number', source.get('page_number')) != source.get('page_number') for line in lines)):
        return value, None
    witnesses = {m.group().lower() for line in texts for m in _WORD.finditer(line)}
    boxes = [_box(line) for line in lines]
    if any(box is None for box in boxes):
        return value, None
    boxes = [box for box in boxes if box is not None]
    right = max(box[2] for box in boxes)
    left = min(box[0] for box in boxes)
    offset, edits, changes = 0, [], []
    for i, previous in enumerate(texts[:-1] if not native else ()):
        following = texts[i + 1]
        a, b = _END.search(previous), _START.match(following)
        old_end = offset + len(previous)
        if a and b:
            first, last = a.group(1), b.group(1)
            combined = first + last
            one, two = boxes[i], boxes[i + 1]
            h, h2 = one[3] - one[1], two[3] - two[1]
            scores = [lines[i].get('confidence'), lines[i + 1].get('confidence')]
            geometry = (.8 <= h / h2 <= 1.25 and -.1 * h <= two[1] - one[3] <= .8 * h
                and abs(one[0] - left) <= .6 * h and abs(two[0] - left) <= .6 * h
                and abs(one[2] - right) <= .6 * h and two[2] <= right + .6 * h)
            confidence = all(type(s) in (int, float) and math.isfinite(s) and .97 <= s <= 1 for s in scores)
            if (geometry and confidence and combined in witnesses
                    and _dictionary_allows(combined, last, first + '-' + last)):
                start, end = old_end - 1, old_end + 1  # exactly '- ' at this line boundary
                removed = sum(e['old_cp'][1] - e['old_cp'][0] for e in edits)
                old_word = [offset + a.start(1), end + len(last)]
                new_word = [old_word[0] - removed, old_word[1] - removed - 2]
                old = _range(value, start, end)
                edits.append({'old_cp': old['cp'], 'old_utf16': old['utf16'],
                    'new_cp': [start - removed, start - removed],
                    'line_ids': [lines[i].get('id'), lines[i + 1].get('id')],
                    'reason': 'same_paragraph_intact_witness+adjacent_column+dictionary_veto'})
                changes.append({'old_cp': old_word, 'new_cp': new_word})
        offset = old_end + 1
    if native:
        for start, end, old_word, line_ids, reason in _native_edits(lines, texts, boxes):
            removed = sum(e['old_cp'][1] - e['old_cp'][0] for e in edits)
            if changes and old_word[0] < changes[-1]['old_cp'][1]:
                continue
            old = _range(value, start, end)
            edits.append({'old_cp': old['cp'], 'old_utf16': old['utf16'],
                'new_cp': [start - removed] * 2, 'line_ids': line_ids, 'reason': reason})
            changes.append({'old_cp': old_word,
                'new_cp': [old_word[0] - removed, old_word[1] - removed - (end - start)]})
    if not edits:
        return value, None
    result, cursor = [], 0
    for edit in edits:
        start, end = edit['old_cp']
        result.append(value[cursor:start]); cursor = end
    result.append(value[cursor:])
    normalized = ''.join(result)
    for edit in edits:
        edit['new_utf16'] = [_u16(normalized[:edit['new_cp'][0]])] * 2
    for change in changes:
        change['old_utf16'] = _range(value, *change['old_cp'])['utf16']
        change['new_utf16'] = _range(normalized, *change['new_cp'])['utf16']
    return normalized, {'version': POLICY, 'old_text_sha256': hashlib.sha256(value.encode()).hexdigest(),
        'new_text_sha256': hashlib.sha256(normalized.encode()).hexdigest(),
        'old_length_cp': len(value), 'new_length_cp': len(normalized),
        'old_length_utf16': _u16(value), 'new_length_utf16': _u16(normalized),
        'edits': edits, 'changes': changes}


def verified_mapping(before, after):
    """Validate the complete deletion contract against retained authoritative text.

    Missing/corrupt metadata must not authorize relocation, especially when a
    forged empty change list would turn an old prefix into a new word's meaning.
    """
    try:
        old, new = before['text'], after['text']
        mapping = after['normalization']
        if mapping['version'] != POLICY or not mapping['edits']:
            return False
        for label, text in (('old', old), ('new', new)):
            if (mapping[label + '_text_sha256'] != hashlib.sha256(text.encode()).hexdigest()
                    or mapping[label + '_length_cp'] != len(text)
                    or mapping[label + '_length_utf16'] != _u16(text)):
                return False
        cursor, removed, pieces, changes = 0, 0, [], []
        for edit in mapping['edits']:
            lo, hi = edit['old_cp']
            if (type(lo) is not int or type(hi) is not int or lo < cursor
                    or hi > len(old) or old[lo:hi] not in {' ', '- '}):
                return False
            left = _NATIVE_END.search(old[:lo])
            right = _NATIVE_START.match(old[hi:])
            if not left or left[2] or not right:
                return False
            old_word = [left.start(), hi + right.end()]
            new_word = [old_word[0] - removed, old_word[1] - removed - (hi - lo)]
            if (edit['old_utf16'] != _range(old, lo, hi)['utf16']
                    or edit['new_cp'] != [lo - removed] * 2
                    or edit['new_utf16'] != [_u16(new[:lo - removed])] * 2):
                return False
            changes.append({'old_cp': old_word, 'new_cp': new_word,
                'old_utf16': _range(old, *old_word)['utf16'],
                'new_utf16': _range(new, *new_word)['utf16']})
            pieces.append(old[cursor:lo]); cursor = hi; removed += hi - lo
        pieces.append(old[cursor:])
        return ''.join(pieces) == new and changes == mapping['changes']
    except (KeyError, TypeError, ValueError, UnicodeError, IndexError):
        return False


def reading_position(anchor, old_blocks, new_blocks, version, book_id, source_sha256):
    """Prove a position, not a quotation, using retained text and deletion edits.

    Inside a removed separator, land at its surviving left boundary. Reject
    incomplete UTF-16 characters and ambiguous/missing source evidence.
    """
    try:
        if (anchor.get('segments') or anchor.get('kind') == 'image'
                or not source_sha256):
            return None
        previous = [b for b in old_blocks if b['id'] == anchor.get('block_id')]
        current = [b for b in new_blocks if b['id'] == anchor.get('block_id')]
        if len(previous) != 1 or len(current) != 1:
            return None
        before, after = previous[0], current[0]
        source = anchor['pdf_source']
        for item in (source, before['source'], after['source']):
            box = item['bbox']
            if (item['source_sha256'] != source_sha256 or item['book_id'] != book_id
                    or type(item['page_number']) is not int or item['page_number'] < 1
                    or not isinstance(box, list) or len(box) != 4
                    or any(type(n) not in (int, float) or not math.isfinite(n) for n in box)
                    or not (box[0] < box[2] and box[1] < box[3])):
                return None
            if any(item[key] != source[key] for key in ('page_number', 'bbox')):
                return None
        old, new, offset = before['text'], after['text'], anchor['start']
        if type(offset) is not int or offset < 0 or offset > _u16(old):
            return None
        # decode is strict: an offset between surrogate halves is not a position.
        start = len(old.encode('utf-16-le')[:offset * 2].decode('utf-16-le'))
        if old != new:
            if not verified_mapping(before, after):
                return None
            removed = 0
            mapped = start
            for edit in after['normalization']['edits']:
                lo, hi = edit['old_cp']
                if start >= hi:
                    removed += hi - lo
                elif start > lo:
                    mapped = lo
            start = mapped - removed
        offset = _u16(new[:start])
        return {'version': version, 'block_id': after['id'], 'start': offset,
                'end': offset, 'kind': 'text', 'quote': '',
                'ratio': anchor.get('ratio', 0),
                'pdf_source': {**after['source'], 'revision': version}}
    except (KeyError, TypeError, ValueError, UnicodeError, IndexError):
        return None


def intersects_change(block, start, end):
    """A quote hit inside a corrected token is not the same old occurrence.

    Input is block-local codepoints, NOT DOM UTF-16. Metadata is produced above,
    included in the content revision, and must not be used to transplant meanings.
    """
    return any(start < hi and end > lo for lo, hi in
        (change['new_cp'] for change in (block.get('normalization') or {}).get('changes', [])))
