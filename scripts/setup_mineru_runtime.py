#!/usr/bin/env python3
"""Register an existing MinerU 4.0.11 CPU installation, without any downloads.

By default make a separate hardlinked installation under .runtime/mineru (same
filesystem); old experiments stay intact. Python is invoked directly, never the
relocated venv's console scripts. No package files are modified. --register-only
registers already managed paths instead. Re-registration requires --refresh.
"""
from __future__ import annotations
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from wise_reader.pdf_lab.adapters.mineru_runtime import (MINERU_VERSION, SETTINGS, manifest_identity, sha256,
    MinerURuntime, _stat_signature, write_verification_receipt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--venv', required=True, type=Path)
    parser.add_argument('--models', required=True, type=Path, help='Directory containing MFR/, Layout/, OCR/, Table/.')
    parser.add_argument('--destination', type=Path, default=ROOT / '.runtime/mineru')
    parser.add_argument('--register-only', action='store_true')
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    # The registration refresh shares the same exclusion as model inference.
    runtime_lock = (destination / 'inference.lock').open('a+')
    try:
        fcntl.flock(runtime_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error('MinerU inference is active; register after that process finishes.')
    manifest = destination / 'runtime.json'
    if manifest.exists() and not args.refresh:
        parser.error('Manifest already exists; use --refresh after inspecting installation changes.')
    venv, models = args.venv.resolve(), args.models.resolve()
    if not args.register_only:
        for source, target in ((venv, destination / 'venv'), (models, destination / 'models/MinerU-4_models_onnx')):
            if target.exists():
                if not args.refresh:
                    parser.error(f'{target} exists; use --register-only or --refresh.')
            else:
                shutil.copytree(source, target, symlinks=True, copy_function=os.link,
                                ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        venv, models = destination / 'venv', destination / 'models/MinerU-4_models_onnx'
    if models.name != 'MinerU-4_models_onnx':
        parser.error('--models must be the MinerU-4_models_onnx directory.')
    # Metadata probe uses the relocated executable: verifies actual sys.prefix and imports.
    probe = subprocess.run([str(venv / 'bin/python'), '-I', '-c',
        'import importlib.metadata as m,json,sys; import onnxruntime,pypdfium2; '
        'print(json.dumps({"prefix":sys.prefix,"packages":{d.metadata["Name"].lower():d.version for d in m.distributions()}}))'],
        check=True, capture_output=True, text=True, timeout=30)
    info = json.loads(probe.stdout)
    if Path(info['prefix']).resolve() != venv.resolve() or info['packages'].get('mineru') != MINERU_VERSION:
        raise RuntimeError('Relocated Python prefix or pinned MinerU version is incorrect.')
    files = []
    signatures = {}
    # Full installed distribution + model fingerprints; no Python dependency imports at discovery.
    for root_name, root in (('venv', venv), ('models', models)):
        for file in sorted(root.rglob('*')):
            if not file.is_file() or file.is_symlink() or '__pycache__' in file.parts or file.suffix == '.pyc':
                continue
            # Console scripts contain old shebangs and are not runtime entry points.
            if root_name == 'venv' and file.parent == venv / 'bin':
                continue
            stat = file.stat()
            digest = sha256(file)
            if _stat_signature(file.stat()) != _stat_signature(stat):
                raise RuntimeError(f'Runtime changed during setup hashing: {file}')
            signatures[root_name + '/' + str(file.relative_to(root))] = _stat_signature(stat)
            files.append({'root': root_name, 'file': str(file.relative_to(root)),
                          'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns, 'sha256': digest})
    required = ['MFR/pp_formulanet_plus_m/PP-FormulaNet_plus-M.onnx', 'MFR/pp_formulanet_plus_m/PP-FormulaNet_plus-M_inference.yml']
    for name in required:
        if not (models / name).is_file():
            raise RuntimeError(f'Required recognition model is missing: {name}')
    for folder in ('Layout', 'OCR', 'Table'):
        if not list((models / folder).rglob('*.onnx')):
            raise RuntimeError(f'Required conversion models are missing: {folder}')
    inventory = destination / 'runtime-files.json'
    inventory.write_text(json.dumps(files, ensure_ascii=False) + '\n')
    probe_files = [row for row in files if row['root'] == 'models' or
                   '/mineru/' in row['file'] or row['file'].endswith('.dist-info/METADATA') or
                   '/onnxruntime/capi/' in row['file']]
    python_stat = (venv / 'bin/python').stat()
    data = {'schema_version': 1, 'version': MINERU_VERSION, 'venv': str(venv), 'models': str(models),
            'packages': info['packages'], 'settings': SETTINGS, 'files': probe_files,
            'inventory_sha256': sha256(inventory),
            'python': {'bytes': python_stat.st_size, 'mtime_ns': python_stat.st_mtime_ns, 'sha256': sha256(venv / 'bin/python')}}
    data['identity'] = manifest_identity(data)
    fd, temporary = tempfile.mkstemp(dir=destination, prefix='.runtime-')
    with os.fdopen(fd, 'w') as stream:
        json.dump(data, stream, ensure_ascii=False)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, manifest)
    signatures['@python'] = _stat_signature((venv / 'bin/python').stat())
    write_verification_receipt(MinerURuntime(venv / 'bin/python', models, manifest, data['identity'], dict(SETTINGS)), signatures)
    print(json.dumps({'manifest': str(manifest), 'python': str(venv / 'bin/python'),
                      'models': str(models), 'identity': data['identity'], 'verified_files': len(files),
                      'downloads': 0, 'relocated_prefix_verified': True}))


if __name__ == '__main__':
    main()
