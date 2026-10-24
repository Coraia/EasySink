"""Finite tiny-resource walkthrough; no actual reader, App or large fixtures."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    assert not args.output.exists(), 'Do not overwrite earlier check evidence'
    rows = []
    start = time.monotonic()
    policy = load('resource_policy', Path(__file__).with_name('resource_policy.py'))

    def check(name, action):
        began = time.monotonic()
        try:
            action()
            rows.append({'name': name, 'pass': True, 'seconds': time.monotonic() - began})
        except Exception as error:
            rows.append({'name': name, 'pass': False, 'error': type(error).__name__ + ': ' + str(error)})

    def rejected(action):
        try:
            action()
        except (policy.ResourceError, ValueError, FileExistsError):
            return
        raise AssertionError('Unsafe operation was accepted')

    with tempfile.TemporaryDirectory(prefix='easysink-resource-small-') as name:
        root = Path(name).resolve()
        source = root / 'source.bin'
        source.write_bytes(b'small fake resource\n' * 64)

        def stream_hash():
            expected = hashlib.sha256(source.read_bytes()).hexdigest()
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('whole-file read')):
                assert policy.file_sha(source) == expected
        check('bounded-stream-hash', stream_hash)

        def fail_clone():
            destination = root / 'failed-clone'
            with patch.object(policy, '_clone_call', side_effect=OSError('declared clone failure')):
                rejected(lambda: policy.native_clone(source, destination))
            assert not destination.exists()
        check('clone-failure-no-copy-fallback', fail_clone)

        def real_clone():
            destination = root / 'actual-native-clone'
            policy.native_clone(source, destination)
            assert source.stat().st_ino != destination.stat().st_ino
            assert policy.file_sha(source) == policy.file_sha(destination)
            rejected(lambda: policy.native_clone(source, destination))
        check('tiny-native-clone-independent-inode-existing-refused', real_clone)

        def slots():
            slots_root = root / 'slots'
            slot = policy.claim_slot(slots_root, 'A', 'first')
            evidence = root / 'old-evidence.json'
            evidence.write_text('{"kept":true}')
            before = evidence.read_bytes()
            rejected(lambda: policy.claim_slot(slots_root, 'A', 'second'))
            rejected(lambda: policy.claim_slot(slots_root, 'C', 'third'))
            assert evidence.read_bytes() == before and not (slots_root / 'B').exists()
            assert slot == slots_root / 'A'
        check('fixed-slot-conflict-no-extra-slot-or-evidence-overwrite', slots)

        def controlled_reuse():
            slots_root = root / 'reuse-slots'
            slot = policy.claim_slot(slots_root, 'A', 'old')
            payload = slot / 'payload.txt'
            payload.write_text('old reproducible evidence')
            retained = root / 'retained-payload.txt'
            retained.write_text(payload.read_text())
            evidence = root / 'closed-small.json'
            child = subprocess.Popen([sys.executable, '-c', 'pass'])
            child.wait(timeout=3)
            receipt = {'slot': 'A', 'runId': 'old', 'closed': True,
                       'processes': [{'pid': child.pid}],
                       'retained': {'payload.txt': {'path': str(retained), 'sha256': policy.file_sha(payload)}}}
            evidence.write_text(json.dumps({**receipt, 'processes': [{'pid': os.getpid()}]}))
            rejected(lambda: policy.retire_slot(slots_root, 'A', 'old', evidence, explicit=True))
            assert payload.exists()
            evidence.write_text(json.dumps(receipt))
            rejected(lambda: policy.retire_slot(slots_root, 'A', 'wrong', evidence, explicit=True))
            before = evidence.read_bytes()
            policy.retire_slot(slots_root, 'A', 'old', evidence, explicit=True)
            assert evidence.read_bytes() == before and retained.read_text() == 'old reproducible evidence'
            assert policy.claim_slot(slots_root, 'A', 'new') == slot
            assert not (slots_root / 'B').exists()
        check('controlled-closed-retained-slot-reuse-and-live-pid-refusal', controlled_reuse)

        def database_reset_reuse():
            baseline = root / 'reset-baseline.sqlite3'
            with sqlite3.connect(baseline) as db:
                db.execute('create table state(value text, payload blob)')
                db.execute("insert into state values('baseline',zeroblob(4*1024*1024))")
            original_sha = policy.file_sha(baseline)
            slots_root = root / 'database-reuse-slots'
            slot = policy.claim_slot(slots_root, 'A', 'db-old')
            (slot / 'data').mkdir()
            private = slot / 'data/user.db'
            policy.snapshot_sqlite(baseline, private)
            with sqlite3.connect(private) as db:
                db.execute("update state set value='test-only change'")
            child = subprocess.Popen([sys.executable, '-c', 'pass'])
            child.wait(timeout=3)
            evidence = root / 'closed-reset-database.json'
            closed = {'slot': 'A', 'runId': 'db-old', 'closed': True,
                      'processes': [{'pid': child.pid}], 'retained': {},
                      'disposableTestData': True, 'uniqueEvidenceRetained': False}
            evidence.write_text(json.dumps(closed))
            rejected(lambda: policy.retire_slot(slots_root, 'A', 'db-old', evidence, explicit=True))
            assert private.exists()
            closed['uniqueEvidenceRetained'] = True
            evidence.write_text(json.dumps(closed))
            policy.retire_slot(slots_root, 'A', 'db-old', evidence, explicit=True)
            slot = policy.claim_slot(slots_root, 'A', 'db-new')
            (slot / 'data').mkdir()
            policy.snapshot_sqlite(baseline, slot / 'data/user.db')
            with sqlite3.connect(slot / 'data/user.db') as db:
                assert db.execute('select value from state').fetchone()[0] == 'baseline'
            assert policy.file_sha(baseline) == original_sha
            assert not (slots_root / 'B').exists()
            assert not list(root.glob('*archive*'))
        check('owned-disposable-database-reset-from-baseline-without-full-archive', database_reset_reuse)

        def database():
            original = root / 'closed.sqlite3'
            with sqlite3.connect(original) as db:
                db.execute('create table record(value text)')
                db.execute("insert into record values('original')")
            before = policy.file_sha(original)
            private = root / 'private.sqlite3'
            policy.snapshot_sqlite(original, private)
            with sqlite3.connect(private) as db:
                db.execute('pragma journal_mode=WAL')
                db.execute("update record set value='private'")
                db.commit()
                assert not Path(str(original) + '-wal').exists()
                assert original.stat().st_ino != private.stat().st_ino
            assert policy.file_sha(original) == before
            Path(str(original) + '-wal').write_bytes(b'not closed')
            rejected(lambda: policy.snapshot_sqlite(original, root / 'bad.sqlite3'))
        check('closed-database-independent-writes-and-wal', database)

        def disk_and_host():
            good = {'free_bytes': 12 * policy.GIB, 'available_ram_bytes': 4 * policy.GIB,
                    'cpu_count': 4, 'load1': 20, 'cpu_active_fraction': .1,
                    'cpu_interval_seconds': 1.0}
            with patch.object(policy, 'host_facts', return_value=good):
                policy.preflight(root, disk_growth_bytes=policy.GIB, ram_bytes=1024, cpu_fraction=.5)
            with patch.object(policy, 'host_facts', return_value=dict(good, load1=None)):
                policy.preflight(root, disk_growth_bytes=1024, ram_bytes=1024, cpu_fraction=.5)
            for bad in [dict(good, free_bytes=9 * policy.GIB), dict(good, available_ram_bytes=0),
                        dict(good, available_ram_bytes=policy.GIB),
                        dict(good, available_ram_bytes=None), dict(good, cpu_active_fraction=None),
                        dict(good, cpu_active_fraction=.9), dict(good, cpu_active_fraction=float('nan')),
                        dict(good, cpu_interval_seconds=0)]:
                with patch.object(policy, 'host_facts', return_value=bad):
                    rejected(lambda: policy.preflight(root, disk_growth_bytes=1024, ram_bytes=1024, cpu_fraction=.5))
            rejected(lambda: policy.preflight(root, disk_growth_bytes=None, ram_bytes=1024, cpu_fraction=.5))
        check('disk-ten-gib-floor-memory-cpu-and-unknown-budget-refuse', disk_and_host)

        def source_boundary():
            sealed = root / 'sealed'
            items = {'src/wise_reader/settings.py': b'ROOT = None\n', 'web/index.html': b'<main>fake</main>',
                     'data/stardict.db': b'fake dictionary', 'web/assets/fake.png': b'fake pixels',
                     'web/vendor/example/nested.js': b'export const fake = true;'}
            manifest = {}
            for relative, body in items.items():
                path = sealed / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
                path.chmod(0o444)
                manifest[relative] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
            staged = root / 'staged'
            admission = policy.stage_source(staged, sealed, manifest, sealed, manifest)
            assert (staged / 'data/stardict.db').is_symlink()
            assert (staged / 'data/stardict.db').resolve() == sealed / 'data/stardict.db'
            assert not (staged / 'web/assets/fake.png').exists()
            assert (staged / 'web/vendor/example/nested.js').is_file()
            assert admission['schema'] == 'dev-source-v1'
            assert policy.source_path(admission, 'web/assets/fake.png') == sealed / 'web/assets/fake.png'
            policy.validate_source(admission)
            (staged / 'web/unexpected').symlink_to(source)
            rejected(lambda: policy.validate_source(admission))
        check('small-code-and-exact-readonly-shared-resource-boundary', source_boundary)

        def lexicon():
            fetch = load('fetch_lexicon_small_check', Path(__file__).resolve().parents[1] / 'fetch_lexicon.py')
            frozen = root / 'sealed-index.sqlite3'
            frozen.write_bytes(b'not a real dictionary')
            frozen.chmod(0o444)
            before = policy.file_sha(frozen)
            rejected(lambda: fetch.build_indexes(frozen))
            link = root / 'index-reference.sqlite3'
            link.symlink_to(frozen)
            rejected(lambda: fetch.build_indexes(link))
            assert policy.file_sha(frozen) == before
        check('indexing-cannot-write-sealed-or-referenced-dictionary', lexicon)

        def portable_build_entry():
            build = Path(__file__).with_name('build.py')
            result = subprocess.run([sys.executable, str(build), '--help'],
                                    check=True, capture_output=True, text=True)
            for option in ('--disk-growth-bytes', '--ram-bytes', '--cpu-fraction'):
                assert option in result.stdout
        check('portable-build-entry-imports-policy-and-declares-budgets', portable_build_entry)

    result = {'kind': 'small-resource-only', 'notReaderOrNativeAcceptance': True,
              'largeRealResourcesRead': False, 'readerAppLaunched': False,
              'passed': all(row['pass'] for row in rows), 'checks': rows,
              'elapsedSeconds': time.monotonic() - start}
    with args.output.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps(result))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
