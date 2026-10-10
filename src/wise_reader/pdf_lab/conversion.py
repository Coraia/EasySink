"""Isolated lab conversion boundary, atomic publication and cheap capability probe."""
from __future__ import annotations

import importlib.util
import hashlib
import json
import math
import multiprocessing
import os
import platform
import queue
import re
import resource
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from .adapters.mineru import asset_holders, validate_formula_contract
from .adapters.mineru_runtime import mineru_runtime_status, discover_mineru_runtime, MinerURuntimeUnavailable

from .readiness import omarchy_capability as _omarchy_capability

ROOT = Path(__file__).resolve().parents[3]
PROCESSING_VERSION = 3
MAX_PAGE_JSON_BYTES = 32 * 1024 * 1024
MAX_INDEX_JSON_BYTES = 16 * 1024 * 1024
MAX_ASSET_BYTES = 64 * 1024 * 1024
MAX_ASSET_PIXELS = 16_000_000
ASSET_SCALE = 4.0
PAGE_ATTEMPTS = 2
PAGE_TIMEOUT_SECONDS = 60.0


def model_directory() -> Path:
    return Path(os.environ.get('PDF_LAB_MODELS_DIR', ROOT / '.venv-pdf-lab' / 'models')).resolve()


def _version(name):
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def get_capabilities(*, include_remote=True):
    digital = all(importlib.util.find_spec(p) is not None for p in ['pdfplumber','pypdfium2'])
    installed = all(importlib.util.find_spec(p) is not None for p in ['docling','ocrmac'])
    ready = False
    try:
        manifest = json.loads(model_directory().joinpath('pdf-lab-ready.json').read_text())
        ready = manifest.get('docling') == _version('docling') and bool(manifest.get('models')) and all(
            model_directory().joinpath(item['file']).is_file() and model_directory().joinpath(item['file']).stat().st_size == item['bytes']
            for item in manifest['models'])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    result = {'adapters': [
        {'id':'digital','label':'Digital text (local, no OCR)','available':digital,
         'missing_reason':None if digital else 'Install requirements-pdf-lab.txt in .venv-pdf-lab.',
         'supports_ocr':False,'version':_version('pdfplumber')},
        {'id':'docling','label':'Docling + Apple Vision OCR (local candidate)','available':installed and ready,
         'missing_reason':None if installed and ready else ('Local model preparation is incomplete.' if installed else 'Docling/ocrmac dependencies are not installed.'),
         'supports_ocr':True,'version':_version('docling')},
    ], 'cloud_enabled':False, 'supported_actions':['convert'] if digital else [],
        'storage': {'schema_versions': [1, 2], 'sharded': True, 'resume': True,
                    'page_path_pattern': 'pages/p{page_number:06d}.json'},
        'processing_version': PROCESSING_VERSION,
        'asset_policy': {'target_scale': ASSET_SCALE, 'max_pixels': MAX_ASSET_PIXELS,
                         'max_bytes': MAX_ASSET_BYTES}}
    mineru = mineru_runtime_status()
    if mineru['available'] and (not digital or importlib.util.find_spec('psutil') is None):
        mineru.update(available=False, missing_reason='Local PDF renderer/resource monitor dependencies are missing.')
    if mineru['available']:
        mineru['configuration_identity'] = hashlib.sha256(json.dumps(
            processing_config('mineru_source', False), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    result['adapters'].append({'id': 'mineru_source', 'label': '公式与复杂排版（原式优先）',
                               'supports_ocr': True, **mineru})
    if include_remote:
        result['adapters'].append(_omarchy_capability(digital))
    return result


# A friendly alias for backend probes; the CLI remains the shared contract.
capabilities = get_capabilities


def atomic_json(path: Path, value, max_bytes=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f'.{path.name}.',suffix='.tmp',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as stream:
            written = 0
            for chunk in json.JSONEncoder(ensure_ascii=False, allow_nan=False).iterencode(value):
                written += len(chunk.encode('utf-8'))
                if max_bytes is not None and written + 1 > max_bytes:
                    raise ValueError('JSON exceeds the independent storage budget before publication.')
                stream.write(chunk)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name,path)
        directory_fd = os.open(path.parent,os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def classify_error(error):
    if isinstance(error, PageAttemptError): return error.category
    if isinstance(error, MinerURuntimeUnavailable): return 'runtime_not_ready'
    message = str(error).lower()
    if isinstance(error, ModuleNotFoundError): return 'dependency_not_ready'
    if isinstance(error, OSError) and error.errno == 28: return 'space_insufficient'
    if 'password' in message or 'encrypted' in message: return 'password_required'
    if 'model' in message and ('missing' in message or 'not ready' in message or 'offline' in message): return 'model_not_ready'
    if 'resume identity' in message: return 'resume_identity_mismatch'
    if 'source pdf changed' in message: return 'source_changed'
    if isinstance(error, ValueError) and 'range' in message: return 'invalid_page_range'
    if 'output already' in message: return 'output_exists'
    if 'another conversion' in message: return 'output_in_use'
    if any(term in message for term in ['pdf header','pdfsyntax','no /root','not a pdf','failed to load document']): return 'format_unreadable'
    return 'conversion_failed'


class PageAttemptError(RuntimeError):
    def __init__(self, message, *, category='page_conversion_failed', retryable=False, error_type='RuntimeError'):
        super().__init__(message)
        self.category, self.retryable, self.error_type = category, retryable, error_type


def _retryable_page_error(error):
    # Storage, resource, identity and process-control failures are never converted
    # into apparent page success. Unknown exception classes fail the whole task.
    if isinstance(error, (OSError, ImportError, MemoryError)):
        return False
    message = str(error).lower()
    fatal = ('identity', 'checksum', 'source pdf changed', 'checkpoint', 'unsafe',
             'asset', 'storage', 'no space', 'disk quota', 'password', 'encrypt',
             'permission', 'model', 'dependency', 'offline', 'out of memory',
             'cannot allocate', 'cancel', 'interrupt', 'aborted')
    if any(term in message for term in fatal):
        return False
    return isinstance(error, (ValueError, TypeError, KeyError, IndexError, RuntimeError)) or (
        type(error).__name__ == 'ConversionError' and type(error).__module__.startswith('docling'))


def _original_page_fallback(digital, number):
    width, height, _, crop, _ = digital.geometry(number)
    box = [0, 0, width, height]
    return {'page_number': number, 'width': width, 'height': height,
            'rotation': digital.pdf.pages[number - 1].rotation, 'crop_box': crop,
            'coordinate_space': 'rotated_crop_top_left', 'extraction_method': 'original_fallback',
            'quality_state': 'image_fallback', 'text': '',
            'warnings': ['Page recognition failed after bounded attempts; original retained, not successful OCR.'],
            'blocks': [{'id': f'p{number:06d}-b00001', 'type': 'image_fallback', 'text': '',
                        'source': {'page_number': number, 'bbox': box},
                        'asset': digital.crop_asset(number, box, 'page-error-original'),
                        'fallback_reason': 'page_conversion_failed_after_retries'}]}


def _page_engine_main(connection, source, output, engine, ocr_ready):
    """A warm, disposable process: a hung native engine can actually be stopped."""
    sys.stdout = sys.stderr  # Spawn must not mix dependency banners into JSONL.
    from .adapters.digital import DigitalAdapter

    # multiprocessing spawn does not inherit the CLI's Python socket guards.
    original_connect, original_connect_ex = socket.socket.connect, socket.socket.connect_ex
    def local_connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise PermissionError('PDF lab conversion disables Internet sockets.')
        return original_connect(sock, address)
    def local_connect_ex(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise PermissionError('PDF lab conversion disables Internet sockets.')
        return original_connect_ex(sock, address)
    socket.socket.connect, socket.socket.connect_ex = local_connect, local_connect_ex
    digital = ocr = None
    try:
        while True:
            command = connection.recv()
            if command is None:
                return
            number, attempt, fallback = command
            stage = 'initialization'
            try:
                if digital is None:
                    digital = DigitalAdapter(Path(source), Path(output))
                digital.asset_metadata.clear()
                stage = 'fallback' if fallback else 'page'
                if fallback:
                    page = _original_page_fallback(digital, number)
                else:
                    page = digital.convert_page(number) if engine != 'docling' else None
                    wants_ocr = engine == 'docling' or (engine == 'auto' and page['quality_state'] == 'image_fallback' and any(
                        b.get('fallback_reason') in ['ocr_required', 'corrupt_text_layer', 'mixed_scan_requires_ocr', 'ambiguous_reading_order']
                        for b in page['blocks']))
                    if page is not None and page.get('quality_state') == 'blank':
                        wants_ocr = False
                    if wants_ocr and ocr_ready:
                        if ocr is None:
                            stage = 'initialization'
                            from .adapters.docling import DoclingAdapter
                            ocr = DoclingAdapter(Path(source), Path(output), digital)
                        stage = 'page'
                        page = ocr.convert_page(number, attempt=attempt)
                payload = {'page': page, 'asset_metadata': digital.asset_metadata,
                           'worker_peak_rss_bytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)}
                encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
                if len(encoded) > MAX_PAGE_JSON_BYTES:
                    raise ValueError('Page result exceeds the independent storage budget.')
            except Exception as error:
                encoded = json.dumps({'error': {'message': str(error)[:1000], 'type': type(error).__name__,
                    'category': classify_error(error), 'errno': getattr(error, 'errno', None),
                    'retryable': stage == 'page' and _retryable_page_error(error)}}).encode()
            connection.send_bytes(encoded)
    except EOFError:
        return
    finally:
        if digital is not None:
            digital.close()
        connection.close()


class PageProcess:
    def __init__(self, source, output, engine, ocr_ready, timeout=PAGE_TIMEOUT_SECONDS):
        self.arguments = (str(source), str(output), engine, ocr_ready)
        self.timeout = timeout
        self.process = self.connection = None
        self.receiver = None

    def close(self):
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
                self.process.join(1)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(2)
            if self.process.is_alive():
                raise RuntimeError('Page engine could not be terminated; task stopped.')
            self.process.join()
            self.process.close()
            self.process = None
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        if self.receiver is not None:
            self.receiver.join(1)
            if self.receiver.is_alive():
                raise RuntimeError('Page engine IPC did not stop; task stopped.')
            self.receiver = None

    def convert(self, number, attempt, *, fallback=False):
        if self.process is None:
            context = multiprocessing.get_context('spawn')
            self.connection, child = context.Pipe()
            self.process = context.Process(target=_page_engine_main,
                args=(child, *self.arguments), daemon=True)
            self.process.start()
            child.close()
        try:
            self.connection.send((number, attempt, fallback))
            inbox = queue.Queue(maxsize=1)
            connection = self.connection
            def receive():
                try:
                    inbox.put(connection.recv_bytes(MAX_PAGE_JSON_BYTES))
                except Exception as error:
                    inbox.put(error)
            # poll() alone is insufficient: recv_bytes may block after only a
            # partial message header arrives. The deadline covers the full read.
            self.receiver = threading.Thread(target=receive, daemon=True)
            self.receiver.start()
            try:
                raw = inbox.get(timeout=self.timeout)
            except queue.Empty:
                self.close()  # Do not retry while a timed-out engine still runs.
                raise PageAttemptError(f'Page {number} engine exceeded {self.timeout:g} seconds.',
                    category='page_timeout', retryable=not fallback, error_type='TimeoutError')
            self.receiver.join()
            self.receiver = None
            if isinstance(raw, Exception):
                raise raw
            payload = json.loads(raw)
        except (EOFError, BrokenPipeError, ConnectionResetError) as error:
            self.close()
            raise PageAttemptError('Page engine exited or was interrupted; task stopped.',
                                   category='page_engine_interrupted') from error
        if 'error' in payload:
            detail = payload['error']
            self.close()  # A retry gets a fresh engine, not possibly damaged state.
            if detail.get('errno') is not None:
                raise OSError(detail['errno'], detail['message'])
            raise PageAttemptError(detail['message'], category=detail['category'],
                retryable=detail['retryable'], error_type=detail['type'])
        return payload


def page_summary(page):
    resilience = page.get('resilience', {})
    attempts = resilience.get('attempts', [])
    attempt_count = len(attempts)
    failed_attempts = sum(a['status'] == 'failed' for a in attempts)
    if page['extraction_method'] == 'omarchy_ocr' and not attempts:
        # Remote canonical pages retain the successful attempt number, while
        # exact failed responses remain in the adapter's append-only event log.
        reported = page.get('attempt', 1)
        if type(reported) is not int or not 1 <= reported <= PAGE_ATTEMPTS:
            raise ValueError('Omarchy page has an invalid bounded attempt number.')
        attempt_count, failed_attempts = reported, reported - 1
    whole_page_fallback = page.get('quality_state') == 'image_fallback' or any(
        block['type'] == 'image_fallback' and block.get('source', {}).get('bbox') ==
        [0, 0, page.get('width'), page.get('height')] for block in page['blocks'])
    return {'digital_pages': int(page['extraction_method'] == 'digital_text' and bool(page['text'])),
            'ocr_pages': int(page['extraction_method'] in ['docling_ocr', 'omarchy_ocr', 'mineru_source'] and
                             bool(page['text'].strip()) and not whole_page_fallback),
            'fallback_pages': int(any(b['type'] == 'image_fallback' for b in page['blocks'])),
            'whole_image_pages': int(whole_page_fallback and not page['text'].strip()),
            'selectable_text_pages': int(bool(page['text'].strip())),
            'failed_pages': int(bool(resilience.get('fallback'))),
            'retried_pages': int(attempt_count > 1), 'retry_attempts': max(0, attempt_count - 1),
            'failed_attempts': failed_attempts,
            'timeout_attempts': sum(a.get('error', {}).get('category') == 'page_timeout' for a in attempts)}


def convert_resilient_page(worker, digital, number, source, original_stat, emit, run_id):
    attempts = []
    def check_source():
        if (source.stat().st_size, source.stat().st_mtime_ns) != original_stat:
            raise ValueError('Source PDF changed during conversion; result is not published.')
    def record(value):
        event = {'event': 'page_attempt', 'page_number': number, 'run_id': run_id, **value}
        # Append-only attempt evidence survives cancellation and failed retries.
        with (digital.output / 'page-attempts.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        emit(event)
    for attempt in range(1, PAGE_ATTEMPTS + 1):
        check_source()
        started = time.perf_counter()
        try:
            payload = worker.convert(number, attempt)
            check_source()
        except Exception as error:
            retryable = isinstance(error, PageAttemptError) and error.retryable
            detail = {'attempt': attempt, 'status': 'failed', 'elapsed_ms': round((time.perf_counter() - started) * 1000, 3),
                      'error': {'category': classify_error(error), 'type': getattr(error, 'error_type', type(error).__name__), 'message': str(error)},
                      'retryable': retryable, 'max_attempts': PAGE_ATTEMPTS}
            attempts.append(detail)
            record(detail)
            if not retryable:
                raise
            continue
        attempts.append({'attempt': attempt, 'status': 'succeeded',
                         'elapsed_ms': round((time.perf_counter() - started) * 1000, 3)})
        record(attempts[-1])
        page = payload['page']
        page['resilience'] = {'attempts': attempts, 'fallback': False, 'page_timeout_seconds': worker.timeout}
        digital.asset_metadata.update(payload['asset_metadata'])
        page['worker_peak_rss_bytes'] = payload['worker_peak_rss_bytes']
        return page
    check_source()
    started = time.perf_counter()
    # Fallback is also a real subprocess operation with a hard deadline. Failure
    # to preserve the original is fatal; it never becomes a missing/blank page.
    payload = worker.convert(number, PAGE_ATTEMPTS + 1, fallback=True)
    check_source()
    elapsed = round((time.perf_counter() - started) * 1000, 3)
    record({'attempt': PAGE_ATTEMPTS + 1, 'status': 'original_retained', 'elapsed_ms': elapsed})
    page = payload['page']
    page['resilience'] = {'attempts': attempts, 'fallback': True, 'fallback_ms': elapsed,
                          'page_timeout_seconds': worker.timeout}
    page['worker_peak_rss_bytes'] = payload['worker_peak_rss_bytes']
    digital.asset_metadata.update(payload['asset_metadata'])
    return page


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def processing_config(engine, ocr_ready):
    packages = ['pdfplumber', 'pdfminer-six', 'pypdfium2', 'pillow']
    digital_code = {p.name: file_sha256(p) for p in sorted(
        (Path(__file__).parent / 'adapters').glob('digital*.py'))}
    if engine == 'mineru_source':
        runtime = discover_mineru_runtime()
        return {'processing_version': PROCESSING_VERSION, 'engine': engine,
                'pipeline_code_sha256': file_sha256(Path(__file__)),
                'adapter_versions': {name: _version(name) for name in packages},
                'adapter_code': {**digital_code, **{p.name: file_sha256(p) for p in sorted(
                    (Path(__file__).parent / 'adapters').glob('mineru*.py'))}},
                'runtime_identity': runtime.identity, 'runtime_settings': runtime.settings,
                'page_resilience': {'attempts': PAGE_ATTEMPTS, 'timeout_seconds': runtime.settings['page_timeout_seconds'],
                                    'isolation': 'pinned_python_subprocess', 'fallback': 'original_page_once'},
                'remote_services': False, 'asset_scale': ASSET_SCALE,
                'max_asset_pixels': MAX_ASSET_PIXELS, 'max_asset_bytes': MAX_ASSET_BYTES}
    if engine == 'omarchy':
        from .adapters.omarchy import omarchy_configuration

        # The read-only remote configuration probe fixes the model/code/version
        # identity. Launch must compare that identity before publishing pages.
        return {'processing_version': PROCESSING_VERSION, 'engine': engine,
                'pipeline_code_sha256': file_sha256(Path(__file__)),
                'adapter_versions': {name: _version(name) for name in packages},
                'adapter_code': {**digital_code, 'omarchy.py': file_sha256(Path(__file__).parent / 'adapters' / 'omarchy.py')},
                'ocr': omarchy_configuration(),
                'driver': 'persistent_remote_batch', 'scope_policy': 'full_document_only',
                'remote_services': True, 'asset_scale': ASSET_SCALE,
                'max_asset_pixels': MAX_ASSET_PIXELS, 'max_asset_bytes': MAX_ASSET_BYTES}
    if engine in ['auto', 'docling']:
        packages += ['docling', 'docling-core', 'docling-parse', 'torch', 'ocrmac',
                     'pyobjc-framework-vision']
    models = []
    if engine in ['auto', 'docling'] and ocr_ready:
        manifest = json.loads((model_directory() / 'pdf-lab-ready.json').read_text())
        for item in manifest['models']:
            if file_sha256(model_directory() / item['file']) != item['sha256']:
                raise RuntimeError('Local model checksum changed; model is not ready.')
            models.append({'file': item['file'], 'sha256': item['sha256']})
    return {'processing_version': PROCESSING_VERSION, 'engine': engine,
            'pipeline_code_sha256': file_sha256(Path(__file__)),
            'page_resilience': {'attempts': PAGE_ATTEMPTS, 'timeout_seconds': PAGE_TIMEOUT_SECONDS,
                                'isolation': 'warm_spawn_process', 'fallback': 'original_page_once'},
            'adapter_versions': {name: _version(name) for name in packages},
            'adapter_code': {**digital_code, 'docling.py': file_sha256(Path(__file__).parent / 'adapters' / 'docling.py')},
            'models': models, 'ocr_ready': ocr_ready if engine != 'digital' else False,
            'ocr': {'backend': 'ocrmac', 'language': ['en-US'], 'recognition': 'accurate',
                    'force_full_page': True, 'layout_table_device': 'cpu', 'threads': 2,
                    'visible_input_transform_version': 1,
                    'input_policy': 'pdfium_visible_raster_single_page_for_intrinsic_rotation_or_crop'},
            'macos_version': platform.mac_ver()[0], 'architecture': platform.machine(),
            'remote_services': False, 'asset_scale': ASSET_SCALE,
            'max_asset_pixels': MAX_ASSET_PIXELS, 'max_asset_bytes': MAX_ASSET_BYTES}


def source_information(source, digital, sha256):
    toc = []
    for bookmark in digital.renderer.get_toc(max_depth=15):
        if len(toc) == 1000:
            break
        dest = bookmark.get_dest()
        page_index = dest.get_index() if dest else None
        toc.append({'title': bookmark.get_title(), 'level': bookmark.level,
                    'page_number': page_index + 1 if page_index is not None else None})
    return {'sha256': sha256, 'bytes': source.stat().st_size,
            'metadata': digital.renderer.get_metadata_dict(skip_empty=True),
            'toc': toc, 'toc_limit': 1000}


def _asset_path(output, relative):
    relative = Path(relative)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('Unsafe checkpoint asset path.')
    path = (output / relative).resolve()
    if not path.is_relative_to(output.resolve()) or path.suffix.lower() not in ['.png', '.jpg', '.jpeg']:
        raise ValueError('Unsafe checkpoint asset path.')
    return path


def finalize_page(page, digital, source_sha256, identity=None):
    from PIL import Image

    validate_formula_contract(page)
    assets = {}
    for holder in asset_holders(page):
        if holder.get('source'):
            holder['source'].update(width=page['width'], height=page['height'],
                                    coordinate_space=page['coordinate_space'],
                                    rotation=page.get('rotation', 0), crop_box=page.get('crop_box'),
                                    source_sha256=source_sha256)
        if not holder.get('asset'):
            continue
        path = _asset_path(digital.output, holder['asset'])
        if holder['asset'] in assets:
            holder['asset_metadata'] = assets[holder['asset']]
            continue
        with Image.open(path) as image:
            width, height = image.size
            image.verify()
        if width * height > MAX_ASSET_PIXELS or path.stat().st_size > MAX_ASSET_BYTES:
            raise ValueError('Asset exceeds the independent raster budget.')
        info = dict(digital.asset_metadata.get(holder['asset'], {}))
        info.update(width_px=width, height_px=height, bytes=path.stat().st_size,
                    sha256=file_sha256(path))
        holder['asset_metadata'] = info
        assets[holder['asset']] = info
        if info.get('budget_limited'):
            page['warnings'].append('Original image scale is budget limited; actual scale is recorded.')
    normalized=page.get('normalization')
    if normalized:
        relative=normalized['asset']
        path=_asset_path(digital.output,relative)
        with Image.open(path) as image:
            image.verify()
        info=dict(digital.asset_metadata[relative])
        info.update(bytes=path.stat().st_size,sha256=file_sha256(path))
        assets[relative]=info
    page['assets'] = assets
    if identity:
        page['checkpoint'] = {'source_sha256': source_sha256, 'processing_identity': identity,
                              'complete': True}


def validated_checkpoint(output, page_number, identity, source_sha256, expected=None):
    """Validate one bounded real page, never hold the document's text in memory."""
    from PIL import Image

    path = output / f'pages/p{page_number:06d}.json'
    if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_PAGE_JSON_BYTES:
        raise ValueError('Checkpoint missing or exceeds page budget.')
    sha256 = file_sha256(path)
    if expected and sha256 != expected.get('sha256'):
        raise ValueError('Checkpoint checksum mismatch.')
    page = json.loads(path.read_text())
    checkpoint = page.get('checkpoint', {})
    if checkpoint.get('processing_identity') != identity or checkpoint.get('source_sha256') != source_sha256:
        raise ValueError('Resume identity mismatch in page checkpoint.')
    if page.get('page_number') != page_number or checkpoint.get('complete') is not True:
        raise ValueError('Incomplete page checkpoint.')
    width, height = page['width'], page['height']
    if not all(isinstance(v, (float, int)) and math.isfinite(v) and v > 0 for v in [width, height]):
        raise ValueError('Invalid checkpoint page geometry.')
    if not isinstance(page.get('blocks'), list) or (not page['blocks'] and page.get('quality_state')!='blank') or not isinstance(page.get('text'), str):
        raise ValueError('Invalid checkpoint content.')
    if page.get('coordinate_space') != 'rotated_crop_top_left' or page.get('extraction_method') not in ['digital_text', 'docling_ocr', 'omarchy_ocr', 'mineru_source', 'original_fallback']:
        raise ValueError('Invalid checkpoint extraction/source geometry.')
    validate_formula_contract(page)
    for holder in asset_holders(page):
        if holder.get('asset') and holder['asset'] not in page.get('assets', {}):
            raise ValueError('Checkpoint object asset is undeclared.')
    ids = set()
    for block in page['blocks']:
        if not isinstance(block.get('id'), str) or not isinstance(block.get('text'), str) or not isinstance(block.get('type'), str):
            raise ValueError('Invalid checkpoint block fields.')
        if block['type'] in ['image', 'image_fallback'] and not block.get('asset'):
            raise ValueError('Checkpoint image has no retained asset.')
        box = block['source']['bbox']
        if block['id'] in ids or block['source']['page_number'] != page_number or len(box) != 4:
            raise ValueError('Invalid checkpoint block identity/source.')
        ids.add(block['id'])
        if not (0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height):
            raise ValueError('Invalid checkpoint block geometry.')
        if block.get('asset'):
            asset = _asset_path(output, block['asset'])
            recorded = page.get('assets', {}).get(block['asset'], {})
            if not asset.is_file() or asset.stat().st_size > MAX_ASSET_BYTES or file_sha256(asset) != recorded.get('sha256'):
                raise ValueError('Checkpoint asset missing or checksum mismatch.')
            with Image.open(asset) as image:
                if image.width * image.height > MAX_ASSET_PIXELS:
                    raise ValueError('Checkpoint raster exceeds budget.')
                image.verify()
    method = page.get('extraction_method')
    # List-marker resources stay retained, though they are not separate reading figures.
    for relative, recorded in page.get('assets', {}).items():
        asset = _asset_path(output, relative)
        if not asset.is_file() or asset.stat().st_size > MAX_ASSET_BYTES or file_sha256(asset) != recorded.get('sha256'):
            raise ValueError('Checkpoint retained marker/content asset is missing or changed.')
        with Image.open(asset) as image:
            if image.width * image.height > MAX_ASSET_PIXELS:
                raise ValueError('Checkpoint retained raster exceeds budget.')
            image.verify()
    normalized=page.get('normalization')
    if normalized:
        relative=Path(normalized['input_path'])
        proof=(output/relative).resolve()
        if relative.is_absolute() or '..' in relative.parts or not proof.is_relative_to(output.resolve()) or proof.suffix!='.pdf':
            raise ValueError('Unsafe normalized input proof path.')
        if not proof.is_file() or proof.stat().st_size>MAX_ASSET_BYTES or file_sha256(proof)!=normalized['input_sha256']:
            raise ValueError('Normalized input proof missing or changed.')
    summary = page_summary(page)
    return {'page_number': page_number, 'page_path': str(path.relative_to(output)),
            'sha256': sha256, 'bytes': path.stat().st_size}, summary


def convert_pdf(source, output, engine='auto', start_page=1, end_page=None, emit=None, *, sharded=False, resume=False):
    import fcntl

    source, output = Path(source).resolve(), Path(output).resolve()
    if resume and not sharded:
        raise ValueError('--resume requires --sharded.')
    if engine not in ['auto', 'digital', 'docling', 'omarchy', 'mineru_source']:
        raise ValueError(f'Unsupported engine: {engine}')
    if not source.is_file():
        raise FileNotFoundError('Source PDF is unavailable.')
    with source.open('rb') as stream:
        if not stream.read(1024).lstrip().startswith(b'%PDF-'):
            raise ValueError('Input is not a readable PDF header.')
    output.mkdir(parents=True, exist_ok=True)
    # The backend also serializes workers. This protects direct CLI callers and
    # releases automatically on a killed process; stale lock files are harmless.
    with (output / '.conversion.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another conversion owns this output directory.') from error
        return _convert_locked(source, output, engine, start_page, end_page,
                               emit or (lambda event: None), sharded, resume)


def _convert_locked(source, output, engine, start_page, end_page, emit, sharded, resume):
    from .adapters.digital import DigitalAdapter

    started = time.perf_counter()
    ocr_ready = False if engine == 'digital' else get_capabilities(include_remote=False)['adapters'][1]['available']
    if engine == 'docling' and not ocr_ready:
        raise RuntimeError('Local Docling model/dependencies are not ready; see --capabilities.')
    if not sharded and (output / 'result.json').is_file():
        with (output / 'result.json').open() as stream:
            schema = re.search(r'"schema_version"\s*:\s*(\d+)', stream.read(512))
        if schema and int(schema[1]) == 2:
            raise ValueError('Output already uses sharded storage; preserve it with --sharded --resume or use a new directory.')
    if sharded and not resume and ((output / 'result.json').exists() or list(output.glob('pages/p*.json'))):
        raise ValueError('Output already contains conversion data; use a new directory or --resume.')
    digital = DigitalAdapter(source, output)
    if engine == 'mineru_source':
        from .adapters.mineru import MinerUSourceProcess
        try:
            worker = MinerUSourceProcess(source, output, digital)
        except Exception:
            digital.close()
            raise
    else:
        worker = None if engine == 'omarchy' else PageProcess(source, output, engine, ocr_ready)
    remote = None
    run_id = str(time.time_ns())
    result = {'schema_version': 2 if sharded else 1, 'engine': engine,
              'page_count': digital.page_count, 'pages': [],
              'metrics': {'start_page': start_page, 'end_page': end_page, 'digital_pages': 0,
                          'ocr_pages': 0, 'fallback_pages': 0, 'whole_image_pages': 0,
                          'selectable_text_pages': 0, 'structure_recognized_blocks': 0,
                          'failed_pages': 0, 'retried_pages': 0, 'retry_attempts': 0,
                          'failed_attempts': 0, 'timeout_attempts': 0, 'page_worker_peak_rss_bytes': 0,
                          'peak_rss_scope': 'supervisor_only; model worker is page_worker_peak_rss_bytes',
                          'cloud_calls': 0, 'done_pages': 0, 'resumed_pages': 0, 'new_pages': 0},
              'warnings': ['Candidates require independent quality review; completion is not quality acceptance.']}
    try:
        stop = digital.page_count if end_page is None else end_page
        if not 1 <= start_page <= stop <= digital.page_count:
            raise ValueError(f'Invalid page range {start_page}–{stop}; PDF has {digital.page_count} pages.')
        if engine == 'omarchy' and (start_page != 1 or stop != digital.page_count):
            # The first driver transfers the original PDF. Processing only a
            # subset after that transfer would exceed the authorized scope.
            raise PageAttemptError('Omarchy 目前只支持整书处理；局部重识别请选择当前电脑。',
                                   category='omarchy_scope_unsupported')
        if engine == 'omarchy':
            result['metrics'].update(page_worker_peak_rss_bytes=None,
                                     peak_rss_scope='local_supervisor_only; remote_resources_not_measured')
        result['metrics']['end_page'] = stop
        original_stat = (source.stat().st_size, source.stat().st_mtime_ns)
        source_sha256 = file_sha256(source)
        config = processing_config(engine, ocr_ready)
        identity_input = {'source_sha256': source_sha256, 'page_count': digital.page_count,
                          'start_page': start_page, 'end_page': stop, 'config': config}
        identity = hashlib.sha256(json.dumps(identity_input, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        result.update(source_sha256=source_sha256, processing_identity=identity,
                      configuration_identity=hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                      processing_config=config, source=source_information(source, digital, source_sha256),
                      range={'start_page': start_page, 'end_page': stop})
        result['metrics']['source_inspection_ms'] = round((time.perf_counter()-started)*1000, 3)
        references = {}
        old = None
        if resume and (output / 'result.json').exists():
            if (output / 'result.json').stat().st_size > MAX_INDEX_JSON_BYTES:
                raise ValueError('Resume index exceeds the bounded index budget.')
            old = json.loads((output / 'result.json').read_text())
            if old.get('schema_version') != 2 or old.get('processing_identity') != identity:
                raise ValueError('Resume identity mismatch: original, range, engine/model or processing settings changed.')
            expected = {p['page_number']: p for p in old.get('pages', [])}
        else:
            expected = {}
        if resume:
            # Pages orphaned after their atomic save but before index commit can
            # be recovered only by validating their embedded identity/content.
            for path in sorted(output.glob('pages/p*.json')):
                try:
                    number = int(path.stem[1:])
                except ValueError:
                    continue
                if not start_page <= number <= stop:
                    raise ValueError('Resume identity mismatch: checkpoint outside requested range.')
                try:
                    entry, summary = validated_checkpoint(output, number, identity, source_sha256, expected.get(number))
                except (ValueError, KeyError, TypeError, OSError) as error:
                    if isinstance(error, OSError) or any(term in str(error).lower() for term in ('identity', 'checksum', 'unsafe')):
                        raise
                    # Keep the first bad artifact for diagnosis, then rerun only
                    # its real missing/incomplete unit. It is never counted ready.
                    damaged = output / 'invalid-checkpoints'
                    damaged.mkdir(exist_ok=True)
                    preserved = damaged / f'{path.stem}-{time.time_ns()}.json'
                    if path.is_symlink():
                        os.replace(path, preserved)
                    else:
                        shutil.copyfile(path, preserved)
                    result['warnings'].append(f'Checkpoint {number} invalid: {error}; preserved and reprocessed.')
                    continue
                references[number] = entry
                for key, value in summary.items():
                    result['metrics'][key] += value
            result['pages'] = [references[n] for n in sorted(references)]
            result['metrics'].update(done_pages=len(references), resumed_pages=len(references))
            if old:
                result['initial_run_metrics'] = old.get('initial_run_metrics', old['metrics'])
        result['metrics'].update(range_complete=len(references) == stop-start_page+1,
                                 full_document_complete=start_page == 1 and stop == digital.page_count and len(references) == digital.page_count)
        if sharded:
            atomic_json(output / 'result.json', result, max_bytes=MAX_INDEX_JSON_BYTES)
        emit({'event': 'started', 'engine': engine, 'schema_version': result['schema_version'],
              'page_count': digital.page_count, 'start_page': start_page, 'end_page': stop,
              'done_pages': len(references), 'resumed_pages': len(references)})
        if resume:
            emit({'event': 'resume_validated', 'done_pages': len(references),
                  'resumed_pages': len(references), 'result_path': 'result.json'})
        missing_pages = [number for number in range(start_page, stop+1) if number not in references]
        if engine == 'omarchy' and missing_pages:
            from .adapters.omarchy import OmarchyAdapter

            if (source.stat().st_size, source.stat().st_mtime_ns) != original_stat:
                raise ValueError('Source PDF changed before transfer; result is not published.')
            remote = OmarchyAdapter(source, output, digital, start_page, stop, emit,
                                    pages=missing_pages, expected_configuration=config['ocr'])
        for page_number in missing_pages:
            page_started = time.perf_counter()
            page = (remote.convert_page(page_number) if remote is not None else
                    convert_resilient_page(worker, digital, page_number, source, original_stat, emit, run_id))
            if (source.stat().st_size, source.stat().st_mtime_ns) != original_stat:
                raise ValueError('Source PDF changed during conversion; result is not published.')
            if page.get('page_number') != page_number:
                raise ValueError('Converted page identity does not match the requested source page.')
            finalize_page(page, digital, source_sha256, identity if sharded else None)
            for key, value in page_summary(page).items():
                result['metrics'][key] += value
            if worker is not None:
                result['metrics']['page_worker_peak_rss_bytes'] = max(
                    result['metrics']['page_worker_peak_rss_bytes'], page['worker_peak_rss_bytes'])
            else:
                page['remote_conversion_ms'] = page.get('conversion_ms')
            page['conversion_ms'] = round((time.perf_counter()-page_started)*1000, 3)
            if sharded:
                page_path = f'pages/p{page_number:06d}.json'
                atomic_json(output / page_path, page, max_bytes=MAX_PAGE_JSON_BYTES)
                path = output / page_path
                if path.stat().st_size > MAX_PAGE_JSON_BYTES:
                    raise ValueError('Page JSON exceeds the independent page budget.')
                references[page_number] = {'page_number': page_number, 'page_path': page_path,
                                           'sha256': file_sha256(path), 'bytes': path.stat().st_size}
                result['pages'] = [references[n] for n in sorted(references)]
            else:
                result['pages'].append(page)
            done = len(result['pages'])
            elapsed = round((time.perf_counter()-started)*1000, 3)
            result['metrics'].update(elapsed_ms=elapsed, done_pages=done,
                                     new_pages=done-result['metrics']['resumed_pages'],
                                     peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024),
                                     range_complete=done == stop-start_page+1,
                                     full_document_complete=start_page == 1 and stop == digital.page_count and done == digital.page_count)
            if result['metrics']['new_pages'] == 1:
                result['metrics']['first_new_page_completed_ms'] = elapsed
                if not result['metrics']['resumed_pages']:
                    result['metrics']['first_page_completed_ms'] = elapsed
            atomic_json(output / 'result.json', result, max_bytes=MAX_INDEX_JSON_BYTES if sharded else None)
            event = {'event': 'page_completed', 'page_number': page_number, 'result_path': 'result.json',
                     'elapsed_ms': elapsed, 'extraction_method': page['extraction_method'], 'quality_state': page['quality_state'],
                     'metrics': dict(result['metrics'])}
            if sharded:
                event['page_path'] = page_path
            emit(event)
        result['metrics'].update(elapsed_ms=round((time.perf_counter()-started)*1000, 3),
                                 peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024))
        if sharded:
            atomic_json(output / 'result.json', result, max_bytes=MAX_INDEX_JSON_BYTES)
        emit({'event': 'completed', 'done_pages': len(result['pages']), 'result_path': 'result.json', 'metrics': result['metrics']})
        return result
    except Exception as error:
        failure = {'event': 'failed', 'category': classify_error(error), 'error': str(error),
                   'done_pages': result['metrics']['done_pages'], 'elapsed_ms': round((time.perf_counter()-started)*1000, 3)}
        try:
            atomic_json(output / f'failure-{time.time_ns()}.json', failure)
        except OSError:
            pass
        emit(failure)
        raise
    finally:
        try:
            if remote is not None:
                remote.close()
        finally:
            try:
                if worker is not None:
                    worker.close()
            finally:
                digital.close()
