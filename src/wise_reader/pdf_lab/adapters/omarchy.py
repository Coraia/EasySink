"""Explicitly selected, bounded OCR on the user's fixed Omarchy SSH host.

Only a full-document authorization may send the original. ``pages`` may select
missing pages within that authorized full-document range during a resume.
Completion preserves an OCR candidate; it does not establish OCR accuracy.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import queue
import re
import shlex
from statistics import median
import subprocess
import threading
import time
import uuid

from .digital import union
from . import omarchy_layout


HOST = 'omarchy'
REMOTE_ROOT = 'apps/wise-reader-ocr'
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
               '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3']
MAX_EVENT_BYTES = 8 * 1024 * 1024
PROBE_TIMEOUT = 25
PAGE_GEOMETRY_TOLERANCE = 1e-5
MEDIUM_SHA256 = 'eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b'
_EXPECTED_SETTINGS = {
    'workers': 2, 'device': 'cuda', 'max_side': 2200, 'det_side': 736,
    'rec_batch': 64, 'text_score': 0.0, 'use_cls': False, 'max_retries': 1,
    'language': 'chinese_cht', 'deadline_seconds': 600,
    'page_timeout_seconds': 15, 'engine_start_timeout_seconds': 30,
}


def _sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False)


def _write_new(path, value):
    """Fresh run paths never replace a previous attempt's retained evidence."""
    import os
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf8') as handle:
            handle.write(_json(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _command(script, *arguments):
    # All nonconstant arguments are shell-quoted; the only expanded variable is
    # the remote user's HOME for this fixed, dedicated installation path.
    return ('"$HOME/' + REMOTE_ROOT + '/.venv/bin/python" -c ' +
            shlex.quote(script) + ' ' + ' '.join(shlex.quote(str(a)) for a in arguments))


def _ssh(command, *, timeout=PROBE_TIMEOUT, evidence=None):
    completed = subprocess.run(['ssh', '-T', *SSH_OPTIONS, HOST, command],
                               stdin=subprocess.DEVNULL, capture_output=True,
                               timeout=timeout, check=False)
    if evidence is not None:
        _write_new(evidence, {'returncode': completed.returncode,
                             'stdout': completed.stdout.decode('utf8', 'replace'),
                             'stderr': completed.stderr.decode('utf8', 'replace')})
    if completed.returncode:
        detail = completed.stderr.decode('utf8', 'replace').strip()
        if not detail:
            detail = completed.stdout.decode('utf8', 'replace').strip()
        raise RuntimeError(f'Omarchy SSH command failed ({completed.returncode}): {detail[:1200]}')
    if len(completed.stdout) > MAX_EVENT_BYTES:
        raise ValueError('Omarchy command output exceeds the protocol budget.')
    return json.loads(completed.stdout)


def omarchy_configuration():
    """Read actual remote file identity without loading models or using the GPU."""
    command = ('"$HOME/' + REMOTE_ROOT + '/.venv/bin/python" '
               '"$HOME/' + REMOTE_ROOT + '/omarchy_ocr_probe.py" --describe')
    remote = _ssh(command)
    if remote.get('protocol_version') != 1 or remote.get('engine') != 'rapidocr':
        raise ValueError('Unsupported Omarchy probe protocol or engine.')
    if remote.get('settings') != _EXPECTED_SETTINGS:
        raise ValueError('Omarchy probe settings differ from this adapter contract.')
    if not remote.get('versions') or not remote.get('models') or not remote.get('code'):
        raise ValueError('Omarchy probe omitted package, model or code identity.')
    override = remote.get('recognizer_override', {})
    if (override.get('sha256') != MEDIUM_SHA256 or
            override.get('path') != str(Path(remote['root']) / 'models' / 'PP-OCRv6_rec_medium.onnx')):
        raise ValueError('Omarchy probe did not select the pinned medium recognizer.')
    value = {'protocol_version': 1, 'host': HOST, 'remote': remote,
             'adapter_sha256': _sha(Path(__file__)),
             'scope_policy': 'explicit_full_document_only',
             'paragraph_policy': omarchy_layout.POLICY,
             'layout_sha256': _sha(Path(omarchy_layout.__file__))}
    value['configuration_sha256'] = hashlib.sha256(_json(value).encode()).hexdigest()
    return value


_CACHE = '''
import hashlib, json, os, pathlib, sys
root = pathlib.Path.home() / "apps" / "wise-reader-ocr"
source_sha, temporary_name, action = sys.argv[1:]
if len(source_sha) != 64 or any(c not in "0123456789abcdef" for c in source_sha):
    raise ValueError("Invalid source digest")
def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1048576), b""):
            h.update(data)
    return h.hexdigest()
directory = root / "sources"
directory.mkdir(parents=True, exist_ok=True)
target = directory / (source_sha + ".pdf")
if target.exists():
    if digest(target) != source_sha:
        raise RuntimeError("Retained source cache checksum mismatch; original preserved")
    print(json.dumps({"cached": True, "sha256": source_sha}))
elif action == "prepare":
    print(json.dumps({"cached": False, "sha256": source_sha}))
elif action == "commit":
    if pathlib.Path(temporary_name).name != temporary_name or not temporary_name.endswith(".upload"):
        raise ValueError("Invalid temporary source name")
    temporary = directory / temporary_name
    if digest(temporary) != source_sha:
        raise RuntimeError("Uploaded original checksum mismatch; temporary preserved")
    with temporary.open("rb") as stream:
        os.fsync(stream.fileno())
    try:
        os.link(temporary, target)
    except FileExistsError:
        if digest(target) != source_sha:
            raise RuntimeError("Concurrent source cache checksum mismatch")
    temporary.unlink()
    print(json.dumps({"cached": False, "uploaded": True, "sha256": source_sha}))
else:
    raise ValueError("Unknown cache operation")
'''


_LAUNCH = '''
import fcntl, hashlib, json, os, pathlib, runpy, sys
root = pathlib.Path.home() / "apps" / "wise-reader-ocr"
expected, source_sha, run_id, pages = json.loads(sys.argv[1]), *sys.argv[2:]
if len(source_sha) != 64 or any(c not in "0123456789abcdef" for c in source_sha):
    raise ValueError("Invalid source digest")
if len(run_id) != 32 or any(c not in "0123456789abcdef" for c in run_id):
    raise ValueError("Invalid run identifier")
lock = (root / ".inference.lock").open("a")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise RuntimeError("Another Wise Reader OCR job owns the Omarchy lock")
os.set_inheritable(lock.fileno(), True)
def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1048576), b""):
            h.update(data)
    return h.hexdigest()
probe_path = root / "omarchy_ocr_probe.py"
if digest(probe_path) != expected["remote"]["code"]["omarchy_ocr_probe.py"]:
    raise RuntimeError("Omarchy probe code changed after configuration capture")
actual = runpy.run_path(str(probe_path))["describe"]()
if actual != expected["remote"]:
    raise RuntimeError("Omarchy environment changed after configuration capture")
source = root / "sources" / (source_sha + ".pdf")
if digest(source) != source_sha:
    raise RuntimeError("Omarchy source changed before inference")
print(json.dumps({"event": "remote_ready", "source_sha256": source_sha,
                  "configuration_sha256": expected["configuration_sha256"]}), flush=True)
settings = actual["settings"]
arguments = [str(root / ".venv/bin/python"), str(root / "omarchy_ocr_parallel.py"),
             "--source", str(source), "--output", str(root / "runs" / run_id),
             "--pages", pages, "--workers", str(settings["workers"]),
             "--rec-batch", str(settings["rec_batch"]), "--max-side", str(settings["max_side"]),
             "--det-side", str(settings["det_side"]), "--deadline", str(settings["deadline_seconds"]),
             "--page-timeout", str(settings["page_timeout_seconds"]),
             "--engine-start-timeout", str(settings["engine_start_timeout_seconds"]),
             "--rec-medium-path", actual["recognizer_override"]["path"],
             "--stream-pages", "--watch-stdin"]
os.execv(arguments[0], arguments)
'''


class OmarchyAdapter:
    def __init__(self, source, output, digital, start_page, end_page, emit,
                 *, pages=None, expected_configuration=None):
        self.source, self.output, self.digital = Path(source).resolve(), Path(output).resolve(), digital
        stop = digital.page_count if end_page is None else end_page
        if start_page != 1 or stop != digital.page_count:
            raise ValueError('Omarchy requires explicit full-document authorization before original upload.')
        self.numbers = list(range(start_page, stop + 1)) if pages is None else list(pages)
        if (not self.numbers or any(type(n) is not int or not start_page <= n <= stop for n in self.numbers)
                or self.numbers != sorted(set(self.numbers))):
            raise ValueError('Omarchy processing pages must be a nonempty sorted unique authorized subset.')
        self.emit = emit or (lambda event: None)
        self.run_id = uuid.uuid4().hex
        self.directory = self.output / 'omarchy' / 'runs' / self.run_id
        self.directory.mkdir(parents=True, exist_ok=False)
        self.raw_directory = self.output / 'omarchy' / 'raw' / self.run_id
        self.raw_directory.mkdir(parents=True, exist_ok=False)
        self.process = self.reader = self.stderr = None
        self.events = queue.Queue(maxsize=8)
        self.stopped = threading.Event()
        self.received, self.returned, self.worker_manifests = {}, set(), {}
        self.page_errors, self.exhausted, self.empty_pages = {}, set(), set()
        self.remote_ready = self.finished = self.closed = False
        self.failure = None
        self.started = time.monotonic()
        self.original_stat = (self.source.stat().st_size, self.source.stat().st_mtime_ns)
        try:
            self.source_sha256 = _sha(self.source)
            self.configuration = omarchy_configuration()
            if expected_configuration is not None and self.configuration != expected_configuration:
                raise RuntimeError('Omarchy configuration changed from the task processing identity.')
            _write_new(self.directory / 'configuration.json', self.configuration)
            _write_new(self.directory / 'request.json', {
                'run_id': self.run_id, 'source_sha256': self.source_sha256,
                'authorized_range': [start_page, stop], 'processing_pages': self.numbers,
                'remote_run': REMOTE_ROOT + '/runs/' + self.run_id})
            self._check_source()
            temporary = f'.{self.source_sha256}.{self.run_id}.upload'
            cache = _ssh(_command(_CACHE, self.source_sha256, temporary, 'prepare'),
                         evidence=self.directory / 'source-cache.json')
            if not cache.get('cached'):
                started = time.monotonic()
                copied = subprocess.run(['scp', '-q', *SSH_OPTIONS, str(self.source),
                    f'{HOST}:{REMOTE_ROOT}/sources/{temporary}'], stdin=subprocess.DEVNULL,
                    capture_output=True, timeout=120, check=False)
                _write_new(self.directory / 'source-transfer.json', {
                    'returncode': copied.returncode, 'elapsed_ms': (time.monotonic() - started) * 1000,
                    'stderr': copied.stderr.decode('utf8', 'replace')})
                if copied.returncode:
                    raise RuntimeError('Omarchy original upload failed; see retained source-transfer.json.')
                self._check_source()
                _ssh(_command(_CACHE, self.source_sha256, temporary, 'commit'),
                     evidence=self.directory / 'source-cache-commit.json')
            self._check_source()
            command = _command(_LAUNCH, _json(self.configuration), self.source_sha256,
                               self.run_id, ','.join(map(str, self.numbers)))
            self.stderr = (self.directory / 'ssh.stderr').open('xb')
            self.process = subprocess.Popen(['ssh', '-T', *SSH_OPTIONS, HOST, command],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr)
            self.deadline = time.monotonic() + _EXPECTED_SETTINGS['deadline_seconds'] + 30
            self.reader = threading.Thread(target=self._read_stream, daemon=True)
            self.reader.start()
            self.emit({'event': 'omarchy_started', 'run_id': self.run_id,
                       'requested_pages': len(self.numbers), 'cached_source': bool(cache.get('cached'))})
        except BaseException as error:
            self._record_failure(error)
            self.close()
            raise

    def _record_failure(self, error):
        if self.failure is None:
            self.failure = error
            try:
                _write_new(self.directory / 'first-failure.json', {
                    'type': type(error).__name__, 'message': str(error),
                    'elapsed_ms': (time.monotonic() - self.started) * 1000})
            except OSError:
                pass

    def _check_source(self):
        if (self.source.stat().st_size, self.source.stat().st_mtime_ns) != self.original_stat:
            raise ValueError('Original PDF changed during Omarchy processing.')

    def _enqueue(self, value):
        while not self.stopped.is_set():
            # During close keep draining stdout into retained evidence, but do
            # not block the remote cancellation on an unconsumed local queue.
            if self.closed:
                return
            try:
                self.events.put(value, timeout=.2)
                return
            except queue.Full:
                pass

    def _read_stream(self):
        try:
            with (self.directory / 'events.jsonl').open('xb') as log:
                while not self.stopped.is_set():
                    raw = self.process.stdout.readline(MAX_EVENT_BYTES + 1)
                    if not raw:
                        break
                    log.write(raw)
                    log.flush()
                    if len(raw) > MAX_EVENT_BYTES or not raw.endswith(b'\n'):
                        raise ValueError('Omarchy emitted an oversized or incomplete protocol record.')
                    value = json.loads(raw)
                    if not isinstance(value, dict):
                        raise ValueError('Omarchy protocol record is not an object.')
                    self._enqueue(value)
        except Exception as error:
            self._enqueue(error)
        finally:
            self._enqueue(None)

    def _next(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Omarchy processing exceeded the bounded local deadline.')
        try:
            event = self.events.get(timeout=min(remaining, 1))
        except queue.Empty:
            return
        if isinstance(event, Exception):
            raise event
        if event is None:
            if not self.finished:
                raise RuntimeError('Omarchy stream ended before a verified final summary; see ssh.stderr.')
            return
        kind = event.get('event')
        if kind == 'remote_ready':
            if (self.remote_ready or event.get('source_sha256') != self.source_sha256 or
                    event.get('configuration_sha256') != self.configuration['configuration_sha256']):
                raise ValueError('Omarchy launch identity mismatch.')
            self.remote_ready = True
        elif kind == 'worker_ready':
            self._verify_worker(event)
        elif kind == 'page_completed':
            self._receive_page(event)
        elif kind == 'finished':
            self._verify_finished(event)
        elif kind in ('cancelled', 'invalid_stdout'):
            raise RuntimeError(f'Omarchy run stopped: {event}')
        elif kind == 'page_error':
            self._receive_error(event)
            self.emit({'event': 'omarchy_page_error', **{k: v for k, v in event.items() if k != 'event'}})
        else:
            raise ValueError(f'Unknown Omarchy event: {kind!r}')

    def _verify_worker(self, event):
        index, manifest = event.get('worker'), event.get('manifest', {})
        count = min(_EXPECTED_SETTINGS['workers'], len(self.numbers))
        if not self.remote_ready or type(index) is not int or not 0 <= index < count or index in self.worker_manifests:
            raise ValueError('Omarchy worker identity is missing, duplicated or outside the requested run.')
        remote = self.configuration['remote']
        settings = {k: v for k, v in _EXPECTED_SETTINGS.items()
                    if k not in ('workers', 'deadline_seconds', 'language')}
        expected = {
            'source_sha256': self.source_sha256, 'pages_requested': self.numbers[index::count],
            'versions': remote['versions'], 'models': remote['models'],
            'runner_sha256': remote['code']['omarchy_ocr_bench.py'],
            'settings': settings, 'language': _EXPECTED_SETTINGS['language'],
            'recognizer_override': remote['recognizer_override']['path'],
        }
        if any(manifest.get(key) != value for key, value in expected.items()):
            raise ValueError('Omarchy worker environment or processing configuration differs from the probe.')
        providers = manifest.get('providers', {})
        if any(not providers.get(name) or providers[name][0] != 'CUDAExecutionProvider'
               for name in ('text_det', 'text_rec')):
            raise RuntimeError('Omarchy worker did not use the required CUDA providers.')
        self.worker_manifests[index] = manifest

    def _receive_page(self, event):
        number, worker = event.get('page_number'), event.get('worker')
        if (type(number) is not int or number not in self.numbers or number in self.received or
                worker not in self.worker_manifests or
                number not in self.worker_manifests[worker]['pages_requested']):
            raise ValueError('Omarchy returned a duplicate, unexpected or unverified page.')
        page = event.get('page')
        raw_path = self.raw_directory / f'p{number:06d}.json'
        _write_new(raw_path, {'event': event, 'canonical_page': page, 'raw': event.get('raw')})
        if not isinstance(page, dict) or page.get('page_number') != number or page.get('source_sha256') != self.source_sha256:
            raise ValueError('Omarchy page source identity mismatch.')
        if page.get('attempt') != len(self.page_errors.get(number, [])) + 1 or number in self.exhausted:
            raise ValueError('Omarchy completed-page attempt does not match the retained retry history.')
        self._validate_raw(page, event.get('raw'))
        if page.get('quality_state') == 'ocr_empty':
            self.empty_pages.add(number)
        self.received[number] = raw_path

    def _receive_error(self, event):
        number, worker, attempt = event.get('page_number'), event.get('worker'), event.get('attempt')
        if (type(number) is not int or number not in self.numbers or number in self.received or
                worker not in self.worker_manifests or
                number not in self.worker_manifests[worker]['pages_requested'] or
                type(attempt) is not int or not 1 <= attempt <= _EXPECTED_SETTINGS['max_retries'] + 1):
            raise ValueError('Omarchy returned an invalid page-error identity or attempt.')
        errors = self.page_errors.setdefault(number, [])
        if attempt != len(errors) + 1:
            raise ValueError('Omarchy page-error attempts are duplicated or out of order.')
        _write_new(self.directory / 'errors' / f'p{number:06d}-attempt{attempt}.json', event)
        errors.append(event)
        if attempt == _EXPECTED_SETTINGS['max_retries'] + 1:
            self.exhausted.add(number)

    @staticmethod
    def _validate_raw(page, raw):
        if not isinstance(raw, dict) or raw.get('page_number') != page['page_number']:
            raise ValueError('Omarchy did not retain the original OCR line response.')
        boxes, texts, scores = raw.get('boxes'), raw.get('texts'), raw.get('scores')
        blocks = page.get('blocks')
        if (not all(isinstance(v, list) for v in (boxes, texts, scores, blocks)) or
                not len(boxes) == len(texts) == len(scores) == len(blocks)):
            raise ValueError('Omarchy raw/canonical OCR line cardinalities differ.')
        if raw.get('original_dimensions') != [page.get('width'), page.get('height')]:
            raise ValueError('Omarchy raw/canonical page geometry differs.')
        width, height = page.get('width'), page.get('height')
        if not all(_finite(value) and value > 0 for value in (width, height)):
            raise ValueError('Omarchy page dimensions are invalid.')
        pixels = raw.get('pixel_dimensions')
        if not isinstance(pixels, list) or len(pixels) != 2 or any(type(v) is not int or v <= 0 for v in pixels):
            raise ValueError('Omarchy OCR input pixel dimensions are invalid.')
        for polygon, text, score, block in zip(boxes, texts, scores, blocks):
            if (not isinstance(text, str) or not _finite(score) or not 0 <= score <= 1 or
                    block.get('text') != text or block.get('confidence') != score or
                    not isinstance(polygon, list) or len(polygon) != 4):
                raise ValueError('Omarchy raw OCR content differs from canonical line records.')
            if any(not isinstance(point, list) or len(point) != 2 or not all(_finite(v) for v in point)
                   for point in polygon):
                raise ValueError('Omarchy raw OCR polygon is invalid.')
            xs = [point[0] * width / pixels[0] for point in polygon]
            ys = [point[1] * height / pixels[1] for point in polygon]
            mapped = [min(xs), min(ys), max(xs), max(ys)]
            if not (-PAGE_GEOMETRY_TOLERANCE <= mapped[0] < mapped[2] <= width + PAGE_GEOMETRY_TOLERANCE
                    and -PAGE_GEOMETRY_TOLERANCE <= mapped[1] < mapped[3] <= height + PAGE_GEOMETRY_TOLERANCE):
                raise ValueError('Omarchy raw OCR polygon lies outside the visible source page.')
            box = block.get('source', {}).get('bbox')
            if (not isinstance(box, list) or len(box) != 4 or not all(_finite(v) for v in box) or
                    any(abs(a-b) > PAGE_GEOMETRY_TOLERANCE for a, b in zip(mapped, box))):
                raise ValueError('Omarchy canonical line bbox differs from its raw OCR polygon.')

    def _verify_finished(self, event):
        remote = self.configuration['remote']
        identity = {'protocol_version': 1, 'source_sha256': self.source_sha256,
                    'pages_requested': self.numbers, 'workers': _EXPECTED_SETTINGS['workers'],
                    'rec_batch': _EXPECTED_SETTINGS['rec_batch'], 'max_side': _EXPECTED_SETTINGS['max_side'],
                    'det_side': _EXPECTED_SETTINGS['det_side'],
                    'page_timeout_seconds': _EXPECTED_SETTINGS['page_timeout_seconds'],
                    'engine_start_timeout_seconds': _EXPECTED_SETTINGS['engine_start_timeout_seconds'],
                    'runner_sha256': remote['code']['omarchy_ocr_parallel.py'],
                    'worker_sha256': remote['code']['omarchy_ocr_bench.py'],
                    'recognizer_override': remote['recognizer_override']}
        count = min(_EXPECTED_SETTINGS['workers'], len(self.numbers))
        if (self.finished or event.get('identity') != identity or
                event.get('requested') != len(self.numbers) or event.get('completed') != len(self.received) or
                event.get('missing_pages') != sorted(self.exhausted) or
                set(self.received) | self.exhausted != set(self.numbers) or
                set(self.received) & self.exhausted or
                len(self.worker_manifests) != count):
            raise RuntimeError('Omarchy final source/configuration/page coverage verification failed.')
        exits = event.get('exit_codes', {})
        if event.get('empty_ocr') != len(self.empty_pages) or len(exits) != count:
            raise RuntimeError('Omarchy final empty-page or worker-exit accounting mismatch.')
        for index in range(count):
            assigned = set(self.worker_manifests[index]['pages_requested'])
            expected_exit = 2 if assigned & (self.exhausted | self.empty_pages) else 0
            if exits.get(str(index)) != expected_exit:
                raise RuntimeError('Omarchy has an unexplained worker exit; original evidence retained.')
            summary = event.get('workers', {}).get(str(index), {})
            if (summary.get('source_sha256') != self.source_sha256 or
                    summary.get('requested') != len(assigned) or
                    summary.get('completed') != len(assigned - self.exhausted) or
                    summary.get('empty_ocr') != len(assigned & self.empty_pages) or
                    sorted(error.get('page_number') for error in summary.get('failures', [])) !=
                    sorted(assigned & self.exhausted)):
                raise RuntimeError('Omarchy worker final page/error accounting differs from its stream.')
        returncode = self.process.wait(timeout=min(10, max(.1, self.deadline - time.monotonic())))
        expected_exit = 2 if self.exhausted or self.empty_pages else 0
        if returncode != expected_exit:
            raise RuntimeError(f'Omarchy SSH process exited with {returncode}; see ssh.stderr.')
        _write_new(self.directory / 'verified-result.json', event)
        self.finished = True

    def convert_page(self, number):
        if self.closed or self.failure is not None:
            raise RuntimeError('Omarchy adapter is closed or failed.')
        if number not in self.numbers or number in self.returned:
            raise ValueError('Page is outside the requested missing-page set or already consumed.')
        try:
            self._check_source()
            while number not in self.received and number not in self.exhausted:
                self._next()
            if len(self.returned) + 1 == len(self.numbers):
                while not self.finished:
                    self._next()
            if number in self.exhausted:
                page = self._failed_page(number)
            else:
                raw = json.loads(self.received[number].read_text(encoding='utf8'))
                page = self._normalize(raw['canonical_page'], self.received[number])
            self._add_resilience(page, number)
            self.returned.add(number)
            return page
        except BaseException as error:
            self._record_failure(error)
            self.close()
            raise

    def _add_resilience(self, page, number):
        errors = self.page_errors.get(number, [])
        attempts = [{'attempt': error['attempt'], 'status': 'failed',
                     'error': {'message': error.get('message', ''), 'type': error.get('type', 'RemotePageError'),
                               'category': error.get('category', 'remote_page_error')}} for error in errors]
        if number not in self.exhausted:
            attempts.append({'attempt': page.get('attempt', len(errors) + 1), 'status': 'succeeded'})
        page['resilience'] = {'attempts': attempts, 'fallback': number in self.exhausted or number in self.empty_pages,
                              'empty_ocr': number in self.empty_pages,
                              'page_timeout_seconds': _EXPECTED_SETTINGS['page_timeout_seconds']}

    def _failed_page(self, number):
        width, height, _, crop, media = self.digital.geometry(number)
        raw_path = self.raw_directory / f'p{number:06d}-failed.json'
        _write_new(raw_path, {'page_number': number, 'source_sha256': self.source_sha256,
                             'errors': self.page_errors[number], 'ocr_completed': False})
        page = {'page_number': number, 'width': width, 'height': height,
                'rotation': self.digital.pdf.pages[number - 1].rotation, 'crop_box': crop, 'media_box': media,
                'coordinate_space': 'rotated_crop_top_left', 'extraction_method': 'original_fallback',
                'raw_result_path': raw_path.relative_to(self.output).as_posix(),
                'source_sha256': self.source_sha256, 'non_content_objects': [],
                'warnings': ['Omarchy page recognition exhausted its bounded attempts; later pages continue.']}
        return self._fallback(page, 'page_conversion_failed_after_retries')

    def _normalize(self, raw, raw_path):
        number = raw['page_number']
        width, height, _, crop, media = self.digital.geometry(number)
        page = {**raw, 'rotation': self.digital.pdf.pages[number - 1].rotation,
                'crop_box': crop, 'media_box': media, 'text': '', 'blocks': [],
                'raw_result_path': raw_path.relative_to(self.output).as_posix(),
                'quality_state': 'candidate', 'warnings': [
                    'Actual Omarchy OCR candidate; independent accuracy and layout acceptance remain pending.'],
                'non_content_objects': [], 'ocr_backend': 'RapidOCR/CUDA',
                'omarchy_configuration_sha256': self.configuration['configuration_sha256']}
        if (not all(_finite(raw.get(key)) for key in ('width', 'height')) or
                abs(raw['width'] - width) > PAGE_GEOMETRY_TOLERANCE or
                abs(raw['height'] - height) > PAGE_GEOMETRY_TOLERANCE or
                raw.get('coordinate_space') != 'rotated_crop_top_left'):
            page.update(width=width, height=height, coordinate_space='rotated_crop_top_left')
            return self._fallback(page, 'unverified_ocr_geometry')
        lines = raw['blocks']
        identifiers = set()
        for line in lines:
            box = line.get('source', {}).get('bbox')
            if (not isinstance(box, list) or len(box) != 4 or not all(_finite(v) for v in box) or
                    not 0 <= box[0] < box[2] <= width or not 0 <= box[1] < box[3] <= height or
                    line['source'].get('page_number') != number or
                    line['source'].get('coordinate_space') != 'rotated_crop_top_left' or
                    not isinstance(line.get('id'), str) or line['id'] in identifiers):
                raise ValueError(f'Omarchy page {number} has invalid line identity or source geometry.')
            identifiers.add(line['id'])
        nonempty = [line for line in lines if line['text'].strip()]
        if not nonempty:
            return self._fallback(page, 'ocr_empty')
        reason, bands = _ambiguous_regions(nonempty, width, height, page['rotation'])
        if reason and bands is None:
            if reason in ('vertical_reading_order_unverified', 'nonmonotonic_reading_order_unverified',
                          'overlapping_ocr_regions_unverified'):
                recovery = omarchy_layout.recover_prose_regions(nonempty, width, height)
                recovered = self._layout_blocks(recovery, page) if recovery else None
                if recovered:
                    page.update(blocks=recovered, quality_state='candidate_with_fallback',
                                layout_policy=omarchy_layout.REGIONAL_POLICY)
                    page['text'] = '\n\n'.join(block['text'] for block in recovered if block['text'])
                    page['warnings'].append('Only isolated horizontal prose recovered; remaining full-width source bands retain images.')
                    return self._preserve_source_artwork(page, nonempty)
            return self._fallback(page, reason)
        recovery = (omarchy_layout.recover_layout(nonempty, width, height)
                    if reason == 'multicolumn_or_table_unverified' else None)
        recovered_blocks = self._layout_blocks(recovery, page) if recovery else None
        if reason == 'multicolumn_or_table_unverified' and not recovered_blocks:
            recovery = omarchy_layout.recover_prose_regions(nonempty, width, height)
            recovered_blocks = self._layout_blocks(recovery, page) if recovery else None
            if recovered_blocks:
                page.update(blocks=recovered_blocks, quality_state='candidate_with_fallback',
                            layout_policy=omarchy_layout.REGIONAL_POLICY)
                page['text'] = '\n\n'.join(block['text'] for block in recovered_blocks if block['text'])
                page['warnings'].append('Only isolated horizontal prose recovered; surrounding diagrams retain full-width source images.')
                return self._preserve_source_artwork(page, nonempty)
        if recovered_blocks:
            page['blocks'] = recovered_blocks
            page['layout_policy'] = omarchy_layout.POLICY
            page['quality_state'] = ('candidate_with_fallback' if any(
                b['type'] == 'image_fallback' for b in page['blocks']) else 'candidate')
            page['warnings'].append('Bounded OCR-box prose ordering; uncertain side regions retain images.')
        elif bands:
            page['blocks'] = self._regional_blocks(nonempty, page, reason, bands)
            page['quality_state'] = 'candidate_with_fallback'
            page['warnings'].append('Ambiguous layout bands retain original images; OCR text outside those bands remains a candidate.')
        else:
            page['blocks'] = _paragraphs(nonempty, number)
        page['text'] = '\n\n'.join(block['text'] for block in page['blocks'] if block['text'])
        if not page['text'] and any(block['type'] == 'image_fallback' for block in page['blocks']):
            page['quality_state'] = 'image_fallback'
        return self._preserve_source_artwork(page, nonempty)

    def _preserve_source_artwork(self, page, lines):
        """OCR rows alone cannot establish that a scanned page has no artwork."""
        if not page['text'] or not self.digital.pdf.pages[page['page_number'] - 1].images:
            return page
        covered = [b['source']['bbox'] for b in page['blocks'] if b.get('asset')]
        original = self.digital.renderer[page['page_number'] - 1]
        try:
            bitmap = original.render(scale=min(640 / page['width'], 1100 / page['height']),
                                     limit_image_cache=True)
            try:
                bands = omarchy_layout.uncovered_image_bands(bitmap.to_pil(), lines, covered,
                                                            page['width'], page['height'])
            finally:
                bitmap.close()
        finally:
            original.close()
        if not bands:
            return page
        number = page['page_number']
        for index, box in enumerate(bands):
            contained = [b for b in page['blocks'] if b.get('asset') and
                         box[0] <= b['source']['bbox'][0] and box[1] <= b['source']['bbox'][1] and
                         box[2] >= b['source']['bbox'][2] and box[3] >= b['source']['bbox'][3]]
            page['blocks'] = [b for b in page['blocks'] if b not in contained]
            page['blocks'].append({'type': 'image', 'text': '',
                'source': {'page_number': number, 'bbox': box,
                           'coordinate_space': 'rotated_crop_top_left',
                           'ocr_line_ids': [lid for b in contained for lid in b['source'].get('ocr_line_ids', [])]},
                'asset': self.digital.crop_asset(number, box, f'omarchy-artwork-{index + 1:03d}',
                                                native_raster_limit=True),
                'source_type': 'unclassified_source_pixels'})
        # Insert images without changing the established order of any text
        # blocks (especially already verified left/right column ordering).
        pictures = [b for b in page['blocks'] if b.get('source_type') == 'unclassified_source_pixels']
        page['blocks'] = [b for b in page['blocks'] if b not in pictures]
        for picture in sorted(pictures, key=lambda b: b['source']['bbox'][1], reverse=True):
            index = next((i for i, b in enumerate(page['blocks'])
                          if b['source']['bbox'][1] >= picture['source']['bbox'][1]), len(page['blocks']))
            page['blocks'].insert(index, picture)
        for index, block in enumerate(page['blocks']):
            block['id'] = f'p{number:06d}-b{index + 1:05d}'
        page['warnings'].append('Unrepresented source artwork retained as original image; OCR text remains selectable.')
        return page

    def _layout_blocks(self, plan, page):
        number = page['page_number']
        blocks = []
        if any(_ambiguous_regions(segment['lines'], page['width'], page['height'], 0)[0]
               for segment in plan if segment['kind'] == 'text'):
            return None
        for index, segment in enumerate(plan):
            if segment['kind'] == 'text':
                part = _paragraphs(segment['lines'], number,
                    layout_recovered=True, around_sidebar=segment.get('role') == 'body_around_sidebar')
                cap = segment.get('drop_cap')
                if cap:
                    first = part[0]
                    first['text'] = cap['text'] + first['text']
                    first['raw_text'] = cap['text'] + '\n' + first['raw_text']
                    first['source']['bbox'] = union([first['source']['bbox'], cap['source']['bbox']])
                    first['source']['lines'].insert(0, {'id': cap['id'], 'text': cap['text'],
                        'bbox': list(cap['source']['bbox']), 'confidence': cap['confidence']})
                for block in part:
                    block['layout_role'] = segment.get('role', 'body')
                blocks.extend(part)
            else:
                box = segment.get('bbox') or omarchy_layout.bounds(segment['lines'])
                margin = min(2, (box[3] - box[1]) * .02)
                box = [max(0, box[0] - margin), max(0, box[1] - margin),
                       min(page['width'], box[2] + margin), min(page['height'], box[3] + margin)]
                blocks.append({'type': 'image_fallback', 'text': '',
                    'source': {'page_number': number, 'bbox': box,
                               'coordinate_space': 'rotated_crop_top_left',
                               'ocr_line_ids': [line['id'] for line in segment['lines']]},
                    'asset': self.digital.crop_asset(number, box, f'omarchy-region-{index + 1:03d}',
                                                    native_raster_limit=True),
                    'fallback_reason': segment['reason']})
        for index, block in enumerate(blocks):
            block['id'] = f'p{number:06d}-b{index + 1:05d}'
        return blocks

    def _regional_blocks(self, lines, page, reason, bands):
        number, width = page['page_number'], page['width']
        blocks, remaining = [], list(lines)
        for index, (top, bottom) in enumerate(bands):
            before = [line for line in remaining if line['source']['bbox'][3] <= top]
            if before:
                blocks.extend(_paragraphs(before, number))
            remaining = [line for line in remaining if line['source']['bbox'][1] >= bottom]
            box = [0, top, width, bottom]
            blocks.append({'type': 'image_fallback', 'text': '',
                'source': {'page_number': number, 'bbox': box, 'coordinate_space': 'rotated_crop_top_left'},
                'asset': self.digital.crop_asset(number, box, f'omarchy-layout-{index + 1:03d}',
                                                native_raster_limit=True),
                'fallback_reason': reason})
        if remaining:
            blocks.extend(_paragraphs(remaining, number))
        for index, block in enumerate(blocks):
            block['id'] = f'p{number:06d}-b{index + 1:05d}'
        return blocks

    def _fallback(self, page, reason):
        number, width, height = page['page_number'], page['width'], page['height']
        box = [0, 0, width, height]
        page.update(quality_state='image_fallback', text='', blocks=[{
            'id': f'p{number:06d}-b00001', 'type': 'image_fallback', 'text': '',
            'source': {'page_number': number, 'bbox': box, 'coordinate_space': 'rotated_crop_top_left'},
            'asset': self.digital.crop_asset(number, box, 'omarchy-' + reason, native_raster_limit=True),
            'fallback_reason': reason}])
        page['warnings'].append('OCR/layout was not verified; original image retained, not successful structure recognition.')
        return page

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process is not None:
            if self.process.stdin is not None:
                try:
                    self.process.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=2)
        self.stopped.set()
        if self.reader is not None:
            self.reader.join(timeout=2)
        if self.stderr is not None:
            self.stderr.close()
        if self.process is not None and self.process.stdout is not None and not (self.reader and self.reader.is_alive()):
            self.process.stdout.close()


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _ambiguous_layout(lines, width, height, rotation):
    return _ambiguous_regions(lines, width, height, rotation)[0]


def _ambiguous_regions(lines, width, height, rotation):
    if rotation in (90, 270):
        return 'rotated_reading_order_unverified', None
    boxes = [line['source']['bbox'] for line in lines]
    split_rows, ambiguous = set(), set()
    for index, box in enumerate(boxes):
        if box[3] - box[1] > 2 * (box[2] - box[0]) and len(lines[index]['text']) > 3:
            return 'vertical_reading_order_unverified', None
        for other_index in range(index + 1, len(boxes)):
            other = boxes[other_index]
            overlap = min(box[3], other[3]) - max(box[1], other[1])
            line_height = min(box[3] - box[1], other[3] - other[1])
            horizontal_overlap = min(box[2], other[2]) - max(box[0], other[0])
            small_area = min((box[2] - box[0]) * (box[3] - box[1]),
                             (other[2] - other[0]) * (other[3] - other[1]))
            if overlap > line_height * .4 and horizontal_overlap > 0 and overlap * horizontal_overlap > small_area * .35:
                return 'overlapping_ocr_regions_unverified', None
            gap = max(other[0] - box[2], box[0] - other[2])
            if overlap > line_height * .5 and gap > line_height * .75:
                split_rows.add(index)
                ambiguous.update((index, other_index))
        if index and box[1] < boxes[index - 1][1] - (box[3] - box[1]):
            return 'nonmonotonic_reading_order_unverified', None
    formula_lines = {index for index, line in enumerate(lines)
                     if re.search(r'[∑∫√≤≥≠±]|\\(?:frac|begin|sqrt)\b|\|[^|]+\|[^|]+\|', line['text'])}
    if len(split_rows) >= 3:
        reason = 'multicolumn_or_table_unverified'
        ambiguous.update(formula_lines)
    elif formula_lines:
        reason, ambiguous = 'formula_or_table_unverified', formula_lines
    else:
        return None, []
    line_height = median(box[3] - box[1] for box in boxes)
    margin = max(1, line_height * .15)
    bands = [[max(0, boxes[index][1] - margin), min(height, boxes[index][3] + margin)]
             for index in ambiguous]
    # Expand every intersecting line into the image band, then merge contiguous
    # bands. Iterate until no candidate line could be partly clipped or repeated.
    while True:
        previous = sorted(bands)
        expanded = []
        for top, bottom in previous:
            intersecting = [box for box in boxes if box[1] < bottom and box[3] > top]
            if intersecting:
                top = max(0, min(top, min(box[1] for box in intersecting) - margin))
                bottom = min(height, max(bottom, max(box[3] for box in intersecting) + margin))
            expanded.append([top, bottom])
        bands = []
        for top, bottom in sorted(expanded):
            if bands and top <= bands[-1][1] + line_height * 1.3:
                bands[-1][1] = max(bands[-1][1], bottom)
            else:
                bands.append([top, bottom])
        if bands == previous:
            return reason, bands


def _join_text(previous, following):
    if not previous or not following:
        return previous + following
    def cjk(char):
        return '\u2e80' <= char <= '\u9fff' or '\uf900' <= char <= '\ufaff' or '\U00020000' <= char <= '\U000323af'
    separator = '' if (cjk(previous[-1]) or cjk(following[0]) or
                       following[0] in '，。！？；：、）】》」』,.;:!?)]}' or
                       previous[-1] in '（【《「『([{') else ' '
    return previous + separator + following


def _paragraphs(lines, number, *, layout_recovered=False, around_sidebar=False):
    heights = [line['source']['bbox'][3] - line['source']['bbox'][1] for line in lines]
    body_height = median(heights)
    widths = sorted(line['source']['bbox'][2] - line['source']['bbox'][0] for line in lines)
    body_width = widths[min(len(widths) - 1, int(len(widths) * .8))]
    blocks = []
    for line, line_height in zip(lines, heights):
        box, text = line['source']['bbox'], line['text'].strip()
        kind = 'heading' if line_height > body_height * 1.35 else 'paragraph'
        if (layout_recovered and len(text) <= 8 and box[2] - box[0] < body_width * .35
                and not re.search(r'[，。；！？、,;.!?0-9]', text)):
            kind = 'heading'
        if re.match(r'^(?:[•●▪◦]|\d{1,3}[.)、])\s*', text):
            kind = 'list'
        record = {'id': line['id'], 'text': line['text'], 'bbox': list(box),
                  'confidence': line['confidence']}
        previous = blocks[-1] if blocks else None
        merge = False
        if previous and kind == previous['type'] == 'paragraph':
            last = previous['source']['lines'][-1]['bbox']
            previous_height = last[3] - last[1]
            base_left = min(item['bbox'][0] for item in previous['source']['lines'])
            same_left = abs(box[0] - base_left) <= line_height * .6
            wrap_expands_left = (around_sidebar and box[0] < base_left and
                                 abs(box[2] - last[2]) <= line_height * .6 and
                                 not re.search(r'[。！？.!?][”’\"\']?$', previous['text']))
            first_indent = (len(previous['source']['lines']) == 1 and
                            (1.05 if layout_recovered else 1.2) * line_height <=
                            last[0] - box[0] <= 2.8 * line_height)
            font_compatible = (.8 <= previous_height / line_height <= 1.25 or
                               (wrap_expands_left and .7 <= previous_height / line_height <= 1.4))
            merge = (font_compatible and
                     (-.2 if layout_recovered else -.1) * line_height <=
                     box[1] - last[3] <= .9 * line_height and
                     (box[2] <= last[2] + line_height * 1.5 or
                      (around_sidebar and (same_left or wrap_expands_left))) and
                     last[2] - last[0] >= body_width * .65 and (same_left or first_indent or wrap_expands_left))
        if merge:
            previous['text'] = _join_text(previous['text'], text)
            previous['raw_text'] += '\n' + line['text']
            previous['source']['bbox'] = union([previous['source']['bbox'], box])
            previous['source']['lines'].append(record)
        else:
            blocks.append({'id': f'p{number:06d}-b{len(blocks) + 1:05d}', 'type': kind,
                'text': text, 'raw_text': line['text'], 'asset': None,
                'source': {'page_number': number, 'bbox': list(box),
                           'coordinate_space': 'rotated_crop_top_left', 'lines': [record]}})
    return blocks
