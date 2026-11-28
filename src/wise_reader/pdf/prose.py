"""Resolve revision-bound PDF paragraphs from the accepted reading ranges."""

import hashlib
import json
from dataclasses import dataclass
from functools import cached_property

from wise_reader.tokenize import sentence_spans

from .text_normalization import discretionary_hyphen

RANGE_PAGES = 8


@dataclass(frozen=True)
class SourceBlock:
    doc_id: int
    revision: str
    block: dict

    def identity(self):
        return self.doc_id, self.revision, self.block['id']

    def edge(self):
        return [self.block['id'], self.block['source']['conversion_task_id']]


@dataclass(frozen=True)
class Paragraph:
    members: tuple[SourceBlock, ...]
    pending: bool = False

    @cached_property
    def pieces(self):
        result, cursor = [], 0
        for i, member in enumerate(self.members):
            value = member.block['text']
            last = i + 1 == len(self.members)
            joined = not last and discretionary_hyphen(value, self.members[i + 1].block['text'])
            if joined:
                value = value[:-1]
            separator = '' if last or joined else ' '
            result.append((member, value, cursor, separator))
            cursor += len(value) + len(separator)
        return result

    @cached_property
    def text(self):
        return ''.join(text + separator for _, text, _, separator in self.pieces)

    def ranges(self, start, end):
        for member, text, cursor, _ in self.pieces:
            lo, hi = max(0, start - cursor), min(end - cursor, len(text))
            if lo < hi:
                yield member, lo, hi

    def gaps(self, start, end):
        return [len(separator) for _, text, cursor, separator in self.pieces
                if start < cursor + len(text) and cursor + len(text) + len(separator) < end]

    def sentences(self):
        text = self.text
        for start, end in sentence_spans(text):
            literal = text[start:end]
            start += len(literal) - len(literal.lstrip())
            end -= len(literal) - len(literal.rstrip())
            if end > start:
                yield start, end

    def location(self, doc_id, block_id, offset):
        for member, text, cursor, _ in self.pieces:
            if member.doc_id == doc_id and member.block['id'] == block_id:
                return cursor + len(text.encode('utf-16-le')[:offset * 2].decode('utf-16-le'))
        return None

    @property
    def ref(self):
        head = self.members[0]
        version = head.revision
        if self.members[-1].doc_id != head.doc_id:
            version = hashlib.sha256(json.dumps(['pdf-body-v1', *(
                member.identity() for member in self.members)]).encode()).hexdigest()
        return {'doc_id': head.doc_id, 'version': version, 'block_id': head.block['id']}


class PDFProse:
    def __init__(self, store, scope, version, blocks):
        self.store, self.scope = store, scope
        self.docs = {}
        self.units = {}
        self._add(scope, version, blocks)

    def _add(self, scope, version, blocks):
        doc_id = scope['doc_id']
        entries = {block['id']: SourceBlock(doc_id, version, block) for block in blocks}
        self.docs[scope['start_page']] = (entries, set(json.loads(scope['ready_pages'])))
        return self.docs[scope['start_page']]

    def _range(self, page):
        start = (page - 1) // RANGE_PAGES * RANGE_PAGES + 1
        if start not in self.docs:
            row = self.store.query_one(
                'SELECT r.*, c.version, c.blocks FROM wr_pdf_range r JOIN wr_content c ON c.doc_id=r.doc_id'
                ' WHERE r.book_id=? AND r.start_page=?', (self.scope['book_id'], start))
            if not row:
                self.docs[start] = ({}, set())
            else:
                self._add(row, row['version'], json.loads(row['blocks']))
        return self.docs[start]

    def _step(self, member, direction):
        block = member.block
        page = block['source_page']
        entries, _ = self._range(page)
        group = block.get('paragraph_group')
        if group:
            ids = group['blocks']
            i = ids.index(block['id']) + direction
            if 0 <= i < len(ids):
                return entries[ids[i]], False
        target_page = page + direction
        if target_page not in block.get('pdf_prose_neighbors', ()):
            return None, False
        others, ready = self._range(target_page)
        if target_page not in ready:
            return None, True
        if entries is others:
            return None, False
        peer = next((other for other in (others.values() if direction > 0 else reversed(others.values()))
            if other.block['source_page'] == target_page and not other.block.get('pdf_role')), None)
        if peer is None or page not in peer.block.get('pdf_prose_neighbors', ()):
            return None, False
        forward = 'pdf_prose_next' if direction > 0 else 'pdf_prose_previous'
        backward = 'pdf_prose_previous' if direction > 0 else 'pdf_prose_next'
        if block.get(forward) == peer.edge() or peer.block.get(backward) == member.edge():
            return peer, False
        return None, False

    def paragraph(self, block_id):
        members, _ = self.docs[self.scope['start_page']]
        found = members.get(block_id)
        if found is None or found.block.get('pdf_role'):
            return None
        identity = found.identity()
        if identity not in self.units:
            joined, pending = [], False
            for direction in (-1, 1):
                path = []
                current, waiting = self._step(found, direction)
                while current and len(path) < 255:
                    path.append(current)
                    current, waiting = self._step(current, direction)
                pending |= waiting or current is not None
                if direction < 0:
                    joined.extend(reversed(path))
                    joined.append(found)
                else:
                    joined.extend(path)
            unit = Paragraph(tuple(joined), pending)
            for member in joined:
                self.units[member.identity()] = unit
        return self.units[identity]

    def metadata(self):
        entries, _ = self.docs[self.scope['start_page']]
        return {block_id: {'ref': unit.ref, 'pending': unit.pending,
                          'size': len(unit.text.encode('utf-16-le')) // 2}
                for block_id, entry in entries.items() if entry.block.get('pdf_prose_neighbors')
                and (unit := self.paragraph(block_id))}


def resolve(store, doc_id, version, blocks):
    if not any(b.get('pdf_prose_neighbors') for b in blocks):
        return None
    scope = store.query_one('SELECT doc_id,book_id,start_page,end_page,ready_pages,revision FROM wr_pdf_range WHERE doc_id=?',
                           (doc_id,))
    if scope and scope['revision'] == version:
        return PDFProse(store, scope, version, blocks)
    return None
