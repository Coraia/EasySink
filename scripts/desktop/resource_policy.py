"""Small shared guards for existing development/build entry points.

No reader runner, cleanup, ordinary-copy fallback or release-resource exception.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import sqlite3
import subprocess
import time

GIB = 1024 ** 3
INTERACTIVE_RAM_RESERVE_BYTES = 2 * GIB


class ResourceError(RuntimeError):
    pass


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(part)
    return digest.hexdigest()


def _clone_call(source, destination):
    if platform.system() != 'Darwin':
        raise ResourceError('Native clone implementation unavailable; no copy fallback')
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    clone = libc.clonefile
    clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    clone.restype = ctypes.c_int
    if clone(os.fsencode(source), os.fsencode(destination), 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def native_clone(source, destination):
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or not source.is_file():
        raise ResourceError('Clone source must be an explicit regular file')
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(destination)
    if not destination.parent.is_dir():
        raise ResourceError('Clone destination parent must already exist')
    before = source.stat()
    if before.st_dev != destination.parent.stat().st_dev:
        raise ResourceError('Native clone requires the same filesystem; no copy fallback')
    try:
        _clone_call(source, destination)
    except OSError as error:
        raise ResourceError('Native clone failed; no ordinary copy fallback: ' + str(error)) from error
    after, result = source.stat(), destination.stat()
    identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
    if (identity(before) != identity(after) or result.st_ino == before.st_ino
            or result.st_dev != before.st_dev or result.st_size != before.st_size):
        raise ResourceError('Clone identity/source stability check failed')
    return {'source': str(source.resolve()), 'destination': str(destination.resolve()),
            'independentInode': True, 'bytes': result.st_size, 'fallback': False}


def snapshot_sqlite(source, destination):
    source, destination = Path(source), Path(destination)
    wal = Path(str(source) + '-wal')
    if wal.is_symlink() or (wal.exists() and wal.stat().st_size):
        raise ResourceError('Snapshot source must have a closed/empty WAL')
    for suffix in ('', '-wal', '-shm'):
        target = Path(str(destination) + suffix)
        if target.exists() or target.is_symlink():
            raise ResourceError('Private database/WAL destination is already occupied')
    before = file_sha(source)
    with sqlite3.connect(source.resolve().as_uri() + '?mode=ro&immutable=1', uri=True) as db:
        if db.execute('pragma quick_check').fetchone()[0] != 'ok':
            raise ResourceError('Snapshot SQLite integrity check failed')
    receipt = native_clone(source, destination)
    destination.chmod(0o600)
    if (file_sha(source) != before or file_sha(destination) != before
            or (wal.exists() and wal.stat().st_size)):
        raise ResourceError('Closed SQLite snapshot changed during cloning')
    receipt.update(sha256=before, privateWal=str(destination) + '-wal', closedSnapshot=True)
    for parent in destination.resolve().parents:
        lease_path = parent / 'lease.json'
        if lease_path.is_file():
            lease = json.loads(lease_path.read_text())
            if lease.get('resourcePolicy') != 'fixed-development-slot-v1':
                raise ResourceError('Cannot register private database with an unknown slot lease')
            relative = str(destination.resolve().relative_to(parent))
            lease.setdefault('ownedDatabases', {})[relative] = {
                'source': str(source.resolve()), 'sourceSha256': before,
                'privateInode': destination.stat().st_ino, 'closedSnapshot': True}
            lease_path.write_text(json.dumps(lease, indent=2))
            break
    return receipt


def _cpu_interval():
    """Darwin HOST_CPU_LOAD_INFO tick deltas, matching interval CPU activity.

    SDK mach/host_info.h: flavor3, four integer ticks; mach/machine.h:
    user0/system1/idle2/nice3. No process inspection or privilege is needed.
    """
    if platform.system() != 'Darwin':
        raise ResourceError('Interval CPU measurement unavailable')
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    libc.mach_host_self.restype = ctypes.c_uint
    libc.host_statistics.argtypes = [ctypes.c_uint, ctypes.c_int,
                                     ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint)]
    libc.host_statistics.restype = ctypes.c_int
    host = libc.mach_host_self()
    def ticks():
        values, count = (ctypes.c_int * 4)(), ctypes.c_uint(4)
        if libc.host_statistics(host, 3, values, ctypes.byref(count)) or count.value != 4:
            raise ResourceError('CPU interval counters unavailable')
        return [value & 0xffffffff for value in values]
    first = ticks()
    started = time.monotonic()
    time.sleep(1)
    last = ticks()
    elapsed = time.monotonic() - started
    delta = [(after - before) & 0xffffffff for before, after in zip(first, last)]
    total = sum(delta)
    if total <= 0:
        raise ResourceError('CPU interval has no valid tick delta')
    return {'cpu_active_fraction': (total - delta[2]) / total,
            'cpu_idle_fraction': delta[2] / total, 'cpu_interval_seconds': elapsed,
            'cpu_measurement': 'Darwin HOST_CPU_LOAD_INFO one-second tick delta'}


def host_facts(path):
    facts = {'free_bytes': shutil.disk_usage(path).free, 'cpu_count': os.cpu_count(),
             'load1': None, 'available_ram_bytes': None, 'platform': platform.system(),
             'cpu_active_fraction': None, 'cpu_interval_seconds': None,
             'available_ram_is_estimate': True, 'os_memory_free_percentage': None}
    try:
        facts['load1'] = os.getloadavg()[0]
        if platform.system() == 'Darwin':
            output = subprocess.check_output(['/usr/bin/vm_stat'], text=True, timeout=2)
            match = re.search(r'page size of (\d+) bytes', output)
            values = {key: int(value) for key, value in re.findall(r'^([^:\n]+):\s+(\d+)\.', output, re.M)}
            keys = ('Pages free', 'Pages inactive', 'Pages speculative')
            if match and all(key in values for key in keys):
                facts['available_ram_bytes'] = int(match[1]) * sum(values[key] for key in keys)
        elif platform.system() == 'Linux':
            text = Path('/proc/meminfo').read_text()
            match = re.search(r'^MemAvailable:\s+(\d+) kB', text, re.M)
            if match:
                facts['available_ram_bytes'] = int(match[1]) * 1024
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    try:
        facts.update(_cpu_interval())
    except (ResourceError, OSError, ValueError):
        pass
    if platform.system() == 'Darwin':
        try:
            output = subprocess.check_output(['/usr/bin/memory_pressure', '-Q'], text=True, timeout=2)
            match = re.search(r'System-wide memory free percentage:\s*(\d+)%', output)
            if match:
                facts['os_memory_free_percentage'] = int(match[1])
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    return facts


def preflight(path, *, disk_growth_bytes, ram_bytes, cpu_fraction):
    if (type(disk_growth_bytes) is not int or disk_growth_bytes < 0
            or type(ram_bytes) is not int or ram_bytes <= 0
            or type(cpu_fraction) not in (float, int) or not 0 < cpu_fraction <= 1):
        raise ResourceError('Explicit worst-case disk/RAM/CPU budgets are required')
    facts = host_facts(path)
    if type(facts.get('free_bytes')) is not int or facts['free_bytes'] - disk_growth_bytes < 10 * GIB:
        raise ResourceError('Insufficient disk: worst-case growth must leave at least10GiB')
    if (type(facts.get('available_ram_bytes')) is not int
            or facts['available_ram_bytes'] - ram_bytes < INTERACTIVE_RAM_RESERVE_BYTES):
        raise ResourceError('RAM unknown or insufficient for the budget plus2GiB interactive reserve')
    if (type(facts.get('cpu_count')) is not int or facts['cpu_count'] <= 0
            or type(facts.get('cpu_active_fraction')) not in (float, int)
            or not 0 <= facts['cpu_active_fraction'] <= cpu_fraction
            or type(facts.get('cpu_interval_seconds')) not in (float, int)
            or not facts['cpu_interval_seconds'] >= .5):
        raise ResourceError('CPU interval activity unknown or above the declared active-fraction budget')
    return {'facts': facts, 'worstCaseDiskBytes': disk_growth_bytes, 'ramBudgetBytes': ram_bytes,
            'cpuFraction': cpu_fraction, 'minimumFreeAfterWorstCaseBytes': 10 * GIB,
            'interactiveRamReserveBytes': INTERACTIVE_RAM_RESERVE_BYTES}


def claim_slot(root, slot, run_id):
    root = Path(root)
    if slot not in ('A', 'B') or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', run_id):
        raise ResourceError('Only explicit fixed A/B work slots and safe run ids are allowed')
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or any(path.name not in ('A', 'B') for path in root.iterdir()):
        raise ResourceError('Unexpected work-slot root or entry')
    target = root / slot
    target.mkdir(mode=0o700, exist_ok=True)
    if target.is_symlink() or any(target.iterdir()):
        raise ResourceError('Work slot occupied; no overwrite, automatic reset or alternate slot')
    with (target / 'lease.json').open('x') as stream:
        json.dump({'slot': slot, 'runId': run_id, 'pid': os.getpid(),
                   'resourcePolicy': 'fixed-development-slot-v1',
                   'state': 'occupied; explicit evidence-preserving retirement required'}, stream)
    return target


def retire_slot(root, slot, run_id, closed_receipt, *, explicit=False):
    """Explicit, retained-and-closed retirement. Never called by a run's finally."""
    root, closed_receipt = Path(root).resolve(), Path(closed_receipt).resolve()
    if not explicit or slot not in ('A', 'B'):
        raise ResourceError('Explicit fixed-slot retirement required')
    target = root / slot
    lease = json.loads((target / 'lease.json').read_text())
    if (lease.get('slot') != slot or lease.get('runId') != run_id
            or lease.get('resourcePolicy') != 'fixed-development-slot-v1'
            or root in closed_receipt.parents):
        raise ResourceError('Retirement owner/run/evidence boundary differs')
    closed = json.loads(closed_receipt.read_text())
    if (closed.get('closed') is not True or closed.get('slot') != slot
            or closed.get('runId') != run_id or type(closed.get('processes')) is not list):
        raise ResourceError('Matching closed-process receipt required')
    for process in closed['processes']:
        pid = process.get('pid')
        if type(pid) is not int or pid <= 0:
            raise ResourceError('Invalid owned PID receipt')
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        except PermissionError as error:
            raise ResourceError('Cannot establish absent owned PID') from error
        raise ResourceError('Recorded process is live; refuse slot retirement')
    files = [path for path in target.rglob('*') if path.is_file() or path.is_symlink()]
    retained = closed.get('retained', {})
    admission = closed.get('developmentSource')
    reconstructable = set()
    if admission:
        if Path(admission['slotRoot']).parent != target:
            raise ResourceError('Rebuildable source proof outside this slot')
        validate_source(admission)
        for relative in admission['staged']:
            original = Path(admission['sourceRoot']) / relative
            if not original.exists():
                original = Path(admission['sealedRoot']) / relative
            if (original.is_symlink() or original.stat().st_mode & 0o222
                    or file_sha(original) != admission['files'][relative]['sha256']):
                raise ResourceError('Protected source/diff no longer reconstructs the slot')
            reconstructable.add(str((Path(admission['slotRoot']) / relative).relative_to(target)))
    resettable = set()
    for relative, database in lease.get('ownedDatabases', {}).items():
        _relative(relative)
        private = target / relative
        baseline = Path(database['source'])
        if (closed.get('disposableTestData') is not True or closed.get('uniqueEvidenceRetained') is not True):
            raise ResourceError('Unique evidence/private database not approved for reset: ' + str(private))
        if (not private.is_file() or private.is_symlink() or private.stat().st_ino != database['privateInode']
                or baseline.is_symlink() or target in baseline.resolve().parents
                or file_sha(baseline) != database['sourceSha256']):
            raise ResourceError('Owned private database/baseline proof changed: ' + str(private))
        wal = Path(str(baseline) + '-wal')
        if wal.is_symlink() or (wal.exists() and wal.stat().st_size):
            raise ResourceError('Database reset baseline is not a closed snapshot')
        resettable.update(str(path.relative_to(target)) for path in
                         (private, Path(str(private) + '-wal'), Path(str(private) + '-shm')) if path.exists())
    regular = {str(path.relative_to(target)): path for path in files
               if not path.is_symlink() and path != target / 'lease.json'
               and str(path.relative_to(target)) not in reconstructable | resettable}
    if set(retained) != set(regular):
        raise ResourceError('Every slot payload must be independently retained before retirement')
    links = [path for path in files if path.is_symlink()]
    if links:
        if not admission or Path(admission['slotRoot']).parent != target:
            raise ResourceError('Unverifiable resource reference at retirement')
        validate_source(admission)
        if links != [Path(admission['dictionaryReference']['path'])]:
            raise ResourceError('Unexpected slot symlink at retirement')
    for relative, path in regular.items():
        entry = retained[relative]
        archive = Path(entry['path'])
        if (archive.is_symlink() or not archive.is_file() or root in archive.resolve().parents
                or file_sha(path) != entry['sha256'] or file_sha(archive) != entry['sha256']):
            raise ResourceError('Retained slot payload proof differs: ' + relative)
    retirement = closed_receipt.with_name(closed_receipt.name + '.retirement.json')
    if retirement.exists():
        raise ResourceError('Do not overwrite an earlier retirement receipt')
    # All payloads are retained and all processes absent before any removal.
    record = {'slot': slot, 'runId': run_id, 'previousLease': lease,
              'closedReceipt': str(closed_receipt), 'closedReceiptSha256': file_sha(closed_receipt),
              'retained': retained, 'reconstructableSourceFiles': sorted(reconstructable),
              'resettableOwnedDatabaseFiles': sorted(resettable), 'databaseBaselines': lease.get('ownedDatabases', {}),
              'explicit': True}
    with retirement.open('x') as stream:
        json.dump(record, stream, indent=2)
    for path in files:
        path.unlink()
    for path in sorted((path for path in target.rglob('*') if path.is_dir()), key=lambda p: len(p.parts), reverse=True):
        path.rmdir()
    return record


def _relative(value):
    pure = PurePosixPath(value)
    if (pure.is_absolute() or not pure.parts or '..' in pure.parts
            or '\\' in value or str(pure) != value):
        raise ResourceError('Unsafe source manifest path')
    return pure


def _small_code(relative):
    pure = _relative(relative)
    return ((pure.parts[0] in ('src', 'scripts') and pure.suffix == '.py')
            or (pure.parts[0] == 'web' and (pure.suffix in ('.js', '.css', '.html')
                or ((len(pure.parts) == 2 or pure.parts[1] == 'plugins')
                    and pure.suffix in ('.mjs', '.json', '.webmanifest'))))
            or relative == 'data/lemma.en.txt')


def stage_source(destination, source_root, source_manifest, sealed_root, sealed_manifest):
    destination, source_root, sealed_root = [Path(path).resolve() for path in (destination, source_root, sealed_root)]
    if destination.exists() or destination.is_symlink():
        raise ResourceError('Development source slot already exists; no overwrite')
    if set(source_manifest) != set(sealed_manifest):
        raise ResourceError('Full source manifest identities differ')
    staged, shared = [], []
    for relative, meta in source_manifest.items():
        _relative(relative)
        source = source_root / relative
        if not source.exists() and not source.is_symlink():
            # A frozen small-diff candidate need not duplicate unchanged files.
            # Missing changed files still fail the full manifest SHA below.
            source = sealed_root / relative
        if (source.is_symlink() or not source.is_file() or source.stat().st_size != meta['bytes']
                or file_sha(source) != meta['sha256']):
            raise ResourceError('Source manifest bytes differ: ' + relative)
        if _small_code(relative):
            limit = 3 * 1024 * 1024 if relative == 'data/lemma.en.txt' else 2 * 1024 * 1024
            if meta['bytes'] > limit:
                raise ResourceError('Code overlay is not small: ' + relative)
            staged.append(relative)
        else:
            sealed = sealed_root / relative
            if (meta != sealed_manifest[relative] or sealed.is_symlink() or not sealed.is_file()
                    or sealed.stat().st_mode & 0o222 or file_sha(sealed) != meta['sha256']):
                raise ResourceError('Shared resource must match the exact read-only sealed root: ' + relative)
            shared.append(relative)
    if sum(source_manifest[name]['bytes'] for name in staged) > 16 * 1024 * 1024:
        raise ResourceError('Code overlay exceeds16MiB; no full candidate copies')
    destination.mkdir(parents=True, mode=0o700)
    for relative in staged:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        source = source_root / relative
        if not source.exists() and not source.is_symlink():
            source = sealed_root / relative
        native_clone(source, target)
        target.chmod(0o444)
    if 'data/stardict.db' not in shared:
        raise ResourceError('Sealed dictionary resource is required')
    reference = destination / 'data/stardict.db'
    reference.parent.mkdir(parents=True, exist_ok=True)
    reference.symlink_to((sealed_root / 'data/stardict.db').resolve())
    admission = {'schema': 'dev-source-v1', 'developmentSharedResources': True,
                 'releaseBundleVerified': False, 'slotRoot': str(destination.resolve()),
                 'sourceRoot': str(source_root.resolve()), 'sealedRoot': str(sealed_root.resolve()),
                 'files': source_manifest, 'staged': staged, 'shared': shared,
                 'dictionaryReference': {'path': str(reference), 'target': str(reference.resolve())}}
    validate_source(admission)
    return admission


def source_path(admission, relative):
    _relative(relative)
    if admission.get('schema') != 'dev-source-v1' or relative not in admission['files']:
        raise ResourceError('Unadmitted development source path')
    if relative in admission['staged']:
        return Path(admission['slotRoot']) / relative
    if relative in admission['shared']:
        return Path(admission['sealedRoot']) / relative
    raise ResourceError('Source path has no explicit resource classification')


def validate_source(admission):
    root = Path(admission['slotRoot'])
    staged, shared = set(admission['staged']), set(admission['shared'])
    if staged & shared or staged | shared != set(admission['files']):
        raise ResourceError('Incomplete or overlapping source/resource classification')
    actual = {str(path.relative_to(root)) for path in root.rglob('*') if path.is_file() or path.is_symlink()}
    if actual != staged | {'data/stardict.db'}:
        raise ResourceError('Undeclared slot file or resource reference')
    alias = root / 'data/stardict.db'
    expected = Path(admission['sealedRoot']) / 'data/stardict.db'
    if (not alias.is_symlink() or alias.resolve() != expected
            or admission['dictionaryReference'] != {'path': str(alias), 'target': str(expected)}):
        raise ResourceError('Only the exact sealed dictionary reference is allowed')
    for relative, meta in admission['files'].items():
        path = source_path(admission, relative)
        if (path.is_symlink() or path.resolve() != path or not path.is_file()
                or path.stat().st_size != meta['bytes'] or file_sha(path) != meta['sha256']
                or (relative in shared and path.stat().st_mode & 0o222)):
            raise ResourceError('Development source/resource identity drift: ' + relative)
