"""Library-scoped URL execution, receipts and SQL-invisible bundle preparation."""
from __future__ import annotations

import fcntl
import os
from pathlib import Path
import stat
import threading
from typing import Callable, Generic, TypeVar
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, replace
import hashlib
import json
import math
import sqlite3
from uuid import UUID, uuid4

from .store import Store, _now
from .url_transport import Control, ImportFailure, normalize_url

T = TypeVar('T')


def _strict_json(data):
    def object_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('duplicate JSON key')
            value[key] = item
        return value

    def constant(value):
        raise ValueError('non-finite JSON value')

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('non-finite JSON number')
        return number

    return json.loads(data, object_pairs_hook=object_pairs, parse_constant=constant,
                      parse_float=finite_float)


def _validate_blocks(blocks, text, asset_ids):
    fields = {
        'paragraph': set(), 'heading': {'level'},
        'list-item': {'depth', 'ordered', 'ordinal'}, 'quote': set(), 'code': set(),
        'table-row': {'table_id', 'row', 'cells'}, 'image': {'asset_id'}, 'caption': set(),
    }
    base = {'id', 'type', 'text', 'start', 'end'}
    if type(blocks) is not list or not blocks or len(blocks) > 100000:
        raise ValueError('invalid blocks')
    ids, assets, tables, previous = set(), [], {}, 0
    last_table = None
    for block in blocks:
        if type(block) is not dict or type(block.get('type')) is not str or block['type'] not in fields:
            raise ValueError('invalid block kind')
        kind = block['type']
        required = base | fields[kind]
        if (not required <= set(block) or set(block) - required - {'links'}
                or type(block['id']) is not str or not 0 < len(block['id']) <= 128
                or block['id'] in ids or type(block['text']) is not str
                or type(block['start']) is not int or type(block['end']) is not int
                or not previous <= block['start'] <= block['end'] <= len(text)
                or text[previous:block['start']].strip('\n')
                or text[block['start']:block['end']] != block['text']):
            raise ValueError('invalid block reference')
        ids.add(block['id'])
        previous = block['end']
        if kind == 'heading' and (type(block['level']) is not int or not 1 <= block['level'] <= 6):
            raise ValueError('invalid heading')
        if kind == 'list-item' and (type(block['depth']) is not int or not 0 <= block['depth'] <= 64
                or type(block['ordered']) is not bool or type(block['ordinal']) is not int
                or not 0 <= block['ordinal'] <= 1100000):
            raise ValueError('invalid list item')
        if kind == 'image':
            if block['text'] or type(block['asset_id']) is not str or 'links' in block:
                raise ValueError('invalid image reference')
            assets.append(block['asset_id'])
        cells = None
        if kind == 'table-row':
            cells = block['cells']
            table = block['table_id']
            if (type(table) is not str or not 0 < len(table) <= 128
                    or type(block['row']) is not int or block['row'] < 0
                    or type(cells) is not list or not cells):
                raise ValueError('invalid table')
            index, width = tables.get(table, (0, len(cells)))
            if (block['row'] != index or len(cells) != width
                    or (index and last_table != table)):
                raise ValueError('invalid table sequence')
            position = 0
            for col, cell in enumerate(cells):
                if (type(cell) is not dict or set(cell) != {'text', 'start', 'end', 'header', 'scope'}
                        or type(cell['text']) is not str or type(cell['start']) is not int
                        or type(cell['end']) is not int or type(cell['header']) is not bool
                        or cell['start'] != position or cell['end'] != position + len(cell['text'])
                        or block['text'][cell['start']:cell['end']] != cell['text']
                        or (cell['scope'] is not None and type(cell['scope']) is not str)
                        or cell['scope'] not in (None, 'row', 'col')
                        or (not cell['header'] and cell['scope'] is not None)
                        or (cell['header'] and cell['scope'] is None)
                        or (cell['scope'] == 'row' and col != 0)
                        or (cell['scope'] == 'col' and index != 0)):
                    raise ValueError('invalid table cell')
                position = cell['end'] + 1
            if '\t'.join(cell['text'] for cell in cells) != block['text']:
                raise ValueError('unclosed table text')
            tables[table] = (index + 1, width)
            last_table = table
        else:
            last_table = None
        links = block.get('links', [])
        if type(links) is not list:
            raise ValueError('invalid links')
        end = 0
        for link in links:
            if (type(link) is not dict or set(link) != {'start', 'end', 'href'}
                    or type(link['start']) is not int or type(link['end']) is not int
                    or not end <= link['start'] < link['end'] <= len(block['text'])
                    or type(link['href']) is not str or normalize_url(link['href']).url != link['href']
                    or (cells is not None and not any(cell['start'] <= link['start'] < link['end'] <= cell['end'] for cell in cells))):
                raise ValueError('invalid link reference')
            end = link['end']
    if tuple(assets) != asset_ids or text[previous:].strip('\n'):
        raise ValueError('unclosed document')


class Execution(Generic[T]):
    def __init__(self, control: Control, operation: Callable[[], T]):
        self.control = control
        self._value: T | None = None
        self._error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, args=(operation,), name='url-import')

    def _run(self, operation: Callable[[], T]):
        try:
            self.control.remaining()
            self._value = operation()
            # A completed commit readback outranks a deadline that elapsed in COMMIT.
            # Unknown must also survive so the caller keeps the request for reconciliation.
            if not (isinstance(self._value, Receipt) and self._value.state in ('committed', 'unknown')):
                self.control.remaining()
        except BaseException as exc:
            self._error = exc

    def join(self, timeout: float | None = None) -> bool:
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def result(self) -> T:
        if self._thread.is_alive():
            raise ImportFailure('running')
        if self._error is not None:
            raise self._error
        return self._value  # type: ignore[return-value]


class ExecutionOwner:
    """Hold the library lock for life, and the slot until its thread has exited."""

    def __init__(self, library_directory: Path):
        self._mutex = threading.Lock()
        self._active: Execution | None = None
        self._pid = os.getpid()
        self._fd: int | None = None
        path = library_directory.resolve(strict=True) / '.url-import.lock'
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ImportFailure('unsafe_owner_lock')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ImportFailure('owner_busy') from exc
        except BaseException:
            os.close(fd)
            raise
        self._fd = fd

    def _check(self):
        if os.getpid() != self._pid:
            raise ImportFailure('owner_process_changed')
        if self._fd is None:
            raise ImportFailure('owner_closed')
        if self._active is not None:
            if self._active._thread.is_alive():
                raise ImportFailure('busy')
            self._active._thread.join()
            self._active = None

    def start(self, control: Control, operation: Callable[[], T]) -> Execution[T]:
        return self.start_execution(Execution(control, operation))

    def start_execution(self, execution: Execution[T]) -> Execution[T]:
        with self._mutex:
            self._check()
            execution.control.remaining()
            if execution._thread.ident is not None:
                raise ImportFailure('execution_already_started')
            self._active = execution
            try:
                execution._thread.start()
            except BaseException:
                self._active = None
                raise
            return execution

    def close(self):
        with self._mutex:
            if self._fd is None:
                return
            self._check()
            fd, self._fd = self._fd, None
            # Never unlink: another process must lock the same inode on reopen.
            os.close(fd)


@dataclass(frozen=True)
class Receipt:
    request_id: str
    state: str
    input_digest: str | None = None
    generation: str | None = None
    owner_epoch: str | None = None
    error_code: str | None = None
    doc_id: int | None = None
    snapshot_id: str | None = None
    cleanup_pending: bool = False
    reused: bool = False


@dataclass(frozen=True)
class Attempt:
    request_id: str
    input_digest: str
    generation: str
    owner_epoch: str
    control: Control


@dataclass(frozen=True)
class BeginResult:
    receipt: Receipt
    attempt: Attempt | None = None


@dataclass(frozen=True)
class SourceSnapshot:
    source_key: str
    snapshot_id: str
    extractor_version: str
    sanitizer_version: str
    metadata_json: bytes
    observation_json: bytes

    @classmethod
    def freeze(cls, prepared: dict, source_key: str, extractor_version: str,
               sanitizer_version: str, metadata_json: bytes, observation_json: bytes,
               assets: tuple[AssetBytes, ...]) -> tuple[SourceSnapshot, FrozenDocument]:
        document = FrozenDocument.from_engine(prepared, prepared['version'],
                                              tuple(asset.asset_id for asset in assets))
        source = cls(normalize_url(source_key).url, document.version, extractor_version,
                     sanitizer_version, metadata_json, observation_json)
        identity = source.identity(document, assets)
        document = FrozenDocument.from_engine(prepared, identity, document.asset_ids)
        source = replace(source, snapshot_id=identity)
        StageArea._validate(source, document, assets, b'')
        return source, document

    def identity(self, document: FrozenDocument,
                 assets: tuple[AssetBytes, ...] | tuple[StagedAsset, ...]) -> str:
        try:
            value = document.for_persistence()
            if type(self.metadata_json) is not bytes or len(self.metadata_json) > 65536:
                raise ValueError('invalid identity metadata')
            if (type(self.observation_json) is not bytes or len(self.observation_json) > 65536
                    or type(_strict_json(self.observation_json)) is not dict):
                raise ValueError('invalid observation JSON')
            metadata = _strict_json(self.metadata_json)
            if (type(metadata) is not dict or set(metadata) - {'author', 'published_at'}
                    or any(v is not None and (type(v) is not str or not v.strip()) for v in metadata.values())
                    or normalize_url(self.source_key).url != self.source_key
                    or type(assets) is not tuple or len(assets) > 10
                    or tuple(a.asset_id for a in assets) != document.asset_ids
                    or any(type(v) is not str or not v or len(v) > 128 for v in
                           (self.extractor_version, self.sanitizer_version))):
                raise ValueError('invalid identity input')
            ordered = []
            for asset in assets:
                if type(asset) is AssetBytes:
                    if type(asset.data) is not bytes or len(asset.data) > 5 * 1024 * 1024:
                        raise ValueError('invalid identity asset bytes')
                    digest, size = hashlib.sha256(asset.data).hexdigest(), len(asset.data)
                elif type(asset) is StagedAsset:
                    digest, size = asset.sha256, asset.byte_count
                else:
                    raise ValueError('invalid identity asset')
                if (type(digest) is not str or len(digest) != 64
                        or any(c not in '0123456789abcdef' for c in digest)
                        or type(size) is not int or not 0 <= size <= 5 * 1024 * 1024
                        or type(asset.width) is not int or type(asset.height) is not int
                        or asset.width <= 0 or asset.height <= 0 or asset.width * asset.height > 16000000
                        or asset.mime not in ('image/png', 'image/jpeg')):
                    raise ValueError('invalid identity asset')
                ordered.append(dict(sha256=digest, bytes=size, mime=asset.mime,
                                    width=asset.width, height=asset.height))
            blocks = json.loads(value['blocks'])
            # Local drawing URLs and generated names are not reading content.
            for block in blocks:
                block.pop('id', None)
                block.pop('asset_url', None)
                if block['type'] == 'image':
                    block['asset_id'] = document.asset_ids.index(block['asset_id'])
            semantic = dict(title=value['row']['title'], text=value['row']['text'],
                            blocks=blocks, metadata=metadata, assets=ordered)
            def canonical(data):
                return json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False,
                                  separators=(',', ':')).encode('utf-8')
            semantic_hash = hashlib.sha256(canonical(semantic)).hexdigest()
            envelope = dict(format='wise-reader-url-snapshot-1', source_key=self.source_key,
                            extractor_version=self.extractor_version, sanitizer_version=self.sanitizer_version,
                            semantic_sha256=semantic_hash, assets=ordered)
            return hashlib.sha256(canonical(envelope)).hexdigest()
        except (TypeError, ValueError, KeyError, AttributeError, RecursionError) as exc:
            raise ImportFailure('invalid_snapshot_identity') from exc


@dataclass(frozen=True)
class FrozenDocument:
    payload: bytes
    version: str
    asset_ids: tuple[str, ...]

    @classmethod
    def from_engine(cls, prepared: dict, version: str, asset_ids: tuple[str, ...]) -> FrozenDocument:
        try:
            if (type(prepared) is not dict or not {'row', 'version', 'blocks'} <= set(prepared)
                    or set(prepared) - {'row', 'version', 'blocks', 'analysis', 'cache_key'}):
                raise ValueError('invalid engine preparation schema')
            payload = json.dumps({'row': prepared['row'], 'version': version,
                                  'blocks': prepared['blocks']}, ensure_ascii=False,
                                 allow_nan=False, separators=(',', ':')).encode('utf-8')
            frozen = cls(payload, version, asset_ids)
            frozen.for_persistence()
            return frozen
        except (KeyError, TypeError, ValueError, RecursionError) as exc:
            raise ImportFailure('invalid_frozen_document') from exc

    def for_persistence(self) -> dict:
        from .engine import text_hash
        from .tokenize import parse

        try:
            if (type(self.payload) is not bytes or len(self.payload) > 32 * 1024 * 1024
                    or type(self.asset_ids) is not tuple or type(self.version) is not str
                    or len(self.version) != 64 or any(c not in '0123456789abcdef' for c in self.version)
                    or any(type(a) is not str or not a or len(a) > 128 for a in self.asset_ids)
                    or len(set(self.asset_ids)) != len(self.asset_ids)):
                raise ValueError('invalid frozen envelope')
            value = _strict_json(self.payload)
            if type(value) is not dict or set(value) != {'row', 'version', 'blocks'}:
                raise ValueError('invalid persistence schema')
            row = value['row']
            columns = {'title', 'text', 'word_count', 'text_hash', 'l0_json', 'l1_json', 'created_at'}
            if (type(row) is not dict or set(row) != columns or value['version'] != self.version
                    or any(type(row[k]) is not str for k in columns - {'word_count'})
                    or type(row['word_count']) is not int or not row['title'] or not row['created_at']
                    or not row['text'].strip() or len(row['text']) > 500000
                    or text_hash(row['text']) != row['text_hash']
                    or len(parse(row['text']).tokens) != row['word_count']
                    or type(value['blocks']) is not str):
                raise ValueError('invalid document row')
            for field in ('l0_json', 'l1_json'):
                annotations = _strict_json(row[field])
                columns = {'first_token', 'last_token', 'kind', 'note', 'surface', 'rarity',
                           'lemma', 'domain', 'detail', 'forced', 'suppressed', 'source'}
                if type(annotations) is not list:
                    raise ValueError('invalid annotations')
                for annotation in annotations:
                    if (type(annotation) is not dict or set(annotation) != columns
                            or type(annotation['first_token']) is not int
                            or type(annotation['last_token']) is not int
                            or not 0 <= annotation['first_token'] <= annotation['last_token'] < row['word_count']
                            or any(type(annotation[k]) is not str for k in
                                   ('kind', 'note', 'surface', 'lemma', 'detail', 'source'))
                            or annotation['kind'] not in ('word', 'phrase', 'grammar', 'culture')
                            or type(annotation['rarity']) is not int
                            or type(annotation['forced']) is not bool or type(annotation['suppressed']) is not bool
                            or (annotation['domain'] is not None and type(annotation['domain']) is not str)):
                        raise ValueError('invalid annotation')
            _validate_blocks(_strict_json(value['blocks']), row['text'], self.asset_ids)
            return value
        except (KeyError, TypeError, ValueError, RecursionError) as exc:
            raise ImportFailure('invalid_frozen_document') from exc


@dataclass(frozen=True)
class AssetBytes:
    asset_id: str
    data: bytes
    mime: str
    width: int
    height: int


@dataclass(frozen=True)
class StagedAsset:
    asset_id: str
    relative_name: str
    mime: str
    width: int
    height: int
    byte_count: int
    sha256: str


@dataclass(frozen=True)
class PreparedImport:
    source: SourceSnapshot
    document: FrozenDocument
    assets: tuple[StagedAsset, ...]
    sealed_stage_handle: str
    manifest_sha256: str


@dataclass(frozen=True)
class PublishedBundle:
    bundle_name: str
    manifest_sha256: str


class StageArea:
    """Private preparation files. Publication grants no SQL or reader visibility."""

    def __init__(self, library_directory: Path):
        self._mutex = threading.RLock()
        self._sealed: PreparedImport | None = None
        self._control: Control | None = None
        self._members: tuple[tuple[str, int, str], ...] = ()
        self._stage_inode: tuple[int, int] | None = None
        self._owned_stage: str | None = None
        self._planned_members: frozenset[str] = frozenset()
        self._publication_started = False
        self._fds: list[int] = []
        try:
            library = os.open(library_directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self._fds.append(library)
            self._root = self._directory(library, '.url-retained')
            self._stages = self._directory(self._root, '.staging')
            self._bundles = self._directory(self._root, 'bundles')
        except BaseException as original:
            try:
                self.close()
            except BaseException as cleanup:
                raise BaseExceptionGroup('stage initialization and cleanup failed', [original, cleanup]) from None
            raise

    def _directory(self, parent: int, name: str) -> int:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self._fds.append(fd)
        os.fsync(parent)
        return fd

    def close(self):
        with self._mutex:
            errors = []
            while self._fds:
                # A failed close may already have released the descriptor. Never retry it.
                fd = self._fds.pop()
                try:
                    os.close(fd)
                except BaseException as exc:
                    errors.append(exc)
            self._sealed = None
            if errors:
                raise BaseExceptionGroup('stage cleanup failed', errors)

    @staticmethod
    def _digest(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _validate(source: SourceSnapshot, document: FrozenDocument,
                  assets: tuple[AssetBytes, ...], raw_html: bytes):
        if (type(source) is not SourceSnapshot or type(document) is not FrozenDocument
                or type(assets) is not tuple or type(raw_html) is not bytes
                or type(document.payload) is not bytes or type(document.asset_ids) is not tuple
                or type(source.metadata_json) is not bytes or type(source.observation_json) is not bytes):
            raise ImportFailure('mutable_prepared_input')
        fields = (source.source_key, source.snapshot_id, source.extractor_version,
                  source.sanitizer_version, document.version, *document.asset_ids)
        if any(type(value) is not str for value in fields):
            raise ImportFailure('invalid_prepared_input')
        if (len(source.snapshot_id) != 64 or any(ch not in '0123456789abcdef' for ch in source.snapshot_id)
                or document.version != source.snapshot_id
                or normalize_url(source.source_key).url != source.source_key
                or not source.extractor_version or not source.sanitizer_version
                or len(source.extractor_version) > 128 or len(source.sanitizer_version) > 128):
            raise ImportFailure('invalid_snapshot')
        if (len(raw_html) > 5 * 1024 * 1024 or len(assets) > 10
                or len(document.payload) > 32 * 1024 * 1024
                or len(source.metadata_json) > 65536 or len(source.observation_json) > 65536):
            raise ImportFailure('stage_limit')
        ids = []
        total = len(raw_html)
        for asset in assets:
            if (type(asset) is not AssetBytes or type(asset.data) is not bytes
                    or type(asset.asset_id) is not str or not asset.asset_id
                    or len(asset.asset_id) > 128
                    or type(asset.width) is not int or type(asset.height) is not int
                    or asset.width <= 0 or asset.height <= 0 or asset.width * asset.height > 16000000
                    or asset.mime not in ('image/png', 'image/jpeg')
                    or len(asset.data) > 5 * 1024 * 1024):
                raise ImportFailure('invalid_staged_asset')
            ids.append(asset.asset_id)
            total += len(asset.data)
        if total > 20 * 1024 * 1024:
            raise ImportFailure('stage_limit')
        if len(set(ids)) != len(ids) or tuple(ids) != document.asset_ids:
            raise ImportFailure('asset_reference_mismatch')
        if source.identity(document, assets) != source.snapshot_id:
            raise ImportFailure('snapshot_identity_mismatch')

    @staticmethod
    def _write(fd: int, name: str, data: bytes, control: Control):
        member = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=fd)
        try:
            view = memoryview(data)
            while view:
                control.remaining()
                count = os.write(member, view[:65536])
                if count <= 0:
                    raise OSError('stage write made no progress')
                view = view[count:]
            control.remaining()
            os.fsync(member)
        finally:
            os.close(member)

    def prepare(self, source: SourceSnapshot, document: FrozenDocument,
                assets: tuple[AssetBytes, ...], raw_html: bytes, control: Control) -> PreparedImport:
        with self._mutex:
            control.remaining()
            if not self._fds:
                raise ImportFailure('stage_closed')
            if self._owned_stage is not None and not self._publication_started:
                raise ImportFailure('stage_busy')
            self._validate(source, document, assets, raw_html)
            nonce = uuid4().hex
            os.mkdir(nonce, 0o700, dir_fd=self._stages)
            fd = os.open(nonce, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self._stages)
            try:
                info = os.fstat(fd)
                self._owned_stage = nonce
                self._stage_inode = (info.st_dev, info.st_ino)
                self._control = control
                self._publication_started = False
                self._planned_members = frozenset()
                members = [('document.json', document.payload), ('raw.html.bin', raw_html)]
                staged = []
                for asset in assets:
                    name = uuid4().hex + ('.png' if asset.mime == 'image/png' else '.jpg')
                    members.append((name, asset.data))
                    staged.append(StagedAsset(asset.asset_id, name, asset.mime, asset.width,
                                              asset.height, len(asset.data), self._digest(asset.data)))
                manifest = json.dumps({
                    'format': 'url-bundle-1', 'source_key': source.source_key,
                    'snapshot_id': source.snapshot_id, 'extractor_version': source.extractor_version,
                    'sanitizer_version': source.sanitizer_version,
                    'metadata_hex': source.metadata_json.hex(), 'observation_hex': source.observation_json.hex(),
                    'asset_ids': document.asset_ids,
                    'assets': [vars(asset) for asset in staged],
                    'members': [{'name': name, 'bytes': len(data), 'sha256': self._digest(data)}
                                for name, data in members],
                }, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')
                members.append(('manifest.json', manifest))
                self._planned_members = frozenset(name for name, _ in members)
                for name, data in members:
                    self._write(fd, name, data, control)
                control.remaining()
                os.fsync(fd)
                os.fsync(self._stages)
                control.remaining()
                prepared = PreparedImport(source, document, tuple(staged), nonce, self._digest(manifest))
                self._members = tuple((name, len(data), self._digest(data)) for name, data in members)
                self._stage_inode = (info.st_dev, info.st_ino)
                self._control = control
                self._sealed = prepared
                return prepared
            finally:
                os.close(fd)

    def _verify(self, prepared: PreparedImport, control: Control):
        if not self._fds or prepared is not self._sealed:
            raise ImportFailure('stage_not_sealed')
        if control is not self._control:
            raise ImportFailure('stage_control_mismatch')
        fd = os.open(prepared.sealed_stage_handle, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                     dir_fd=self._stages)
        try:
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) != self._stage_inode:
                raise ImportFailure('stage_replaced')
            if set(os.listdir(fd)) != {name for name, _, _ in self._members}:
                raise ImportFailure('stage_members_mismatch')
            for name, size, expected in self._members:
                control.remaining()
                member = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    info = os.fstat(member)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != size:
                        raise ImportFailure('stage_member_invalid')
                    digest = hashlib.sha256()
                    left = size
                    while left:
                        control.remaining()
                        chunk = os.read(member, min(65536, left))
                        if not chunk:
                            raise ImportFailure('stage_truncated')
                        left -= len(chunk)
                        digest.update(chunk)
                    if os.read(member, 1) or digest.hexdigest() != expected:
                        raise ImportFailure('stage_hash_mismatch')
                finally:
                    os.close(member)
            control.remaining()
        finally:
            os.close(fd)

    def _publish(self, prepared: PreparedImport, control: Control) -> PublishedBundle:
        self._verify(prepared, control)
        name = uuid4().hex
        # Reserve an empty target exclusively; rename never replaces a previous bundle.
        os.mkdir(name, 0o700, dir_fd=self._bundles)
        control.remaining()
        self._sealed = None
        self._publication_started = True
        # A failed or lost rename reply leaves evidence for recovery, never a retry/delete.
        os.rename(prepared.sealed_stage_handle, name, src_dir_fd=self._stages, dst_dir_fd=self._bundles)
        os.fsync(self._bundles)
        os.fsync(self._stages)
        control.remaining()
        return PublishedBundle(name, prepared.manifest_sha256)

    def _discard_record(self, name: str, inode: tuple[int, int], members: frozenset[str]) -> bool:
        with self._mutex:
            if (type(name) is not str or len(name) != 32 or any(c not in '0123456789abcdef' for c in name)
                    or not 0 <= len(members) <= 13
                    or any(type(m) is not str or not m or m in ('.', '..') or '/' in m or '\\' in m
                           for m in members)):
                return False
            fd = None
            try:
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self._stages)
                except FileNotFoundError:
                    # rmdir may have succeeded before its parent fsync failed.
                    os.fsync(self._stages)
                    return True
                info = os.fstat(fd)
                if (info.st_dev, info.st_ino) != inode:
                    return False
                names = []
                with os.scandir(fd) as entries:
                    for entry in entries:
                        if entry.name not in members or len(names) >= 13:
                            return False
                        names.append(entry.name)
                for member_name in names:
                    member = os.stat(member_name, dir_fd=fd, follow_symlinks=False)
                    if not stat.S_ISREG(member.st_mode) or member.st_nlink != 1:
                        return False
                for member_name in names:
                    os.unlink(member_name, dir_fd=fd)
                os.fsync(fd)
                os.rmdir(name, dir_fd=self._stages)
                os.fsync(self._stages)
                return True
            except OSError:
                return False
            finally:
                if fd is not None:
                    os.close(fd)


class URLCommitter:
    """Receipt admission and SQL publication with independent persisted closure reads."""

    def __init__(self, store: Store):
        self.store = store
        self._gate = threading.RLock()
        self._attempt: Attempt | None = None
        self._execution: Execution | None = None
        self._execution_attempt: Attempt | None = None
        self._epoch = str(uuid4())
        self._recovery_ready = False
        self._stopping = False
        self._shutdown_lock = threading.Lock()
        self._owner = ExecutionOwner(store.path.parent)
        try:
            self.staging = StageArea(store.path.parent)
            with self._write_gate():
                with store.transaction():
                    store.execute('BEGIN IMMEDIATE')
                    identity_exists = store.query_one(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name='wr_url_library'") is not None
                    store.execute(
                        'CREATE TABLE IF NOT EXISTS wr_url_library ('
                        'singleton INTEGER PRIMARY KEY CHECK(singleton=1), library_id TEXT NOT NULL)')
                    if not identity_exists:
                        store.execute('INSERT INTO wr_url_library(singleton,library_id) VALUES(1,?)',
                                      (str(uuid4()),))
                    self._library_id = self._identity_row(store.query(
                        'SELECT singleton,library_id FROM wr_url_library LIMIT 2'))
                    store.execute(
                        "CREATE TABLE IF NOT EXISTS wr_url_request ("
                        "request_id TEXT PRIMARY KEY, input_digest TEXT, original_url TEXT, "
                        "generation TEXT NOT NULL, owner_epoch TEXT NOT NULL, "
                        "state TEXT NOT NULL CHECK(state IN "
                        "('running','committed','failed','cancelled','interrupted')), "
                        "doc_id INTEGER, snapshot_id TEXT, error_code TEXT, "
                        "created_at TEXT NOT NULL, completed_at TEXT)"
                    )
                    store.execute(
                        "CREATE TABLE IF NOT EXISTS wr_url_snapshot (snapshot_id TEXT PRIMARY KEY, "
                        "source_key TEXT NOT NULL, doc_id INTEGER UNIQUE, bundle_name TEXT NOT NULL UNIQUE, "
                        "manifest_hash TEXT NOT NULL, extractor_version TEXT NOT NULL, sanitizer_version TEXT NOT NULL, "
                        "metadata_json BLOB NOT NULL, availability TEXT NOT NULL "
                        "CHECK(availability IN ('ready','unavailable','deleted')))"
                    )
                    store.execute(
                        "CREATE TABLE IF NOT EXISTS wr_url_asset (snapshot_id TEXT NOT NULL, asset_id TEXT NOT NULL, "
                        "relative_name TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, "
                        "byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(snapshot_id,asset_id), "
                        "UNIQUE(snapshot_id,relative_name))"
                    )
                    store.execute(
                        "CREATE TABLE IF NOT EXISTS wr_url_observation (request_id TEXT PRIMARY KEY, "
                        "snapshot_id TEXT NOT NULL, original_url TEXT NOT NULL, final_url TEXT NOT NULL, "
                        "fetched_at TEXT NOT NULL, raw_html_hash TEXT NOT NULL, observation_json BLOB NOT NULL, "
                        "bundle_name TEXT NOT NULL)"
                    )
                    if 'manifest_hash' not in {r['name'] for r in store.query('PRAGMA table_info(wr_url_observation)')}:
                        store.execute('ALTER TABLE wr_url_observation ADD COLUMN manifest_hash TEXT')
                    if 'removed_docs' not in {r['name'] for r in store.query('PRAGMA table_info(wr_url_snapshot)')}:
                        store.execute("ALTER TABLE wr_url_snapshot ADD COLUMN removed_docs TEXT NOT NULL DEFAULT '[]'")
                        deleted = store.query("SELECT * FROM wr_url_snapshot WHERE availability='deleted' LIMIT 257")
                        if len(deleted) > 256:
                            raise ImportFailure('removed_history_migration_unconfirmed')
                        for snapshot in deleted:
                            history = store.query(
                                "SELECT DISTINCT doc_id FROM wr_url_request WHERE snapshot_id=? "
                                "AND state='committed' ORDER BY doc_id LIMIT 257", (snapshot['snapshot_id'],))
                            ids = [row['doc_id'] for row in history]
                            if (snapshot['doc_id'] is not None or not ids or len(ids) > 256
                                    or any(type(i) is not int or i <= 0 or store.get_document(i) is not None for i in ids)):
                                raise ImportFailure('removed_history_migration_unconfirmed')
                            serialized = json.dumps(ids)
                            changed = store.execute(
                                'UPDATE wr_url_snapshot SET removed_docs=? WHERE snapshot_id=?',
                                (serialized, snapshot['snapshot_id']))
                            if (changed.rowcount != 1 or store.query_one(
                                    'SELECT removed_docs FROM wr_url_snapshot WHERE snapshot_id=?',
                                    (snapshot['snapshot_id'],)) != {'removed_docs': serialized}):
                                raise ImportFailure('removed_history_migration_unconfirmed')
                    store.execute(
                        'CREATE TABLE IF NOT EXISTS wr_url_cleanup ('
                        'request_id TEXT PRIMARY KEY, generation TEXT NOT NULL, stage_name TEXT NOT NULL UNIQUE, '
                        'device INTEGER NOT NULL, inode INTEGER NOT NULL, members_json TEXT NOT NULL)'
                    )
                # Recovery never grants an execution right to a previous process.
                with store.transaction():
                    store.execute(
                        "UPDATE wr_url_request SET state='interrupted', "
                        "error_code='owner_interrupted',completed_at=? WHERE state='running'",
                        (_now(),),
                    )
            self.identity()
            self._recover_cleanup()
        except BaseException as original:
            errors = [original]
            if hasattr(self, 'staging'):
                try:
                    self.staging.close()
                except BaseException as exc:
                    errors.append(exc)
            try:
                self._owner.close()
            except BaseException as exc:
                errors.append(exc)
            if len(errors) > 1:
                raise BaseExceptionGroup('URL initialization and cleanup failed', errors) from None
            raise

    @staticmethod
    def _identity_row(rows) -> str:
        if len(rows) != 1 or rows[0]['singleton'] != 1:
            raise ImportFailure('library_identity_unavailable')
        value = rows[0]['library_id']
        try:
            if not isinstance(value, str) or str(UUID(value)) != value:
                raise ValueError('invalid library identity')
        except (ValueError, TypeError, AttributeError) as exc:
            raise ImportFailure('library_identity_unavailable') from exc
        return value

    def identity(self) -> str:
        """Read the business identity, never infer it from a path or evidence DB."""
        with self._gate:
            self._lifetime()
            con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            try:
                con.row_factory = sqlite3.Row
                value = self._identity_row(con.execute(
                    'SELECT singleton,library_id FROM wr_url_library LIMIT 2').fetchall())
                if value != self._library_id:
                    raise ImportFailure('library_identity_changed')
                return value
            finally:
                con.close()

    @contextmanager
    def _write_gate(self):
        with self._gate, self.store._lock:
            self._lifetime()
            if self.store._depth or self.store._con.in_transaction:
                raise ImportFailure('nested_url_transaction')
            yield

    def _lifetime(self):
        if self._owner._pid != os.getpid():
            raise ImportFailure('owner_process_changed')
        if self._owner._fd is None:
            raise ImportFailure('owner_closed')

    @staticmethod
    def _request_id(value: str) -> str:
        try:
            if str(UUID(value)) != value:
                raise ValueError('noncanonical UUID')
        except (ValueError, TypeError, AttributeError) as exc:
            raise ImportFailure('invalid_request_id') from exc
        return value

    @staticmethod
    def _read_member(directory: int, name: str, limit: int) -> bytes:
        if type(name) is not str or not name or name in ('.', '..') or '/' in name or '\\' in name:
            raise ValueError('unsafe bundle member')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
                raise ValueError('invalid bundle member')
            chunks, size = [], 0
            while size <= limit:
                chunk = os.read(fd, min(65536, limit + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            after = os.fstat(fd)
            if (size > limit or size != before.st_size
                    or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                raise ValueError('bundle member changed')
            return b''.join(chunks)
        finally:
            os.close(fd)

    def _read_bundle(self, snapshot: dict) -> tuple[dict, dict[str, bytes]]:
        import errno

        name = snapshot['bundle_name']
        if type(name) is not str or len(name) != 32 or any(c not in '0123456789abcdef' for c in name):
            raise ValueError('invalid bundle name')
        fds = []
        try:
            fd = os.open(self.store.path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            fds.append(fd)
            for part in ('.url-retained', 'bundles', name):
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                fds.append(fd)
            raw = self._read_member(fd, 'manifest.json', 512 * 1024)
            if hashlib.sha256(raw).hexdigest() != snapshot['manifest_hash']:
                raise ValueError('manifest hash mismatch')
            manifest = json.loads(raw)
            if (type(manifest) is not dict or manifest.get('format') != 'url-bundle-1'
                    or type(manifest.get('members')) is not list or not 2 <= len(manifest['members']) <= 12
                    or type(manifest.get('assets')) is not list or len(manifest['assets']) > 10
                    or type(manifest.get('asset_ids')) is not list):
                raise ValueError('invalid manifest')
            members = {}
            total = 0
            for item in manifest['members']:
                if type(item) is not dict or set(item) != {'name', 'bytes', 'sha256'}:
                    raise ValueError('invalid member record')
                member = item['name']
                if type(member) is not str or member in members or member == 'manifest.json':
                    raise ValueError('duplicate member')
                cap = 32 * 1024 * 1024 if member == 'document.json' else 5 * 1024 * 1024
                if type(item['bytes']) is not int or not 0 <= item['bytes'] <= cap:
                    raise ValueError('invalid member length')
                data = self._read_member(fd, member, item['bytes'])
                if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise ValueError('member hash mismatch')
                members[member] = data
                if member != 'document.json':
                    total += len(data)
            if total > 20 * 1024 * 1024 or set(os.listdir(fd)) != set(members) | {'manifest.json'}:
                raise ValueError('bundle membership mismatch')
            return manifest, members
        except OSError as exc:
            if exc.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                raise ValueError('bundle missing or unsafe') from exc
            raise
        finally:
            for fd in reversed(fds):
                os.close(fd)

    @staticmethod
    def _removed_docs(snapshot: dict) -> list[int]:
        raw = snapshot['removed_docs']
        if type(raw) is not str or len(raw) > 8192:
            raise ValueError('invalid removed document history')
        ids = json.loads(raw)
        if (type(ids) is not list or len(ids) > 256
                or any(type(i) is not int or i <= 0 for i in ids) or len(set(ids)) != len(ids)):
            raise ValueError('invalid removed document history')
        return ids

    def _committed_status(self, con: sqlite3.Connection, row: sqlite3.Row, *, retained=False) -> Receipt:
        return self._read_committed(con, row, retained=retained)[0]

    def _read_committed(self, con: sqlite3.Connection, row: sqlite3.Row, *, retained=False
                        ) -> tuple[Receipt, tuple[AssetBytes, ...]]:
        def receipt(state, code=None, doc_id=None, snapshot_id=None, reused=False):
            return (Receipt(row['request_id'], state, row['input_digest'], row['generation'],
                            row['owner_epoch'], code, doc_id, snapshot_id, reused=reused), ())

        def one(table, key, value):
            found = con.execute(f'SELECT * FROM {table} WHERE {key}=?', (value,)).fetchone()
            return dict(found) if found is not None else None

        try:
            snapshot = one('wr_url_snapshot', 'snapshot_id', row['snapshot_id'])
            if snapshot is None:
                raise ValueError('missing snapshot')
            removed = (row['doc_id'] in self._removed_docs(snapshot)
                       or (snapshot['availability'] == 'deleted' and snapshot['doc_id'] is None))
            if removed:
                if one('document', 'id', row['doc_id']) is not None:
                    raise ValueError('deleted marker with live document')
                if not retained:
                    return receipt('source_removed', 'source_removed')
            if ((not removed and snapshot['doc_id'] != row['doc_id'])
                    or snapshot['availability'] not in (('ready', 'deleted') if removed else ('ready',))):
                raise ValueError('snapshot not available')
            document = one('document', 'id', row['doc_id'])
            content = one('wr_content', 'doc_id', row['doc_id'])
            observation = one('wr_url_observation', 'request_id', row['request_id'])
            assets = [dict(a) for a in con.execute(
                'SELECT * FROM wr_url_asset WHERE snapshot_id=? ORDER BY asset_id', (row['snapshot_id'],))]
            if (not removed and (document is None or content is None)) or observation is None:
                raise ValueError('missing committed relation')
            manifest, members = self._read_bundle(snapshot)
            if any(manifest[key] != snapshot[key] for key in
                   ('snapshot_id', 'source_key', 'extractor_version', 'sanitizer_version')):
                raise ValueError('manifest source mismatch')
            if bytes.fromhex(manifest['metadata_hex']) != snapshot['metadata_json']:
                raise ValueError('manifest metadata mismatch')
            ids = tuple(manifest['asset_ids'])
            frozen = FrozenDocument(members['document.json'], snapshot['snapshot_id'], ids)
            prepared = frozen.for_persistence()
            if not removed and (document != {'id': row['doc_id'], **prepared['row']}
                    or content != {'doc_id': row['doc_id'], 'version': snapshot['snapshot_id'],
                                   'blocks': prepared['blocks']}):
                raise ValueError('document mismatch')
            expected_assets = [dict(snapshot_id=snapshot['snapshot_id'], **a) for a in manifest['assets']]
            if (assets != sorted(expected_assets, key=lambda a: a['asset_id'])
                    or tuple(a['asset_id'] for a in manifest['assets']) != ids
                    or set(members) != {'document.json', 'raw.html.bin'} | {a['relative_name'] for a in assets}):
                raise ValueError('asset relation mismatch')
            for asset in assets:
                data = members[asset['relative_name']]
                if (asset['mime'] not in ('image/png', 'image/jpeg')
                        or type(asset['width']) is not int or type(asset['height']) is not int
                        or asset['width'] <= 0 or asset['height'] <= 0
                        or asset['width'] * asset['height'] > 16000000
                        or asset['byte_count'] != len(data) or asset['sha256'] != hashlib.sha256(data).hexdigest()):
                    raise ValueError('asset content mismatch')
            observed = json.loads(observation['observation_json'])
            source = SourceSnapshot(snapshot['source_key'], snapshot['snapshot_id'],
                                    snapshot['extractor_version'], snapshot['sanitizer_version'],
                                    snapshot['metadata_json'], observation['observation_json'])
            staged = tuple(StagedAsset(**a) for a in manifest['assets'])
            if source.identity(frozen, staged) != source.snapshot_id:
                raise ValueError('snapshot identity mismatch')
            reused = observation['bundle_name'] != snapshot['bundle_name']
            observation_hash = observation['manifest_hash']
            if not reused and observation_hash is None:
                observation_hash = snapshot['manifest_hash']
            if not reused:
                if observation_hash != snapshot['manifest_hash']:
                    raise ValueError('observation manifest hash mismatch')
                observed_manifest, observed_members = manifest, members
            else:
                observed_manifest, observed_members = self._read_bundle(dict(
                    bundle_name=observation['bundle_name'], manifest_hash=observation_hash))
            if (any(observed_manifest[key] != snapshot[key] for key in
                    ('snapshot_id', 'source_key', 'extractor_version', 'sanitizer_version'))
                    or bytes.fromhex(observed_manifest['observation_hex']) != observation['observation_json']):
                raise ValueError('observed manifest mismatch')
            observed_assets = tuple(StagedAsset(**a) for a in observed_manifest['assets'])
            if set(observed_members) != {'document.json', 'raw.html.bin'} | {a.relative_name for a in observed_assets}:
                raise ValueError('observed bundle membership mismatch')
            for asset in observed_assets:
                data = observed_members[asset.relative_name]
                if len(data) != asset.byte_count or hashlib.sha256(data).hexdigest() != asset.sha256:
                    raise ValueError('observed asset mismatch')
            observed_document = FrozenDocument(observed_members['document.json'], snapshot['snapshot_id'],
                                               tuple(observed_manifest['asset_ids']))
            observed_source = replace(source, metadata_json=bytes.fromhex(observed_manifest['metadata_hex']))
            if observed_source.identity(observed_document, observed_assets) != snapshot['snapshot_id']:
                raise ValueError('observed semantic identity mismatch')
            if (type(observed) is not dict or not row['completed_at']
                    or observation['snapshot_id'] != snapshot['snapshot_id']
                    or observation['original_url'] != row['original_url']
                    or normalize_url(observation['final_url']).url != snapshot['source_key']
                    or hashlib.sha256(normalize_url(row['original_url']).url.encode()).hexdigest() != row['input_digest']
                    or observation['raw_html_hash'] != hashlib.sha256(observed_members['raw.html.bin']).hexdigest()
                    or any(observed[key] != observation[column] for key, column in
                           (('original_url', 'original_url'), ('final_url', 'final_url'),
                            ('fetched_at', 'fetched_at'), ('raw_html_sha256', 'raw_html_hash')))):
                raise ValueError('observation mismatch')
            if removed:
                return receipt('source_removed', 'source_removed')
            result, _ = receipt('committed', doc_id=row['doc_id'], snapshot_id=row['snapshot_id'], reused=reused)
            return result, tuple(AssetBytes(a['asset_id'], members[a['relative_name']],
                                            a['mime'], a['width'], a['height']) for a in assets)
        except (KeyError, TypeError, ValueError, RecursionError, ImportFailure):
            return receipt('unavailable', 'closure_invalid')

    @staticmethod
    @contextmanager
    def document_access(store: Store, doc_id: int, committer: URLCommitter | None):
        """Hold the local publication/delete locks through the caller's presentation."""
        if type(doc_id) is not int or doc_id <= 0:
            raise ImportFailure('invalid_document_id')
        if committer is not None and committer.store is not store:
            raise ImportFailure('unknown')
        with committer._gate if committer is not None else nullcontext():
            with store._lock:
                info = URLCommitter._document_info(store, doc_id, committer)
                yield info

    @staticmethod
    def _document_info(store: Store, doc_id: int, committer: URLCommitter | None) -> dict | None:
        unknown = {'availability': 'unknown', 'source': None}
        try:
            con = sqlite3.connect(store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            try:
                con.row_factory = sqlite3.Row
                con.execute('BEGIN')
                tables = {r[0] for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wr_url_%'")}
                if not tables:
                    return None
                if not {'wr_url_snapshot', 'wr_url_request', 'wr_url_observation', 'wr_url_asset'} <= tables:
                    return unknown
                snapshot = con.execute('SELECT * FROM wr_url_snapshot WHERE doc_id=?', (doc_id,)).fetchone()
                row = con.execute(
                    "SELECT * FROM wr_url_request WHERE doc_id=? AND state='committed' "
                    'ORDER BY completed_at,request_id LIMIT 1', (doc_id,)).fetchone()
                if snapshot is None and row is None:
                    return None
                if committer is None:
                    return unknown
                committer._lifetime()
                if row is None:
                    return {'availability': 'unavailable', 'source': None}
                receipt = committer._committed_status(con, row)
                if receipt.state != 'committed':
                    return {'availability': receipt.state, 'source': None}
                if snapshot is None or snapshot['snapshot_id'] != receipt.snapshot_id:
                    return {'availability': 'unavailable', 'source': None}
                # The first retained observation, not the latest repeated import, owns source metadata.
                manifest, _ = committer._read_bundle(dict(snapshot))
                observed = _strict_json(bytes.fromhex(manifest['observation_hex']))
                metadata = _strict_json(snapshot['metadata_json'])
                original = observed['original_url']
                final = observed['final_url']
                normalize_url(original)
                if normalize_url(final).url != snapshot['source_key']:
                    raise ValueError('source mismatch')
                return {'availability': 'ready', 'source': {
                    'snapshot_id': receipt.snapshot_id,
                    'original_url': original, 'final_url': final,
                    'fetched_at': observed['fetched_at'],
                    'author': metadata.get('author'), 'published_at': metadata.get('published_at'),
                }}
            finally:
                con.close()
        except (sqlite3.Error, OSError, ImportFailure):
            return unknown
        except (KeyError, ValueError, TypeError, RecursionError):
            return {'availability': 'unavailable', 'source': None}

    def read_asset(self, snapshot_id: str, asset_id: str) -> AssetBytes:
        """Return verified retained bytes; identifiers never become filesystem paths."""
        if (type(snapshot_id) is not str or len(snapshot_id) != 64
                or any(c not in '0123456789abcdef' for c in snapshot_id)):
            raise ImportFailure('invalid_snapshot_id')
        if type(asset_id) is not str or not asset_id or len(asset_id) > 128:
            raise ImportFailure('invalid_asset_id')
        self._lifetime()
        try:
            con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            try:
                con.row_factory = sqlite3.Row
                con.execute('BEGIN')
                snapshot = con.execute('SELECT * FROM wr_url_snapshot WHERE snapshot_id=?',
                                       (snapshot_id,)).fetchone()
                if snapshot is None:
                    raise ImportFailure('not_found')
                if snapshot['availability'] != 'ready' or snapshot['doc_id'] is None:
                    raise ImportFailure('unavailable')
                row = con.execute(
                    "SELECT * FROM wr_url_request WHERE snapshot_id=? AND doc_id=? "
                    "AND state='committed' ORDER BY request_id LIMIT 1",
                    (snapshot_id, snapshot['doc_id'])).fetchone()
                if row is None:
                    raise ImportFailure('unavailable')
                receipt, assets = self._read_committed(con, row)
                if receipt.state != 'committed':
                    raise ImportFailure('unavailable')
                for asset in assets:
                    if asset.asset_id == asset_id:
                        return asset
                raise ImportFailure('not_found')
            finally:
                con.close()
        except (sqlite3.Error, OSError) as exc:
            raise ImportFailure('unknown') from exc

    def status(self, request_id: str) -> Receipt:
        request_id = self._request_id(request_id)
        self._lifetime()
        row = None
        try:
            # All relations share one independent SQLite read snapshot, never the writer's transaction.
            con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            try:
                con.row_factory = sqlite3.Row
                con.execute('BEGIN')
                row = con.execute('SELECT * FROM wr_url_request WHERE request_id=?', (request_id,)).fetchone()
                if row is None:
                    return Receipt(request_id, 'not_found')
                if row['state'] == 'committed':
                    return self._committed_status(con, row)
                pending = con.execute('SELECT 1 FROM wr_url_cleanup WHERE request_id=?', (request_id,)).fetchone()
                return Receipt(request_id, row['state'], row['input_digest'], row['generation'],
                               row['owner_epoch'], row['error_code'], cleanup_pending=pending is not None)
            finally:
                con.close()
        except (sqlite3.Error, OSError):
            return Receipt(request_id, 'unknown', row['input_digest'] if row else None,
                           row['generation'] if row else None, row['owner_epoch'] if row else None,
                           'closure_read_failed')

    def begin(self, request_id: str, url: str, control: Control) -> BeginResult:
        request_id = self._request_id(request_id)
        digest = hashlib.sha256(normalize_url(url).url.encode('utf-8')).hexdigest()
        with self._write_gate():
            if self._stopping:
                raise ImportFailure('stopping')
            current = self.status(request_id)
            if current.state != 'not_found':
                if current.input_digest is not None and current.input_digest != digest:
                    raise ImportFailure('request_conflict')
                return BeginResult(current)
            if not self._recovery_ready:
                raise ImportFailure('recovery_incomplete')
            self._owner._check()
            # A cancelled worker may still own the slot; _check above must run first.
            if self.store.query_one("SELECT request_id FROM wr_url_request WHERE state='running' LIMIT 1"):
                raise ImportFailure('busy')
            control.remaining()
            attempt = Attempt(request_id, digest, str(uuid4()), self._epoch, control)
            try:
                with self.store.transaction():
                    self.store.execute(
                        'INSERT INTO wr_url_request '
                        '(request_id,input_digest,original_url,generation,owner_epoch,state,created_at) '
                        "VALUES(?,?,?,?,?,'running',?)",
                        (request_id, digest, url, attempt.generation, self._epoch, _now()),
                    )
            except (sqlite3.Error, OSError):
                result = self.status(request_id)
                if result.state == 'not_found':
                    result = Receipt(request_id, 'unknown', error_code='receipt_write_failed')
                return BeginResult(result)
            result = self.status(request_id)
            if (result.state != 'running' or result.generation != attempt.generation
                    or result.input_digest != digest or result.owner_epoch != self._epoch):
                return BeginResult(Receipt(request_id, 'unknown', error_code='receipt_unconfirmed'))
            self._attempt = attempt
            self._execution = None
            return BeginResult(result, attempt)

    def check_attempt(self, attempt: Attempt):
        """Check preparation authority; future commit must recheck under this gate."""
        with self._gate:
            self._lifetime()
            if attempt is not self._attempt:
                raise ImportFailure('stale_attempt')
            attempt.control.remaining()
            current = self.status(attempt.request_id)
            if (current.state != 'running' or current.generation != attempt.generation
                    or current.owner_epoch != self._epoch
                    or current.input_digest != attempt.input_digest):
                raise ImportFailure('attempt_unconfirmed')

    def start(self, attempt: Attempt, execution: Execution[T]) -> Execution[T]:
        with self._gate:
            if self._stopping:
                raise ImportFailure('stopping')
            self.check_attempt(attempt)
            if self._execution is not None:
                raise ImportFailure('attempt_already_started')
            if execution.control is not attempt.control:
                raise ImportFailure('execution_control_mismatch')
            self._owner.start_execution(execution)
            self._execution = execution
            self._execution_attempt = attempt
            return execution

    def cancel(self, request_id: str) -> Receipt:
        request_id = self._request_id(request_id)
        with self._write_gate():
            current = self.status(request_id)
            if current.state not in ('not_found', 'running'):
                return current
            try:
                with self.store.transaction():
                    if current.state == 'not_found':
                        self.store.execute(
                            'INSERT INTO wr_url_request '
                            '(request_id,generation,owner_epoch,state,error_code,created_at,completed_at) '
                            "VALUES(?,?,?,'cancelled','cancelled',?,?)",
                            (request_id, str(uuid4()), self._epoch, _now(), _now()),
                        )
                    else:
                        self.store.execute(
                            "UPDATE wr_url_request SET state='cancelled',error_code='cancelled',completed_at=? "
                            "WHERE request_id=? AND state='running'", (_now(), request_id),
                        )
            except (sqlite3.Error, OSError):
                result = self.status(request_id)
                if result.state in ('not_found', 'running'):
                    result = Receipt(request_id, 'unknown', error_code='cancel_unconfirmed')
            else:
                result = self.status(request_id)
            if result.state == 'cancelled' and self._attempt is not None:
                if self._attempt.request_id == request_id:
                    self._attempt.control.cancel()
                    self._attempt = None
            return result

    def execute(self, attempt: Attempt, execution: Execution) -> Receipt:
        self.start(attempt, execution)
        execution.join()
        return self.finish(attempt, execution)

    def finish(self, attempt: Attempt, execution: Execution) -> Receipt:
        """Reconcile an exited execution; never infer rollback from an exception."""
        with self._gate:
            self._lifetime()
            if (execution is not self._execution or attempt is not self._execution_attempt
                    or execution.control is not attempt.control):
                raise ImportFailure('execution_mismatch')
            if execution._thread.is_alive():
                raise ImportFailure('running')
            current = self.status(attempt.request_id)
            if current.state == 'unknown':
                return current
            if (current.generation != attempt.generation or current.owner_epoch != attempt.owner_epoch
                    or current.input_digest != attempt.input_digest):
                raise ImportFailure('stale_attempt')
            if current.state == 'running':
                if self.staging._control is attempt.control and self.staging._publication_started:
                    return Receipt(attempt.request_id, 'unknown', error_code='commit_unconfirmed')
                try:
                    value = execution.result()
                except Exception as exc:
                    code = exc.code if isinstance(exc, ImportFailure) else type(exc).__name__
                    code = code[:128]
                else:
                    # A prepared value is not a failed import, and unknown is never a retry right.
                    return value if isinstance(value, Receipt) and value.state == 'unknown' else current
                try:
                    with self._write_gate():
                        with self.store.transaction():
                            changed = self.store.execute(
                                "UPDATE wr_url_request SET state='failed',error_code=?,completed_at=? "
                                "WHERE request_id=? AND state='running' AND generation=? AND owner_epoch=? "
                                "AND doc_id IS NULL AND snapshot_id IS NULL",
                                (code, _now(), attempt.request_id, attempt.generation, attempt.owner_epoch))
                            if changed.rowcount != 1:
                                raise sqlite3.IntegrityError('failure transition not written')
                except (sqlite3.Error, OSError):
                    pass
                current = self.status(attempt.request_id)
                if current.state in ('running', 'not_found'):
                    return Receipt(attempt.request_id, 'unknown', error_code='failure_unconfirmed')
            if current.state in ('failed', 'cancelled'):
                try:
                    con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
                    try:
                        con.execute('BEGIN')
                        row = con.execute(
                            'SELECT state,doc_id,snapshot_id FROM wr_url_request WHERE request_id=?',
                            (attempt.request_id,)).fetchone()
                        referenced = con.execute(
                            'SELECT 1 FROM wr_url_observation WHERE request_id=? OR bundle_name=? '
                            'UNION ALL SELECT 1 FROM wr_url_snapshot WHERE bundle_name=? LIMIT 1',
                            (attempt.request_id, self.staging._owned_stage, self.staging._owned_stage)).fetchone()
                        safe = row == (current.state, None, None) and referenced is None
                    finally:
                        con.close()
                except (sqlite3.Error, OSError):
                    safe = False
                if not safe:
                    return replace(current, cleanup_pending=True)
                stage = self.staging
                if stage._owned_stage is None or stage._control is not attempt.control:
                    return current
                if stage._publication_started or stage._stage_inode is None:
                    return replace(current, cleanup_pending=True)
                record = (attempt.request_id, attempt.generation, stage._owned_stage,
                          *stage._stage_inode, json.dumps(sorted(stage._planned_members)))
                try:
                    with self._write_gate(), self.store.transaction():
                        self.store.execute('INSERT OR IGNORE INTO wr_url_cleanup VALUES(?,?,?,?,?,?)', record)
                except (sqlite3.Error, OSError):
                    pass
                cleaned = self._cleanup_record(record)
                if cleaned:
                    stage._owned_stage = None
                    stage._sealed = None
                    stage._members = ()
                else:
                    self._recovery_ready = False
                return replace(current, cleanup_pending=not cleaned)
            return current

    def _cleanup_record(self, record: tuple) -> bool:
        try:
            request, generation, name, device, inode, raw_members = record
            if type(raw_members) is not str or len(raw_members) > 4096:
                return False
            members = json.loads(raw_members)
            if (type(members) is not list or len(members) > 13
                    or any(type(m) is not str for m in members)
                    or len(set(members)) != len(members)
                    or type(device) is not int or type(inode) is not int):
                return False
            con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            try:
                con.execute('BEGIN')
                persisted = con.execute('SELECT * FROM wr_url_cleanup WHERE request_id=?', (request,)).fetchone()
                receipt = con.execute('SELECT state,generation,doc_id,snapshot_id FROM wr_url_request '
                                      'WHERE request_id=?', (request,)).fetchone()
                referenced = con.execute(
                    'SELECT 1 FROM wr_url_observation WHERE request_id=? OR bundle_name=? '
                    'UNION ALL SELECT 1 FROM wr_url_snapshot WHERE bundle_name=? LIMIT 1',
                    (request, name, name)).fetchone()
                if (persisted != record or receipt is None or receipt[0] not in ('failed', 'cancelled')
                        or receipt[1:] != (generation, None, None) or referenced is not None):
                    return False
            finally:
                con.close()
            if not self.staging._discard_record(name, (device, inode), frozenset(members)):
                return False
            with self._write_gate(), self.store.transaction():
                changed = self.store.execute('DELETE FROM wr_url_cleanup WHERE request_id=? AND generation=? '
                                             'AND stage_name=? AND device=? AND inode=? AND members_json=?', record)
                if changed.rowcount != 1:
                    raise sqlite3.IntegrityError('cleanup completion not written')
            # A lost completion reply is still pending, safe for idempotent restart.
            con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            try:
                return con.execute('SELECT 1 FROM wr_url_cleanup WHERE request_id=?', (request,)).fetchone() is None
            finally:
                con.close()
        except (sqlite3.Error, OSError, ValueError, TypeError):
            return False

    def _recover_cleanup(self):
        # Only journaled, definitely unpublished failures are reclaimable here.
        with self._gate:
            try:
                con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
                try:
                    records = con.execute('SELECT * FROM wr_url_cleanup ORDER BY request_id LIMIT 65').fetchall()
                    running = con.execute("SELECT 1 FROM wr_url_request WHERE state='running' LIMIT 1").fetchone()
                finally:
                    con.close()
                if len(records) > 64 or running is not None:
                    return
                ready = True
                for record in records:
                    if not self._cleanup_record(record):
                        ready = False
                self._recovery_ready = (ready and self._retained_inventory_ready()
                                        and self._recover_snapshot_integrity())
            except (sqlite3.Error, OSError):
                self._recovery_ready = False

    def _recover_snapshot_integrity(self) -> bool:
        damaged = {}
        complete = True
        try:
            con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            try:
                con.row_factory = sqlite3.Row
                con.execute('BEGIN')
                requests = con.execute(
                    "SELECT * FROM wr_url_request WHERE state='committed' LIMIT 257").fetchall()
                if len(requests) > 256:
                    return False
                for row in requests:
                    result = self._committed_status(con, row, retained=True)
                    if result.state == 'unavailable':
                        complete = False
                        snapshot = con.execute('SELECT * FROM wr_url_snapshot WHERE snapshot_id=?',
                                               (row['snapshot_id'],)).fetchone()
                        if snapshot is not None and snapshot['availability'] == 'ready':
                            damaged[row['snapshot_id']] = dict(snapshot)
                    elif result.state not in ('committed', 'source_removed'):
                        return False
            finally:
                con.close()
            # No file I/O in the write transaction; only classify the exact row we inspected.
            if damaged:
                with self._write_gate(), self.store.transaction():
                    for snapshot_id, snapshot in damaged.items():
                        if self.store.query_one('SELECT * FROM wr_url_snapshot WHERE snapshot_id=?',
                                                (snapshot_id,)) != snapshot:
                            raise sqlite3.IntegrityError('snapshot changed during recovery')
                        changed = self.store.execute(
                            "UPDATE wr_url_snapshot SET availability='unavailable' "
                            "WHERE snapshot_id=? AND availability='ready'", (snapshot_id,))
                        expected = {**snapshot, 'availability': 'unavailable'}
                        if (changed.rowcount != 1 or self.store.query_one(
                                'SELECT * FROM wr_url_snapshot WHERE snapshot_id=?', (snapshot_id,)) != expected):
                            raise sqlite3.IntegrityError('snapshot classification not written')
            # Even a durable damage classification is not admission to a repaired library.
            return complete
        except (sqlite3.Error, OSError):
            return False

    def _retained_inventory_ready(self) -> bool:
        # Unknown ownership is not deletion authority, even with an empty cleanup journal.
        limit = 256
        try:
            def names(fd):
                found = set()
                with os.scandir(fd) as entries:
                    for entry in entries:
                        if len(found) >= limit or not entry.is_dir(follow_symlinks=False):
                            raise ValueError('retained inventory unsafe or over limit')
                        found.add(entry.name)
                return found

            if names(self.staging._root) != {'.staging', 'bundles'}:
                return False
            if names(self.staging._stages):
                return False
            bundles = names(self.staging._bundles)
            con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            try:
                con.row_factory = sqlite3.Row
                con.execute('BEGIN')
                snapshots = con.execute('SELECT * FROM wr_url_snapshot LIMIT 257').fetchall()
                observations = con.execute('SELECT * FROM wr_url_observation LIMIT 257').fetchall()
                assets = con.execute('SELECT * FROM wr_url_asset LIMIT 257').fetchall()
                requests = con.execute("SELECT * FROM wr_url_request WHERE state='committed' LIMIT 257").fetchall()
                if any(len(rows) > limit for rows in (snapshots, observations, assets, requests)):
                    return False
                if con.execute('SELECT 1 FROM wr_url_cleanup LIMIT 1').fetchone() is not None:
                    return False
                by_snapshot = {row['snapshot_id']: row for row in snapshots}
                by_request = {row['request_id']: row for row in requests}
                observed = {row['request_id']: row for row in observations}
                expected_bundles = {row['bundle_name'] for row in snapshots} | {row['bundle_name'] for row in observations}
                if bundles - expected_bundles:
                    return False
                for name in bundles:
                    if len(name) != 32 or any(c not in '0123456789abcdef' for c in name):
                        return False
                for row in observations:
                    snapshot = by_snapshot.get(row['snapshot_id'])
                    request = by_request.get(row['request_id'])
                    if (snapshot is None or request is None or request['snapshot_id'] != row['snapshot_id']
                            or (snapshot['bundle_name'] != row['bundle_name'] and not row['manifest_hash'])):
                        return False
                for row in requests:
                    snapshot = by_snapshot.get(row['snapshot_id'])
                    if snapshot is None or row['request_id'] not in observed:
                        return False
                    document = con.execute('SELECT id FROM document WHERE id=?', (row['doc_id'],)).fetchone()
                    if row['doc_id'] in self._removed_docs(dict(snapshot)):
                        if document is not None or snapshot['doc_id'] == row['doc_id']:
                            return False
                    elif snapshot['availability'] == 'deleted':
                        if snapshot['doc_id'] is not None or document is not None:
                            return False
                    elif snapshot['availability'] in ('ready', 'unavailable'):
                        content = con.execute('SELECT version FROM wr_content WHERE doc_id=?', (row['doc_id'],)).fetchone()
                        if (snapshot['doc_id'] != row['doc_id'] or document is None
                                or content is None or content['version'] != row['snapshot_id']):
                            return False
                    else:
                        return False
                if set(by_snapshot) != {row['snapshot_id'] for row in observations}:
                    return False
                if any(row['snapshot_id'] not in by_snapshot for row in assets):
                    return False
            finally:
                con.close()
            if bundles != expected_bundles:
                # Classify known missing bundles, but never admit an incomplete inventory.
                self._recover_snapshot_integrity()
                return False
            return True
        except (sqlite3.Error, OSError, ValueError):
            return False

    def delete_document(self, doc_id: int) -> str:
        """Delete through Store preservation and retire only this snapshot association."""
        if type(doc_id) is not int or doc_id <= 0:
            raise ImportFailure('invalid_document_id')
        with self._write_gate():
            snapshot = self.store.query_one('SELECT * FROM wr_url_snapshot WHERE doc_id=?', (doc_id,))
            if snapshot is None:
                raise ImportFailure('url_document_not_found')
            removed = self._removed_docs(snapshot)
            if doc_id in removed or len(removed) >= 256:
                raise ImportFailure('removed_history_invalid_or_full')
            expected = {**snapshot, 'doc_id': None, 'availability': 'deleted',
                        'removed_docs': json.dumps([*removed, doc_id])}
            try:
                with self.store.transaction():
                    self.store.delete_document(doc_id)
                    changed = self.store.execute(
                        "UPDATE wr_url_snapshot SET doc_id=NULL,availability='deleted',removed_docs=? "
                        'WHERE snapshot_id=? AND doc_id=?',
                        (expected['removed_docs'], snapshot['snapshot_id'], doc_id))
                    if (changed.rowcount != 1 or self.store.get_document(doc_id) is not None
                            or self.store.query_one('SELECT * FROM wr_url_snapshot WHERE snapshot_id=?',
                                                    (snapshot['snapshot_id'],)) != expected):
                        raise ImportFailure('delete_unconfirmed')
            except (sqlite3.Error, OSError, ImportFailure):
                pass
            try:
                con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
                try:
                    con.row_factory = sqlite3.Row
                    con.execute('BEGIN')
                    found = con.execute('SELECT * FROM wr_url_snapshot WHERE snapshot_id=?',
                                        (snapshot['snapshot_id'],)).fetchone()
                    gone = con.execute('SELECT 1 FROM document WHERE id=?', (doc_id,)).fetchone() is None
                    return 'source_removed' if found is not None and dict(found) == expected and gone else 'unknown'
                finally:
                    con.close()
            except (sqlite3.Error, OSError):
                return 'unknown'

    def commit(self, attempt: Attempt, prepared: PreparedImport, engine) -> Receipt:
        """Retain this observation and expose only independently verified success."""
        from .engine import Engine

        if type(engine) is not Engine or engine.store is not self.store:
            raise ImportFailure('engine_store_mismatch')
        self.check_attempt(attempt)
        document = prepared.document.for_persistence()
        source = prepared.source
        if source.identity(prepared.document, prepared.assets) != source.snapshot_id:
            raise ImportFailure('snapshot_identity_mismatch')
        try:
            observation = json.loads(source.observation_json)
            metadata = json.loads(source.metadata_json)
            if (type(metadata) is not dict or type(observation) is not dict
                    or any(type(observation.get(key)) is not str or not observation[key] for key in
                           ('original_url', 'final_url', 'fetched_at', 'raw_html_sha256'))
                    or normalize_url(observation['final_url']).url != source.source_key
                    or hashlib.sha256(normalize_url(observation['original_url']).url.encode()).hexdigest()
                    != attempt.input_digest
                    or prepared.document.version != source.snapshot_id
                    or tuple(asset.asset_id for asset in prepared.assets) != prepared.document.asset_ids):
                raise ValueError('invalid observation or references')
        except (TypeError, ValueError, KeyError, RecursionError) as exc:
            raise ImportFailure('invalid_snapshot_observation') from exc
        attempt.control.remaining()
        with self._gate, self.staging._mutex:
            self.check_attempt(attempt)
            with self._write_gate():
                if not self.store.is_plugin_enabled('importer'):
                    raise ImportFailure('importer_disabled')
            existing = None
            reuse_data = None
            try:
                con = sqlite3.connect(self.store.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
                try:
                    con.row_factory = sqlite3.Row
                    con.execute('BEGIN')
                    found = con.execute('SELECT * FROM wr_url_snapshot WHERE snapshot_id=?',
                                        (source.snapshot_id,)).fetchone()
                    if found is not None:
                        existing = dict(found)
                        first = con.execute(
                            'SELECT r.* FROM wr_url_request r JOIN wr_url_observation o '
                            'ON r.request_id=o.request_id WHERE r.snapshot_id=? '
                            "AND r.state='committed' AND o.bundle_name=? LIMIT 1",
                            (source.snapshot_id, existing['bundle_name'])).fetchone()
                        rebuilding = existing['availability'] == 'deleted' and existing['doc_id'] is None
                        if not rebuilding:
                            first = con.execute(
                                "SELECT * FROM wr_url_request WHERE snapshot_id=? AND doc_id=? AND state='committed' LIMIT 1",
                                (source.snapshot_id, existing['doc_id'])).fetchone()
                        if first is None or self._committed_status(con, first, retained=True).state != ('source_removed' if rebuilding else 'committed'):
                            raise ImportFailure('snapshot_unavailable')
                        if rebuilding:
                            history = con.execute(
                                "SELECT * FROM wr_url_request WHERE snapshot_id=? AND state='committed' LIMIT 257",
                                (source.snapshot_id,)).fetchall()
                            removed_ids = self._removed_docs(existing)
                            if (len(history) > 256 or any(
                                    r['doc_id'] not in removed_ids or
                                    self._committed_status(con, r, retained=True).state != 'source_removed'
                                    for r in history)):
                                raise ImportFailure('snapshot_unavailable')
                            manifest, members = self._read_bundle(existing)
                            old = FrozenDocument(members['document.json'], source.snapshot_id,
                                                 tuple(manifest['asset_ids'])).for_persistence()
                            old_document = old['row']
                            old_content = {'blocks': old['blocks']}
                        else:
                            old_document = dict(con.execute('SELECT * FROM document WHERE id=?',
                                                            (existing['doc_id'],)).fetchone())
                            old_content = dict(con.execute('SELECT * FROM wr_content WHERE doc_id=?',
                                                           (existing['doc_id'],)).fetchone())
                        old_assets = [dict(a) for a in con.execute(
                            'SELECT * FROM wr_url_asset WHERE snapshot_id=? ORDER BY asset_id', (source.snapshot_id,))]
                        reuse_data = old_document, old_content, old_assets
                finally:
                    con.close()
            except (sqlite3.Error, OSError) as exc:
                raise ImportFailure('snapshot_unknown') from exc
            if (prepared is not self.staging._sealed
                    or observation['raw_html_sha256'] != next(
                        (sha for name, _, sha in self.staging._members if name == 'raw.html.bin'), None)):
                raise ImportFailure('invalid_snapshot_observation')
            bundle = self.staging._publish(prepared, attempt.control)
            snapshot = dict(snapshot_id=source.snapshot_id, source_key=source.source_key,
                            bundle_name=bundle.bundle_name, manifest_hash=bundle.manifest_sha256,
                            extractor_version=source.extractor_version, sanitizer_version=source.sanitizer_version,
                            metadata_json=source.metadata_json, availability='ready', removed_docs='[]')
            assets = [dict(snapshot_id=source.snapshot_id, **vars(asset)) for asset in prepared.assets]
            observed = dict(request_id=attempt.request_id, snapshot_id=source.snapshot_id,
                            original_url=observation['original_url'], final_url=observation['final_url'],
                            fetched_at=observation['fetched_at'], raw_html_hash=observation['raw_html_sha256'],
                            observation_json=source.observation_json, bundle_name=bundle.bundle_name,
                            manifest_hash=bundle.manifest_sha256)
            if existing is not None:
                if reuse_data is None:
                    raise ImportFailure('snapshot_unavailable')
                old_document, old_content, old_assets = reuse_data
                snapshot = dict(existing)
                assets = old_assets
                document = {**document, 'row': {k: v for k, v in old_document.items() if k != 'id'},
                            'blocks': old_content['blocks']}
            try:
                with self._write_gate():
                    self.check_attempt(attempt)
                    if not self.store.is_plugin_enabled('importer'):
                        raise ImportFailure('importer_disabled')
                    with self.store.transaction():
                        before = self.store.query_one('SELECT * FROM wr_url_request WHERE request_id=?',
                                                      (attempt.request_id,))
                        if (before is None or before['state'] != 'running'
                                or before['generation'] != attempt.generation
                                or before['owner_epoch'] != attempt.owner_epoch
                                or before['input_digest'] != attempt.input_digest):
                            raise ImportFailure('attempt_unconfirmed')
                        if self.store.query_one('SELECT * FROM wr_url_snapshot WHERE snapshot_id=?',
                                                (source.snapshot_id,)) != existing:
                            raise ImportFailure('snapshot_changed')
                        if existing is not None and existing['availability'] == 'ready':
                            doc_id = existing['doc_id']
                        else:
                            doc_id = engine.persist_import(document, cache_analysis=False)['id']
                            snapshot['doc_id'] = doc_id
                            snapshot['availability'] = 'ready'
                            if existing is not None:
                                changed_snapshot = self.store.execute(
                                    "UPDATE wr_url_snapshot SET doc_id=?,availability='ready' WHERE snapshot_id=? AND availability='deleted' AND doc_id IS NULL",
                                    (doc_id, source.snapshot_id))
                                if changed_snapshot.rowcount != 1:
                                    raise ImportFailure('snapshot_rebuild_unconfirmed')
                        if existing is None:
                            self.store.execute(
                                'INSERT INTO wr_url_snapshot '
                                '(snapshot_id,source_key,doc_id,bundle_name,manifest_hash,extractor_version,'
                                'sanitizer_version,metadata_json,availability) VALUES(?,?,?,?,?,?,?,?,?)',
                                tuple(snapshot[key] for key in ('snapshot_id', 'source_key', 'doc_id', 'bundle_name',
                                      'manifest_hash', 'extractor_version', 'sanitizer_version', 'metadata_json', 'availability')))
                            for asset in assets:
                                self.store.execute(
                                    'INSERT INTO wr_url_asset '
                                    '(snapshot_id,asset_id,relative_name,mime,width,height,byte_count,sha256) '
                                    'VALUES(?,?,?,?,?,?,?,?)', tuple(asset[key] for key in
                                    ('snapshot_id', 'asset_id', 'relative_name', 'mime', 'width', 'height', 'byte_count', 'sha256')))
                        self.store.execute(
                            'INSERT INTO wr_url_observation '
                            '(request_id,snapshot_id,original_url,final_url,fetched_at,raw_html_hash,observation_json,bundle_name,manifest_hash) '
                            'VALUES(?,?,?,?,?,?,?,?,?)', tuple(observed[key] for key in
                            ('request_id', 'snapshot_id', 'original_url', 'final_url', 'fetched_at',
                             'raw_html_hash', 'observation_json', 'bundle_name', 'manifest_hash')))
                        completed = _now()
                        changed = self.store.execute(
                            "UPDATE wr_url_request SET state='committed',doc_id=?,snapshot_id=?,completed_at=? "
                            "WHERE request_id=? AND state='running' AND generation=? AND owner_epoch=?",
                            (doc_id, source.snapshot_id, completed, attempt.request_id,
                             attempt.generation, attempt.owner_epoch))
                        expected_request = {**before, 'state': 'committed', 'doc_id': doc_id,
                                            'snapshot_id': source.snapshot_id, 'completed_at': completed}
                        actual_assets = self.store.query('SELECT * FROM wr_url_asset WHERE snapshot_id=? ORDER BY asset_id',
                                                         (source.snapshot_id,))
                        if (changed.rowcount != 1
                                or self.store.query_one('SELECT * FROM document WHERE id=?', (doc_id,))
                                != {'id': doc_id, **document['row']}
                                or self.store.query_one('SELECT * FROM wr_content WHERE doc_id=?', (doc_id,))
                                != {'doc_id': doc_id, 'version': source.snapshot_id, 'blocks': document['blocks']}
                                or self.store.query_one('SELECT * FROM wr_url_snapshot WHERE snapshot_id=?',
                                                        (source.snapshot_id,)) != snapshot
                                or actual_assets != sorted(assets, key=lambda asset: asset['asset_id'])
                                or self.store.query_one('SELECT * FROM wr_url_observation WHERE request_id=?',
                                                        (attempt.request_id,)) != observed
                                or self.store.query_one('SELECT * FROM wr_url_request WHERE request_id=?',
                                                        (attempt.request_id,)) != expected_request):
                            raise ImportFailure('sql_closure_mismatch')
                        attempt.control.remaining()
            except (sqlite3.Error, OSError, ImportFailure):
                result = self.status(attempt.request_id)
                if result.state in ('not_found', 'running'):
                    return Receipt(attempt.request_id, 'unknown', error_code='commit_unconfirmed')
                return result
            return self.status(attempt.request_id)

    def publish_bundle(self, attempt: Attempt, prepared: PreparedImport) -> PublishedBundle:
        with self._gate, self.staging._mutex:
            self.check_attempt(attempt)
            # This is not a commit right. The later SQL phase must recheck under this gate.
            return self.staging._publish(prepared, attempt.control)

    @property
    def stopping(self) -> bool:
        with self._gate:
            return self._stopping

    @property
    def recovery_ready(self) -> bool:
        with self._gate:
            return self._recovery_ready and not self._stopping and self._owner._fd is not None

    def stop_admission(self):
        with self._gate:
            self._stopping = True

    def shutdown(self) -> Receipt | None:
        """Drain outside the commit gate; callers must keep Store/Lexicon alive."""
        self.stop_admission()
        with self._shutdown_lock:
            with self._gate:
                if self._owner._fd is None:
                    return None
                self._lifetime()
                execution, attempt = self._execution, self._execution_attempt
            if execution is not None:
                execution.join()
            result = None
            errors = []
            try:
                if execution is not None and attempt is not None:
                    result = self.finish(attempt, execution)
            except BaseException as exc:
                errors.append(exc)
            try:
                self.close()
            except BaseException as exc:
                errors.append(exc)
            if errors:
                raise BaseExceptionGroup('URL shutdown failed', errors)
            return result

    def close(self):
        with self._gate:
            if self._owner._fd is None:
                return
            self._owner._check()
            self._stopping = True
            errors = []
            try:
                if self._attempt is not None:
                    self._attempt.control.cancel()
                    self._attempt = None
            except BaseException as exc:
                errors.append(exc)
            try:
                self.staging.close()
            except BaseException as exc:
                errors.append(exc)
            try:
                self._owner.close()
            except BaseException as exc:
                errors.append(exc)
            if errors:
                raise BaseExceptionGroup('URL cleanup failed', errors)

