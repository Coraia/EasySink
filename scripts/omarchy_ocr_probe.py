#!/usr/bin/env python3
"""Read-only identity probe for the dedicated Wise Reader Omarchy environment.

Uses package metadata and file reads only: no OCR imports, GPU initialization,
model downloads, document reads, service operations or listening sockets.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import sys


PROTOCOL_VERSION = 1
MEDIUM_SHA256 = 'eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b'
SETTINGS = {
    'workers': 2, 'device': 'cuda', 'max_side': 2200, 'det_side': 736,
    'rec_batch': 64, 'text_score': 0.0, 'use_cls': False, 'max_retries': 1,
    'language': 'chinese_cht', 'deadline_seconds': 600,
    'page_timeout_seconds': 15, 'engine_start_timeout_seconds': 30,
}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def describe():
    root = (Path.home() / 'apps' / 'wise-reader-ocr').resolve()
    if Path(__file__).resolve().parent != root:
        raise RuntimeError('Probe must be deployed in the dedicated Wise Reader OCR root.')
    versions = {name: importlib.metadata.version(name)
                for name in ('rapidocr', 'onnxruntime-gpu', 'pypdfium2')}
    distribution = importlib.metadata.distribution('rapidocr')
    model_dir = Path(distribution.locate_file('rapidocr/models'))
    models = {path.name: {'sha256': digest(path), 'bytes': path.stat().st_size}
              for path in sorted(model_dir.glob('*.onnx'))}
    if not models:
        raise RuntimeError('Installed RapidOCR model files are missing.')
    medium_path = root / 'models' / 'PP-OCRv6_rec_medium.onnx'
    medium = {'sha256': digest(medium_path), 'bytes': medium_path.stat().st_size}
    if medium != {'sha256': MEDIUM_SHA256, 'bytes': 76629984}:
        raise RuntimeError('Selected RapidOCR medium recognizer checksum or size differs from its pin.')
    models[medium_path.name] = medium
    code = {name: digest(root / name) for name in (
        'omarchy_ocr_probe.py', 'omarchy_ocr_parallel.py', 'omarchy_ocr_bench.py')}
    return {
        'protocol_version': PROTOCOL_VERSION, 'engine': 'rapidocr',
        'root': str(root), 'python': str(Path(sys.executable).absolute()),
        'python_version': platform.python_version(), 'versions': versions,
        'models': models, 'code': code, 'settings': dict(SETTINGS),
        'recognizer_override': {'path': str(medium_path), 'sha256': MEDIUM_SHA256},
        'probe_scope': 'installed_files_only; CUDA availability verified by worker manifest',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--describe', action='store_true')
    parser.parse_args()
    try:
        result = describe()
    except Exception as error:
        print(json.dumps({'available': False, 'error': str(error),
                          'error_type': type(error).__name__}), flush=True)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
