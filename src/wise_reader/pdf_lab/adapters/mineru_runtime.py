"""Lightweight, offline runtime discovery shared by conversion and recognition.

No model packages are imported here. ``models`` is the directory containing
MFR/, Layout/, OCR/ and Table/. Register an existing installation with
scripts/setup_mineru_runtime.py; discovery never installs or downloads anything.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from functools import lru_cache
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
MINERU_VERSION = '4.0.11'
SETTINGS = {'tier': 'basic', 'parse_mode': 'auto', 'backend': 'onnx', 'device': 'cpu',
            'intra_threads': 4, 'inter_threads': 1, 'formula_policy': 'source_only_v1',
            'table_policy': 'source_image', 'page_timeout_seconds': 90,
            'max_worker_bytes': 8 * 1024**3, 'min_available_bytes': 1024**3,
            'max_input_pixels': 16_000_000, 'adapter_version': 1}


class MinerURuntimeUnavailable(RuntimeError):
    """A missing or changed local installation, never an invitation to download."""


@dataclass(frozen=True)
class MinerURuntime:
    python: Path
    models: Path
    manifest: Path
    identity: str
    settings: dict


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_identity(data):
    # Paths and timestamps are deployment details; actual content/settings bind caches.
    return hashlib.sha256(json.dumps({
        'version': data['version'], 'packages': data['packages'], 'settings': data['settings'],
        'inventory_sha256': data['inventory_sha256'], 'python_sha256': data['python']['sha256'],
        'files': [{k: row[k] for k in ('root', 'file', 'bytes', 'sha256')} for row in data['files']],
    }, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


@lru_cache(maxsize=4)
def _manifest_data(path: str, size: int, mtime_ns: int, inode: int, ctime_ns: int):
    return json.loads(Path(path).read_text())


def discover_mineru_runtime(*, verify_hashes: bool = False) -> MinerURuntime:
    path = Path(os.environ.get('WISE_READER_MINERU_MANIFEST', ROOT / '.runtime/mineru/runtime.json')).expanduser()
    try:
        manifest_stat = path.stat()
        if not path.is_absolute() or manifest_stat.st_size > 8 * 1024**2:
            raise ValueError('Manifest must be an absolute, bounded file.')
        data = _manifest_data(str(path), manifest_stat.st_size, manifest_stat.st_mtime_ns, manifest_stat.st_ino, manifest_stat.st_ctime_ns)
        if data.get('schema_version') != 1 or data.get('version') != MINERU_VERSION or data.get('settings') != SETTINGS:
            raise ValueError('Pinned MinerU version/settings changed; register the runtime again.')
        roots = {name: Path(data[name]) for name in ('venv', 'models')}
        python = roots['venv'] / 'bin/python'
        if any(not p.is_absolute() or not p.is_dir() for p in roots.values()) or not python.is_file():
            raise ValueError('Registered Python/model paths are missing.')
        if not data['files'] or data['packages'].get('mineru') != MINERU_VERSION:
            raise ValueError('Pinned installation manifest is incomplete.')
        python_stat = python.stat()
        if python_stat.st_size != data['python']['bytes'] or python_stat.st_mtime_ns != data['python']['mtime_ns']:
            raise ValueError('Runtime Python changed.')
        files = data['files']
        for row in files:
            base = roots[row['root']].resolve()
            relative = Path(row['file'])
            file = (base / relative).resolve()
            if relative.is_absolute() or '..' in relative.parts or not file.is_relative_to(base):
                raise ValueError('Unsafe runtime manifest path.')
            stat = file.stat()
            if stat.st_size != row['bytes'] or stat.st_mtime_ns != row['mtime_ns']:
                raise ValueError(f'Runtime file changed: {row["file"]}')
        identity = manifest_identity(data)
        if identity != data['identity']:
            raise ValueError('Runtime manifest identity mismatch.')
        runtime = MinerURuntime(python, roots['models'], path, identity, dict(SETTINGS))
        if verify_hashes:
            verify_runtime_files(runtime)
        return runtime
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise MinerURuntimeUnavailable(
            f'MinerU {MINERU_VERSION} CPU runtime not ready: {error}. '
            'Run scripts/setup_mineru_runtime.py with an existing --venv and --models; no automatic download.'
        ) from error


def mineru_runtime_status():
    try:
        runtime = discover_mineru_runtime()
        return {'available': True, 'missing_reason': None, 'version': MINERU_VERSION,
                'identity': runtime.identity}
    except MinerURuntimeUnavailable as error:
        return {'available': False, 'missing_reason': str(error), 'version': MINERU_VERSION,
                'identity': None}


def runtime_environment(runtime, work: Path):
    """Explicit allowlist: no user providers, arbitrary Python paths or GPU config."""
    work.mkdir(parents=True, exist_ok=True)
    config = work / 'mineru.yaml'
    config.write_text('model:\n  source: local\n  small_backend: onnx\n')
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LANG', 'TMPDIR') if k in os.environ}
    env.update(MINERU_HOME=str(work), MINERU_CONFIG=str(config),
               MINERU_MODEL_BASE_DIR=str(runtime.models.parent), MINERU_MODEL_SOURCE='local',
               MINERU_MODEL_SMALL_BACKEND='onnx', MINERU_DEVICE_MODE='cpu', MINERU_TABLE_DEVICE='cpu',
               MINERU_INTRA_OP_NUM_THREADS='4', MINERU_INTER_OP_NUM_THREADS='1',
               CUDA_VISIBLE_DEVICES='', PYTORCH_ENABLE_MPS_FALLBACK='0',
               PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1',
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
               TOKENIZERS_PARALLELISM='false', XDG_CACHE_HOME=str(work / 'cache'),
               WISE_READER_MINERU_MANIFEST=str(runtime.manifest))
    for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
                 'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS'):
        env[name] = '4'
    return env


def _stat_signature(value):
    return [value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns]


def write_verification_receipt(runtime, signatures):
    """Atomic local proof; called only after content hashes have actually matched."""
    import tempfile
    state = runtime.manifest.stat()
    data = _manifest_data(str(runtime.manifest), state.st_size, state.st_mtime_ns, state.st_ino, state.st_ctime_ns)
    destination = runtime.manifest.parent / 'verified-files.json'
    value = {'schema_version': 1, 'runtime_identity': runtime.identity,
             'inventory_sha256': data['inventory_sha256'], 'files': signatures}
    fd, temporary = tempfile.mkstemp(prefix='.verified-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def verify_runtime_files(runtime, files=None, *, force_hashes=False):
    """Verify registered content, reusing setup/previous proof for unchanged inodes.

    ``files=None`` checks the full inventory; an iterable of absolute paths checks
    only those registered files (e.g. formula ONNX + YAML). Receipts invalidate on
    inode/device/size/mtime/ctime changes. Changed files are hashed individually;
    the installed content must still match the pinned inventory. No model imports.
    """
    import stat
    import time
    started = time.perf_counter()
    manifest_stat = runtime.manifest.stat()
    data = _manifest_data(str(runtime.manifest), manifest_stat.st_size, manifest_stat.st_mtime_ns, manifest_stat.st_ino, manifest_stat.st_ctime_ns)
    if files is None:
        inventory_path = runtime.manifest.parent / 'runtime-files.json'
        if inventory_path.stat().st_size > 16 * 1024**2 or sha256(inventory_path) != data['inventory_sha256']:
            raise MinerURuntimeUnavailable('Runtime inventory checksum changed.')
        inventory = json.loads(inventory_path.read_text())
    else:
        # Model and hook files are already in the identity-bound light manifest.
        inventory = data['files']
    roots = {name: Path(data[name]).resolve() for name in ('venv', 'models')}
    selected = None if files is None else {str(Path(path).absolute()) for path in files}
    receipt_path = runtime.manifest.parent / 'verified-files.json'
    try:
        if receipt_path.stat().st_size > 16 * 1024**2:
            raise ValueError('Oversized receipt.')
        receipt = json.loads(receipt_path.read_text())
        if (receipt.get('schema_version') != 1 or receipt.get('runtime_identity') != runtime.identity
                or receipt.get('inventory_sha256') != data['inventory_sha256']):
            raise ValueError('Stale verification receipt.')
        signatures = receipt['files']
        if not isinstance(signatures, dict):
            raise ValueError('Invalid verification receipt.')
    except (OSError, ValueError, KeyError, TypeError):
        signatures = {}
    parent_paths = {}
    checked = hits = hashed = 0
    dirty = False
    remaining = set() if selected is None else set(selected)
    for row in inventory:
        base = roots[row['root']]
        relative = Path(row['file'])
        file = base / relative
        if selected is not None and str(file) not in selected:
            continue
        if relative.is_absolute() or '..' in relative.parts:
            raise MinerURuntimeUnavailable('Unsafe runtime inventory path.')
        # Resolve each directory once, not tens of thousands of identical parents.
        parent = parent_paths.setdefault(str(file.parent), None)
        if parent is None:
            parent = file.parent.resolve()
            parent_paths[str(file.parent)] = parent
        if not parent.is_relative_to(base):
            raise MinerURuntimeUnavailable('Runtime inventory leaves its registered installation.')
        current = file.lstat()
        if not stat.S_ISREG(current.st_mode) or current.st_size != row['bytes']:
            raise MinerURuntimeUnavailable(f'Runtime file is missing or changed: {relative}')
        key = row['root'] + '/' + row['file']
        signature = _stat_signature(current)
        if not force_hashes and signatures.get(key) == signature:
            hits += 1
        else:
            if sha256(file) != row['sha256'] or _stat_signature(file.lstat()) != signature:
                raise MinerURuntimeUnavailable(f'Runtime checksum changed: {relative}')
            signatures[key] = signature
            hashed += 1; dirty = True
        checked += 1
        remaining.discard(str(file))
    if remaining:
        raise MinerURuntimeUnavailable('Requested model files are not registered in the runtime inventory.')
    # The venv executable is intentionally a symlink to the managed base Python.
    if selected is None:
        current = runtime.python.stat()
        signature = _stat_signature(current)
        if not force_hashes and signatures.get('@python') == signature:
            hits += 1
        else:
            if sha256(runtime.python) != data['python']['sha256'] or _stat_signature(runtime.python.stat()) != signature:
                raise MinerURuntimeUnavailable('Runtime Python checksum changed.')
            signatures['@python'] = signature
            hashed += 1; dirty = True
        checked += 1
    if dirty:
        write_verification_receipt(runtime, signatures)
    return {'checked_files': checked, 'receipt_hits': hits, 'hashed_files': hashed,
            'elapsed_ms': round((time.perf_counter() - started) * 1000, 3)}
