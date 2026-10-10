"""Durable, explicitly scoped vision requests. Recovery never resends a dispatch.

The ledger and retained images/responses are not temporary reading caches. Network
credentials are kept only in private configuration, never in job/replay records.
"""
from __future__ import annotations

import asyncio
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import time
import traceback
from urllib.parse import urlsplit
import uuid

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from wise_reader.pdf_lab.worker import worker_python
from . import enhancement_provider as provider
from .uploads import error

IDENTIFIER = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9._-]{15,127}\Z')
ACTIVE = {'queued', 'running'}
log = logging.getLogger(__name__)
DEFAULT_CONFIG = {'enabled': False, 'endpoint': '', 'model': '', 'api_key': '',
                  'vision_capable': False, 'max_calls': None, 'connection_verified': False}


class EnhancementConfigPatch(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    enabled: bool | None = None
    endpoint: str | None = Field(default=None, max_length=500)
    model: str | None = Field(default=None, max_length=150)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_key: bool = False
    vision_capable: bool | None = None
    max_calls: int | None = Field(default=None, ge=0, le=1_000_000_000)


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        tmp.unlink(missing_ok=True)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class EnhancementService:
    def __init__(self, module):
        self.module = module
        self.root = module.originals.root / 'retained' / 'enhancements'
        self.database = self.root / 'ledger.sqlite3'
        self.storage_ready = False
        self.ready = False
        self.closing = False
        self.service_lock = None
        self.start_lock = asyncio.Lock()
        self.render_lock = asyncio.Lock()
        self.slots = asyncio.Semaphore(2)
        self.tasks = {}
        self.last_tick = 0.0
        try:
            self._initialize_storage()
        except (OSError, sqlite3.Error):
            # Optional enhancement storage must not block retained reading.
            log.warning('pdf_enhancement_storage_unavailable')

    def _initialize_storage(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, book INTEGER NOT NULL, key TEXT NOT NULL,
                    status TEXT NOT NULL, held INTEGER NOT NULL, payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS enhancement_book_key ON jobs(book,key);
                CREATE TABLE IF NOT EXISTS intents (
                    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, job TEXT NOT NULL);
            ''')
            db.execute('INSERT OR IGNORE INTO config VALUES(1,?)',
                       (json.dumps({**DEFAULT_CONFIG, 'service_id': uuid.uuid4().hex,
                                    'revision': uuid.uuid4().hex}),))
        os.chmod(self.database, 0o600)
        self.storage_ready = True

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.database, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute('PRAGMA synchronous=FULL')
            connection.execute('BEGIN IMMEDIATE')
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _decode(row):
        return json.loads(row['payload']) if row else None

    def _config(self, db=None):
        if db is not None:
            return self._decode(db.execute('SELECT payload FROM config WHERE id=1').fetchone())
        with self.db() as connection:
            return self._config(connection)

    def _get(self, job_id, db=None):
        if db is not None:
            job = self._decode(db.execute('SELECT payload FROM jobs WHERE id=?', (job_id,)).fetchone())
            if not job:
                raise error(404, 'enhancement_not_found', 'No enhancement has this identity.')
            return job
        with self.db() as connection:
            return self._get(job_id, connection)

    @staticmethod
    def _save(db, job):
        job['updated_at'] = time.time()
        db.execute('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?,?)',
                   (job['id'], job['book_id'], job['_key'], job['status'],
                    int(job['reservation_held']), json.dumps(job, allow_nan=False)))

    def _update(self, job_id, **values):
        with self.db() as db:
            job = self._get(job_id, db)
            job.update(values)
            self._save(db, job)
            return job

    def _diagnostic(self, job_id, stage, exc):
        # Never persist exception strings or source lines: HTTP errors can embed
        # credentials, URLs and request bodies. Frames still locate the failure.
        frames = [{'file': Path(frame.filename).name, 'function': frame.name, 'line': frame.lineno}
                  for frame in traceback.extract_tb(exc.__traceback__)[-12:]]
        detail = {'stage': stage, 'category': type(exc).__name__, 'frames': frames, 'at': time.time()}
        atomic(self._path(job_id, 'diagnostic.json'), json_bytes(detail))
        log.warning('pdf_enhancement_failed job=%s stage=%s category=%s frame=%s',
                    job_id, stage, type(exc).__name__, frames[-1] if frames else {})

    def _limits(self, db):
        occupied = db.execute('SELECT COUNT(*) FROM jobs WHERE held=1').fetchone()[0]
        reserved = db.execute("SELECT COUNT(*) FROM jobs WHERE held=1 AND status='queued'").fetchone()[0]
        maximum = self._config(db)['max_calls']
        return {'max_calls': maximum, 'occupied': occupied, 'reserved': reserved,
                'dispatched': occupied - reserved,
                'remaining': None if maximum is None else max(0, maximum - occupied)}

    def config(self):
        processing_enabled = bool(self.module.enabled())
        if not self.storage_ready:
            return {**{k: v for k, v in DEFAULT_CONFIG.items() if k != 'api_key'},
                    'processing_enabled': processing_enabled,
                    'service_id': '', 'has_api_key': False, 'available': False, 'vision_verified': False,
                    'protocol': 'openai_chat_completions', 'supports_query': False, 'supports_idempotency': False,
                    'limits': None, 'error': {'code': 'enhancement_storage_unavailable',
                        'message': 'Enhancement storage is unavailable; retained reading remains usable.'}}
        with self.db() as db:
            value = self._config(db)
            result = {k: v for k, v in value.items() if k not in {'api_key', 'revision'}}
            result.update(has_api_key=bool(value['api_key']), vision_verified=False,
                          processing_enabled=processing_enabled,
                          available=bool(self.ready and self._configured(value) and processing_enabled),
                          limits=self._limits(db), protocol='openai_chat_completions',
                          supports_query=False, supports_idempotency=False)
            return result

    @staticmethod
    def _configured(config):
        return bool(config['enabled'] and config['endpoint'] and config['model'] and config['vision_capable'])

    def _candidate(self, patch, previous):
        try:
            patch = EnhancementConfigPatch.model_validate(patch)
        except ValidationError:
            raise error(422, 'invalid_enhancement_config', 'Check vision service settings and field lengths.') from None
        values = dict(previous)
        for key, value in patch.model_dump(exclude_unset=True).items():
            if key == 'clear_key':
                continue
            if value is None and key != 'max_calls':
                raise error(422, 'invalid_enhancement_config', 'Only max_calls accepts null.')
            if key == 'api_key' and not value.strip():
                continue
            values[key] = value.strip() if isinstance(value, str) else value
        if patch.clear_key:
            values['api_key'] = ''
        endpoint = values['endpoint'].rstrip('/')
        parts = urlsplit(endpoint)
        if endpoint and (parts.scheme not in {'http', 'https'} or not parts.hostname or parts.username
                         or parts.password or parts.query or parts.fragment
                         or any(ord(c) < 33 for c in endpoint)):
            raise error(422, 'invalid_endpoint', 'Use an explicit HTTP(S) base URL without credentials or query parameters.')
        if any(ord(c) < 32 for c in values['api_key']):
            raise error(422, 'invalid_key', 'API key contains unsupported characters.')
        if previous['api_key'] and endpoint != previous['endpoint'] and not patch.clear_key and not (patch.api_key or '').strip():
            raise error(422, 'key_destination_changed', 'Changing service address requires its key, or explicitly clearing the old key.')
        values['endpoint'] = endpoint
        if values['enabled'] and not self._configured(values):
            raise error(422, 'vision_configuration_required', 'Provide endpoint/model and explicitly declare image capability before enabling.')
        changed = any(values[k] != previous[k] for k in ('endpoint', 'model', 'api_key', 'vision_capable'))
        if changed:
            values.update(service_id=uuid.uuid4().hex, connection_verified=False)
        values['revision'] = uuid.uuid4().hex
        return values

    async def update_config(self, patch, *, test=False):
        await self.start()
        if not self.ready:
            raise error(503, 'enhancement_unavailable', 'Enhancement storage or its worker is unavailable; settings were not changed.')
        previous = self._config()
        candidate = self._candidate(patch, previous)
        if test:
            if not candidate['endpoint'] or not candidate['model'] or not candidate['vision_capable']:
                raise error(422, 'vision_configuration_required', 'Declare the image service, model and capability before testing.')
            try:
                await provider.check_connection(candidate)
            except Exception:
                raise error(502, 'connection_test_failed', 'Could not confirm the selected model through the service model list; settings were not saved.') from None
            candidate['connection_verified'] = True
        async with self.module.control_lock:
            with self.db() as db:
                if self._config(db)['revision'] != previous['revision']:
                    raise error(409, 'configuration_changed', 'Settings changed during this operation; reload them.')
                db.execute('UPDATE config SET payload=? WHERE id=1', (json.dumps(candidate),))
                if candidate['service_id'] != previous['service_id'] or not candidate['enabled']:
                    self._cancel_rows(db, None, 'service_configuration_changed')
        public = self.config()
        return {'config': public, 'test': {'kind': 'models_readonly', 'connection_verified': True,
                'vision_verified': False, 'actual_called': 'no'}} if test else public

    async def start(self):
        async with self.start_lock:
            if self.ready:
                return
            if not self.storage_ready:
                try:
                    await asyncio.to_thread(self._initialize_storage)
                except (OSError, sqlite3.Error):
                    return
            lock = self.root / 'service.lock'
            try:
                fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
            except OSError:
                return
            handle = os.fdopen(fd, 'a+')
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.db() as db:
                    for row in db.execute('SELECT payload FROM jobs').fetchall():
                        job = self._decode(row)
                        # Receipt journal precedes ledger update, so an interrupted
                        # DB commit can recover received bytes without any network.
                        if job['actual_called'] == 'possible':
                            try:
                                receipt = json.loads(self._path(job['id'], 'receipt.json').read_bytes())
                                raw = base64.b64decode(receipt['body_b64'], validate=True)
                                if sha(raw) != receipt['sha256']:
                                    raise ValueError('receipt_integrity_failed')
                                atomic(self._path(job['id'], 'response.json'), raw)
                                job['_materials']['response.json'] = sha(raw)
                                job.update(actual_called='yes', response_received_at=receipt['received_at'],
                                           _http_status=receipt['status'], _response_redacted=receipt['redacted'],
                                           usage=provider.response_usage(raw), usage_origin='provider_response')
                                self._save(db, job)
                            except (OSError, ValueError, KeyError):
                                pass
                        if job['status'] in ACTIVE:
                            if job['actual_called'] == 'no':
                                job.update(status='failed', reservation_held=False,
                                           error={'code': 'interrupted_before_dispatch', 'message': 'Work stopped before dispatch. No image request was sent.'})
                            else:
                                job.update(status='unknown', error={'code': 'dispatch_interrupted',
                                    'message': 'A request may have reached the service. It will not be sent again automatically.'})
                            self._save(db, job)
                self.service_lock = handle
                self.ready = True
                self.closing = False
            except (OSError, sqlite3.Error):
                handle.close()
                # An optional processing component must not prevent reading.
                return

    async def close(self):
        self.closing = True
        if not self.ready:
            return
        for task in list(self.tasks.values()):
            task.cancel()
        await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)
        with self.db() as db:
            for row in db.execute("SELECT payload FROM jobs WHERE status IN ('queued','running')").fetchall():
                job = self._decode(row)
                sent = job['actual_called'] != 'no'
                job.update(status='unknown' if sent else 'failed', reservation_held=sent,
                           error={'code': 'service_stopped', 'message': 'Processing stopped; existing material is retained. No automatic resend.'})
                self._save(db, job)
        if self.service_lock:
            self.service_lock.close()
            self.service_lock = None
        self.ready = False

    def _guard(self, job=None, book_id=None, network=False, service_id=None):
        if not self.ready or self.closing or self.module.closing:
            raise error(503, 'enhancement_unavailable', 'The enhancement worker is unavailable; retained reading remains usable.')
        if not self.module.enabled():
            raise error(409, 'processing_disabled', 'Enable PDF processing to start work.')
        mapping, source = self.module.source_book(book_id if book_id is not None else job['book_id'])
        if mapping['lifecycle'] != 'active':
            raise error(409, 'book_recycled', 'Restore the book before processing.')
        if job and (mapping['generation'] != job['generation'] or source['file_sha256'] != job['source_sha256']):
            raise error(409, 'enhancement_stale', 'The book changed; this result is retained but cannot be applied automatically.')
        if job and job.get('_source_signature'):
            stat = self.module.originals.source(source).stat()
            if [stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns] != job['_source_signature']:
                raise error(409, 'source_changed', 'The registered original changed after image preparation; retained results were not applied.')
        if network:
            config = self._config()
            if not self._configured(config):
                raise error(409, 'vision_service_disabled', 'Configure and enable an explicitly image-capable service.')
            if (service_id or job['service']['id']) != config['service_id']:
                raise error(409, 'service_changed', 'Reload the selected image service before requesting processing.')
        return mapping, source

    def _path(self, job_id, relative):
        if not IDENTIFIER.fullmatch(job_id) or Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise error(409, 'invalid_retained_path', 'Invalid retained material identity.')
        base = self.root / 'jobs' / job_id
        path = base / relative
        if path.is_symlink() or not path.resolve().is_relative_to(base.resolve()) or base.is_symlink():
            raise error(409, 'invalid_retained_path', 'Retained material path is unsafe.')
        return path

    def _material(self, job, name):
        expected = job.get('_materials', {}).get(name)
        if not expected:
            raise error(409, 'replay_material_missing', 'Required retained material is missing; no request will be sent.')
        path = self._path(job.get('_material_job', job['id']), name)
        try:
            data = path.read_bytes()
        except OSError:
            raise error(409, 'replay_material_missing', 'Required retained material is unavailable; no request will be sent.') from None
        if sha(data) != expected:
            raise error(409, 'replay_material_changed', 'Retained material integrity check failed; no request will be sent.')
        return data

    def _result(self, job):
        path = self._path(job['id'], 'result.json')
        data = path.read_bytes()
        if sha(data) != job.get('_result_sha256'):
            raise ValueError('result_integrity_failed')
        return json.loads(data)

    def result_asset(self, job, relative):
        current = self._get(job['id'])
        if current['book_id'] != job['book_id']:
            raise error(404, 'asset_not_found', 'No asset belongs to this enhancement.')
        expected = current.get('_assets', {}).get(relative)
        if not expected or not relative.startswith('normalized-assets/'):
            raise error(404, 'asset_not_found', 'No registered enhancement asset has this name.')
        path = self._path(current['id'], relative)
        if sha(path.read_bytes()) != expected:
            raise error(409, 'asset_changed', 'Retained source image failed its integrity check.')
        return path

    def _public(self, job, cache_reused=False, *, include_result=True):
        value = {k: v for k, v in job.items() if not k.startswith('_')}
        value['cache_reused'] = bool(cache_reused or job.get('cache_reused'))
        try:
            # Polling/history must not reread megabytes of retained images.
            # Replay itself verifies all hashes before doing any local work.
            present = all(job.get('_materials', {}).get(name) and
                          self._path(job.get('_material_job', job['id']), name).is_file()
                          for name in ('response.json', 'geometry.json', 'input.png'))
            value['replay_available'] = bool(present and job.get('_http_status') == 200 and not job.get('_response_redacted'))
        except Exception:
            value['replay_available'] = False
        value['result'] = None
        # Availability is ledger metadata, not an integrity claim. Only the
        # selected detail reads and verifies normalized content.
        value['result_available'] = bool(job.get('_result_sha256'))
        if include_result and value['result_available']:
            try:
                value['result'] = self._result(job)
            except (OSError, ValueError):
                value['error'] = {'code': 'normalized_result_unavailable', 'message': 'Retained normalized result is unavailable; try local replay.'}
        if value['cache_reused'] and (job['status'] != 'completed' or not value['result_available']
                                     or include_result and value['result'] is None):
            value['cache_reused'] = False
            value['request_reused'] = True
        return value

    def status(self, book_id, job_id):
        if not self.storage_ready:
            raise error(503, 'enhancement_storage_unavailable', 'Retained enhancement records are temporarily unavailable.')
        self.module.source_book(book_id)
        job = self._get(job_id)
        if job['book_id'] != book_id:
            raise error(404, 'enhancement_not_found', 'No enhancement belongs to this book.')
        return self._public(job)

    def history(self, book_id):
        if not self.storage_ready:
            raise error(503, 'enhancement_storage_unavailable', 'Retained enhancement records are temporarily unavailable.')
        self.module.source_book(book_id)
        with self.db() as db:
            jobs = [self._decode(row) for row in db.execute('SELECT payload FROM jobs WHERE book=? ORDER BY rowid DESC LIMIT 100', (book_id,))]
            limits = self._limits(db)
        return {'jobs': [self._public(job, include_result=False) for job in jobs], 'limits': limits}

    async def _render(self, source, number, region, destination):
        original = self.module.originals.source(source)
        originals = (self.module.originals.root / 'originals').resolve()
        if original.is_symlink() or not original.resolve().is_relative_to(originals):
            raise error(409, 'source_changed', 'The registered PDF original is unavailable.')
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        async with self.render_lock:
            process = await asyncio.create_subprocess_exec(str(worker_python()),
                str(Path(__file__).with_name('enhancement_render.py')), str(original), str(number),
                json.dumps(region, allow_nan=False), str(destination),
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
            try:
                out, _ = await asyncio.wait_for(process.communicate(), timeout=30)
            except BaseException:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
                raise
        if process.returncode != 0:
            raise error(422, 'source_render_failed', 'Cannot render the selected original page/region. Check coordinates and PDF rendering availability.')
        metadata = json.loads(out)
        if metadata['source_sha256'] != source['file_sha256']:
            raise error(409, 'source_changed', 'Original checksum no longer matches the registered book.')
        os.chmod(destination, 0o600)
        # Native renderer's file must be durable before it becomes replay input.
        atomic(destination, destination.read_bytes())
        return metadata

    @staticmethod
    def _scope(number, region):
        if type(number) is not int or number < 1:
            raise error(422, 'invalid_page', 'Choose one original PDF page.')
        if region is not None:
            if (not isinstance(region, list) or len(region) != 4
                    or any(type(v) not in (int, float) or not math.isfinite(v) for v in region)
                    or not (0 <= region[0] < region[2] and 0 <= region[1] < region[3])):
                raise error(422, 'invalid_region', 'Choose a finite, nonempty region inside the original page.')
            region = [float(v) for v in region]
        return {'page_number': number, 'region': region, 'coordinate_space': 'rotated_crop_top_left'}

    def _intent(self, db, intent_id, fingerprint):
        row = db.execute('SELECT * FROM intents WHERE id=?', (intent_id,)).fetchone()
        if row:
            if row['fingerprint'] != fingerprint:
                raise error(409, 'intent_scope_changed', 'This operation identity already belongs to another scope or action.')
            return self._get(row['job'], db)
        return None

    def _reuse(self, db, book_id, key, regenerate):
        candidates = [self._decode(row) for row in db.execute(
            'SELECT payload FROM jobs WHERE book=? AND key=? ORDER BY rowid DESC', (book_id, key))]
        active = next((j for j in candidates if j['status'] in ACTIVE), None)
        if active or regenerate:
            return active
        # Missing/corrupt paid material remains an explicit recovery choice,
        # never an automatic cache-miss request.
        return (next((j for j in candidates if j['status'] == 'completed'), None)
                or next((j for j in candidates if j['actual_called'] != 'no'), None))

    def _new_job(self, mapping, source, scope, service, key, job_id=None):
        now = time.time()
        return {'id': job_id or uuid.uuid4().hex, 'book_id': mapping['book_id'], 'status': 'queued',
                'created_at': now, 'updated_at': now, 'scope': scope, 'source_sha256': source['file_sha256'],
                'generation': mapping['generation'], 'service': service, 'engine': 'external_vision',
                'engine_version': provider.VERSION, 'actual_called': 'no', 'dispatch_started_at': None,
                'response_received_at': None, 'reservation_held': False, 'cache_reused': False,
                'local_replay': False, 'usage': None, 'cost': {'status': 'not_incurred', 'amount': None, 'currency': None},
                'error': None, 'publication': 'pending', '_key': key, '_materials': {}, '_assets': {}}

    def _schedule(self, job, replay=False):
        task = asyncio.create_task(self._run(job['id'], replay), name='pdf-enhancement-' + job['id'])
        self.tasks[job['id']] = task
        def finished(done):
            self.tasks.pop(job['id'], None)
            if not done.cancelled() and (failure := done.exception()) is not None:
                # A completely full/broken ledger may also reject the failure
                # update. Its prior dispatch intent remains recoverable.
                log.error('pdf_enhancement_worker_stopped job=%s category=%s', job['id'], type(failure).__name__)
        task.add_done_callback(finished)

    async def submit(self, book_id, page_number, region, service_id, intent_id, *, regenerate=False, parent_id=None):
        await self.start()
        scope = self._scope(page_number, region)
        if not isinstance(intent_id, str) or not IDENTIFIER.fullmatch(intent_id):
            raise error(422, 'intent_required', 'Provide a new 16–128 character operation identity.')
        if not isinstance(service_id, str) or not IDENTIFIER.fullmatch(service_id):
            raise error(422, 'service_required', 'Choose the current image service before requesting processing.')
        mapping, source = self._guard(book_id=book_id, network=True, service_id=service_id)
        if page_number > source['page_count']:
            raise error(422, 'invalid_page', 'Selected original page is outside this PDF.')
        config = self._config()
        fingerprint = provider.digest([book_id, scope, service_id, 'regenerate' if regenerate else 'enhance', parent_id])
        key = provider.digest([source['file_sha256'], scope, service_id, provider.VERSION, provider.PROMPT])
        async with self.module.control_lock:
            self._guard(book_id=book_id, network=True, service_id=service_id)
            with self.db() as db:
                previous = self._intent(db, intent_id, fingerprint)
                if previous:
                    return self._public(previous, cache_reused=True)
                reuse = self._reuse(db, book_id, key, regenerate)
                if reuse:
                    db.execute('INSERT INTO intents VALUES(?,?,?)', (intent_id, fingerprint, reuse['id']))
                    return self._public(reuse, cache_reused=True)
            # Order the user's intent before asynchronous rendering/dispatch.
            # Registry rows are retained; a later local task on this page wins
            # even if the wall clock moves backwards or its result is delayed.
            intent_created_at = time.time()
            with self.module.originals.connect() as db:
                local_sequence = db.execute("SELECT COALESCE(MAX(rowid),0) FROM tasks WHERE book_id=? AND engine!='external_vision'",
                                            (source['id'],)).fetchone()[0]
        # Render before reserving or dispatching. Only this image can leave the host.
        job_id = uuid.uuid4().hex
        png = self._path(job_id, 'input.png')
        geometry = await self._render(source, page_number, scope['region'], png)
        geometry_bytes = json_bytes(geometry)
        atomic(self._path(job_id, 'geometry.json'), geometry_bytes)
        reuse = None
        async with self.module.control_lock:
            mapping, source = self._guard(book_id=book_id, network=True, service_id=service_id)
            with self.db() as db:
                previous = self._intent(db, intent_id, fingerprint)
                if previous:
                    reuse = previous
                else:
                    reuse = self._reuse(db, book_id, key, regenerate)
                    if reuse:
                        db.execute('INSERT INTO intents VALUES(?,?,?)', (intent_id, fingerprint, reuse['id']))
                    else:
                        limits = self._limits(db)
                        if limits['remaining'] == 0:
                            raise error(409, 'pdf_call_limit', 'PDF request limit reached; existing results and local replay remain available.')
                        if len(self.tasks) >= 32:
                            raise error(409, 'enhancement_queue_busy', 'The image-processing queue is busy; wait for existing work.')
                        service = {'id': service_id, 'endpoint': config['endpoint'], 'model': config['model'], 'protocol': 'openai_chat_completions'}
                        job = self._new_job(mapping, source, scope, service, key, job_id)
                        job.update(reservation_held=True, regenerated_from=parent_id,
                                   intent_created_at=intent_created_at, _local_task_sequence=local_sequence)
                        job['_source_signature'] = geometry['source_signature']
                        job['_materials'] = {'input.png': sha(png.read_bytes()), 'geometry.json': sha(geometry_bytes)}
                        self._save(db, job)
                        db.execute('INSERT INTO intents VALUES(?,?,?)', (intent_id, fingerprint, job_id))
            if reuse:
                # Unregistered preparation is reproducible local data, not replay material.
                for name in ('input.png', 'geometry.json'):
                    self._path(job_id, name).unlink(missing_ok=True)
                return self._public(reuse, cache_reused=True)
            self._schedule(job)
        return self._public(job)

    async def action(self, book_id, job_id, action, intent_id=None, service_id=None):
        await self.start()
        self.status(book_id, job_id)
        if action == 'cancel':
            async with self.module.control_lock:
                with self.db() as db:
                    job = self._get(job_id, db)
                    if job['status'] in ACTIVE or job['publication'] in {'pending', 'deferred'}:
                        job.update(status='cancelled', publication='stale',
                                   reservation_held=job['actual_called'] != 'no',
                                   error={'code': 'cancelled', 'message': 'Cancelled. A dispatched request may still be processed or billed.'})
                        self._save(db, job)
            return self.status(book_id, job_id)
        original = self._get(job_id)
        if action == 'regenerate':
            return await self.submit(book_id, original['scope']['page_number'], original['scope']['region'],
                                     service_id, intent_id, regenerate=True, parent_id=job_id)
        if action != 'replay':
            raise error(422, 'unknown_action', 'Choose replay, regenerate or cancel.')
        if original['status'] in ACTIVE:
            raise error(409, 'request_inflight', 'Wait for the current request or cancel it before local replay.')
        # All preconditions are checked before persisting a local-only job.
        raw = self._material(original, 'response.json')
        geometry = json.loads(self._material(original, 'geometry.json'))
        self._material(original, 'input.png')
        if original.get('_http_status') != 200 or original.get('_response_redacted') or original['engine_version'] != provider.VERSION:
            raise error(409, 'replay_unavailable', 'This response cannot be replayed with the current parser; no request will be sent.')
        async with self.module.control_lock:
            mapping, source = self._guard(book_id=book_id)
            if source['file_sha256'] != original['source_sha256'] or geometry['source_sha256'] != source['file_sha256']:
                raise error(409, 'replay_source_changed', 'Retained response no longer belongs to this original.')
            job = self._new_job(mapping, source, original['scope'], original['service'], original['_key'])
            try:
                provider.normalize(raw, job, geometry)
            except (ValueError, TypeError, KeyError, AttributeError):
                raise error(409, 'replay_invalid', 'The retained response cannot produce valid scoped content. No request was sent.') from None
            job.update(local_replay=True, replayed_from=original['id'],
                       intent_created_at=original.get('intent_created_at', original['created_at']),
                       _material_job=original.get('_material_job', original['id']),
                       _materials=original['_materials'], _http_status=200, _response_redacted=False)
            if '_local_task_sequence' in original:
                job['_local_task_sequence'] = original['_local_task_sequence']
            job['_source_signature'] = geometry.get('source_signature')
            with self.db() as db:
                self._save(db, job)
            self._schedule(job, replay=True)
        return self._public(job)

    @staticmethod
    def _cancel_rows(db, book_id, code):
        rows = db.execute("SELECT payload FROM jobs WHERE status IN ('queued','running','completed')").fetchall()
        for row in rows:
            job = json.loads(row['payload'])
            if book_id is not None and job['book_id'] != book_id:
                continue
            if job['status'] == 'completed' and job['publication'] == 'applied':
                continue
            job.update(status='cancelled', publication='stale', reservation_held=job['actual_called'] != 'no',
                       error={'code': code, 'message': 'Processing stopped. Retained responses remain available; dispatched requests may still be billed.'})
            EnhancementService._save(db, job)

    async def cancel_book(self, book_id):
        if not self.ready:
            return
        with self.db() as db:
            self._cancel_rows(db, book_id, 'book_lifecycle_changed')

    async def processing_changed(self, enabled):
        if self.ready and not enabled:
            with self.db() as db:
                self._cancel_rows(db, None, 'processing_disabled')

    def task_intent_time(self, task):
        """Compare legacy and current publication tasks by original intent."""
        if task['engine'] == 'external_vision' and task.get('metrics', {}).get('enhancement_job_id'):
            current = self._get(task['metrics']['enhancement_job_id'])
            return current.get('intent_created_at', current['created_at'])
        return task['created_at']

    def publication_allowed(self, job):
        try:
            current = self._get(job['id'])
            _, source = self._guard(current)
            if current['status'] != 'completed' or current['generation'] != job['generation']:
                return False
            intent_time = current.get('intent_created_at', current['created_at'])
            with self.module.originals.connect() as db:
                # Older base tasks may finish before a deferred crop is merged;
                # a new local intent must never be replaced by that old crop.
                ordering = 'rowid' if '_local_task_sequence' in current else 'created_at'
                newer = db.execute(f"SELECT 1 FROM tasks WHERE book_id=? AND engine!='external_vision' AND start_page<=? AND end_page>=? AND {ordering}>? LIMIT 1",
                                   (source['id'], current['scope']['page_number'], current['scope']['page_number'],
                                    current.get('_local_task_sequence', intent_time))).fetchone()
            if newer:
                return False
            # Newer completed/dispatched intent touching this scope wins, including partial overlaps.
            with self.db() as db:
                rows = db.execute('SELECT payload FROM jobs WHERE book=?', (current['book_id'],)).fetchall()
            a = current['scope']['region']
            for row in rows:
                other = self._decode(row)
                if (other.get('intent_created_at', other['created_at']) <= intent_time or other['scope']['page_number'] != current['scope']['page_number']
                        or other['status'] == 'failed' and other['actual_called'] == 'no'):
                    continue
                b = other['scope']['region']
                if a is None or b is None or (a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]):
                    return False
            return True
        except Exception:
            return False

    async def _apply(self, job):
        async with self.module.control_lock:
            if not self.publication_allowed(job):
                self._update(job['id'], publication='stale')
                return
            hook = getattr(self.module, 'apply_enhancement', None)
            if not hook:
                self._update(job['id'], publication='deferred', error={'code': 'publication_unavailable', 'message': 'Result retained; reader publication is not available.'})
                return
            base = self.module.store.query_one('SELECT task_id FROM wr_pdf_page WHERE book_id=? AND page_number=?',
                                               (job['book_id'], job['scope']['page_number']))
            self._update(job['id'], _publication_base_task=base['task_id'] if base else None)
            try:
                state = await hook(self._public(self._get(job['id'])), self._result(job))
                if state not in {'done', 'deferred', 'stale'}:
                    raise ValueError('invalid_publication_status')
                self._update(job['id'], publication={'done': 'applied', 'deferred': 'deferred', 'stale': 'stale'}[state],
                             error=None if state == 'done' else {'code': 'publication_' + state,
                                 'message': 'Result retained. The current reading edition was preserved because it could not be safely updated.'})
            except Exception as exc:
                try:
                    self._diagnostic(job['id'], 'publication', exc)
                except OSError:
                    pass
                self._update(job['id'], publication='deferred', error={'code': 'publication_failed',
                    'message': 'Response and normalized result retained. Local replay can retry publication without another service call.'})

    async def _run(self, job_id, replay=False):
        try:
            async with self.slots:
                job = self._get(job_id)
                if job['status'] not in ACTIVE:
                    return
                geometry = json.loads(self._material(job, 'geometry.json'))
                image = self._material(job, 'input.png')
                if not replay:
                    async with self.module.control_lock:
                        self._guard(job, network=True)
                        config = self._config()
                        current = self._get(job_id)
                        if current['status'] not in ACTIVE:
                            return
                        # Commit dispatch intent before the first byte can leave the host.
                        job = self._update(job_id, status='running', actual_called='possible',
                            dispatch_started_at=time.time(), cost={'status': 'unknown', 'amount': None, 'currency': None})
                    status, raw, redacted = await provider.request_image(config, image)
                    # Preserve bytes before parsing or reader publication, even after cancellation.
                    atomic(self._path(job_id, 'receipt.json'), json_bytes({
                        'status': status, 'body_b64': base64.b64encode(raw).decode(),
                        'sha256': sha(raw), 'redacted': redacted, 'received_at': time.time()}))
                    atomic(self._path(job_id, 'response.json'), raw)
                    with self.db() as db:
                        job = self._get(job_id, db)
                        job['_materials']['response.json'] = sha(raw)
                        job.update(actual_called='yes', response_received_at=time.time(),
                                   _http_status=status, _response_redacted=redacted,
                                   usage=provider.response_usage(raw), usage_origin='provider_response')
                        self._save(db, job)
                    if status != 200 or redacted:
                        raise ValueError('provider_response_rejected')
                else:
                    raw = self._material(job, 'response.json')
                current = self._get(job_id)
                if current['status'] == 'cancelled':
                    return
                page, usage = provider.normalize(raw, current, geometry)
                _, source = self.module.source_book(current['book_id'])
                assets = {}
                asset_pixels = 0
                for index, block in enumerate(page['blocks']):
                    if block['type'] == 'image_fallback':
                        box = block['source']['bbox']
                        asset_pixels += min(6_000_000, 4 * (box[2] - box[0]) * (box[3] - box[1]))
                        if len(assets) >= 32 or asset_pixels > 16_000_000:
                            raise ValueError('asset_budget_exceeded')
                        relative = f'normalized-assets/block-{index}.png'
                        path = self._path(job_id, relative)
                        await self._render(source, current['scope']['page_number'], block['source']['bbox'], path)
                        assets[relative] = sha(path.read_bytes())
                        block['asset'] = relative
                encoded = json_bytes(page)
                atomic(self._path(job_id, 'result.json'), encoded)
                async with self.module.control_lock:
                    current = self._get(job_id)
                    if current['status'] == 'cancelled':
                        return
                    self._guard(current)
                    job = self._update(job_id, status='completed', usage=usage, error=None,
                                       usage_origin='replayed_response' if replay else 'provider_response',
                                       _result_sha256=sha(encoded), _assets=assets)
                await self._apply(job)
        except asyncio.CancelledError:
            # close() classifies incomplete dispatches after tasks finish.
            raise
        except Exception as exc:
            # Do not expose raw provider errors, URL auth, image bytes or file paths.
            try:
                self._diagnostic(job_id, 'response_or_dispatch', exc)
            except OSError:
                pass
            with self.db() as db:
                current = self._get(job_id, db)
                if current['status'] == 'cancelled':
                    return
                sent = current['actual_called'] != 'no'
                received = current['response_received_at'] is not None or replay
                code = 'response_invalid' if received else 'result_unknown' if sent else 'pre_dispatch_failed'
                detail = getattr(exc, 'detail', None)
                if not sent and isinstance(detail, dict):
                    code = detail.get('code', code)
                current.update(status='unknown' if sent and not received else 'failed',
                    reservation_held=current['reservation_held'] if sent else False,
                    error={'code': code, 'message': 'The retained response could not be applied. Use local replay; no automatic resend.' if received
                           else 'The service may have received this request. No automatic resend; its usage remains reserved.' if sent
                           else 'Processing stopped before dispatch. No image request was sent.'})
                self._save(db, current)

    def pages_available(self, book_id, pages):
        """Rearm retained crops once per accepted base version, never dispatch.

        Called after reader commit/reconciliation and on startup. Persisting the
        version prevents duplicate page events or restarts from granting an
        unbounded retry budget. Applying remains outside the bridge lock in tick.
        """
        if not self.ready or self.closing:
            return
        versions = dict(pages)
        changed = False
        try:
            with self.db() as db:
                rows = db.execute("SELECT payload FROM jobs WHERE book=? AND status='completed'", (book_id,)).fetchall()
                for row in rows:
                    job = self._decode(row)
                    if job['publication'] not in {'pending', 'deferred'} or job['scope']['region'] is None:
                        continue
                    version = versions.get(job['scope']['page_number'])
                    if not version or job.get('_publication_base_task') == version:
                        continue
                    job.update(_publication_base_task=version, _publication_attempts=0)
                    self._save(db, job)
                    changed = True
            if changed:
                self.last_tick = 0.0  # Reuse the existing watcher; no new polling task.
        except (OSError, sqlite3.Error):
            # The reader commit already succeeded. Optional enhancement storage
            # failure must not undo or misreport it; startup can recover the event.
            log.warning('pdf_enhancement_base_event_unavailable book=%s', book_id)

    async def tick(self):
        if not self.ready or self.closing or time.monotonic() - self.last_tick < 10:
            return
        self.last_tick = time.monotonic()
        with self.db() as db:
            jobs = [self._decode(row) for row in db.execute("SELECT payload FROM jobs WHERE status='completed'")]
        for job in jobs:
            if job['publication'] in {'pending', 'deferred'} and job.get('_publication_attempts', 0) < 3:
                self._update(job['id'], _publication_attempts=job.get('_publication_attempts', 0) + 1)
                await self._apply(job)
