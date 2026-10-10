"""Private pinned model process. Never import this module in the reader process."""
from __future__ import annotations
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time

# Direct execution must not shadow the installed mineru package with mineru.py.
sys.path = [p for p in sys.path if Path(p or '.').resolve() != Path(__file__).resolve().parent]
sys.path.insert(0, str(Path(__file__).resolve().parents[4] / 'src'))
from wise_reader.pdf_lab.adapters.mineru_runtime import discover_mineru_runtime, verify_runtime_files, MINERU_VERSION

MAX_MESSAGE = 32 * 1024**2
_protocol = None


def main():
    # Keep protocol independent of dependency banners and native writes to stdout.
    global _protocol
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', buffering=1)
    _protocol = protocol
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    parent = os.getppid()
    def watch_parent():
        while True:
            if os.getppid() != parent:
                os._exit(130)
            time.sleep(.2)
    threading.Thread(target=watch_parent, daemon=True).start()
    def offline(event, args):
        if event == 'socket.connect' and args[0].family in (socket.AF_INET, socket.AF_INET6):
            raise PermissionError('MinerU runtime is offline; downloads and external connections are disabled.')
    sys.addaudithook(offline)
    started = time.perf_counter()
    runtime = discover_mineru_runtime()
    integrity = verify_runtime_files(runtime)
    verified_at = time.perf_counter()
    if importlib.metadata.version('mineru') != MINERU_VERSION:
        raise RuntimeError('Pinned MinerU private hook version changed.')
    import onnxruntime as ort
    original_session = ort.InferenceSession
    sessions = []
    class CPUOnlySession(original_session):
        def __init__(self, path, *args, **kwargs):
            model = Path(path).resolve()
            if not model.is_relative_to(runtime.models.resolve()) or 'MFR' in model.relative_to(runtime.models.resolve()).parts:
                raise RuntimeError('Source-first conversion cannot load MFR or unregistered models.')
            providers = kwargs.get('providers')
            names = [p[0] if isinstance(p, (tuple, list)) else p for p in providers or []]
            if names != ['CPUExecutionProvider']:
                raise RuntimeError(f'MinerU model requires explicit CPUExecutionProvider: {providers}')
            options = kwargs.get('sess_options') or (args[0] if args else None)
            if options is None or (options.intra_op_num_threads, options.inter_op_num_threads) != (4, 1):
                raise RuntimeError('MinerU ORT thread budget changed.')
            model_started = time.perf_counter()
            super().__init__(path, *args, **kwargs)
            if self.get_providers() != ['CPUExecutionProvider']:
                raise RuntimeError('MinerU initialized a non-CPU provider.')
            self.record = {'model': str(model.relative_to(runtime.models)), 'providers': self.get_providers(), 'calls': 0,
                           'init_ms': round((time.perf_counter() - model_started) * 1000, 3)}
            sessions.append(self.record)
        def run(self, *args, **kwargs):
            self.record['calls'] += 1
            return super().run(*args, **kwargs)
    ort.InferenceSession = CPUOnlySession
    from mineru.parser import MinerUParser
    from mineru.model.runtime.hybrid import HybridLocalModelContext
    captured = {}
    class SourceFormulaHook:
        def batch_predict(self, inputs, images, **kwargs):
            result = []
            for forms, image in zip(inputs, images):
                items = []
                for form in forms:
                    if form.get('label') not in ('inline_formula', 'display_formula'):
                        continue
                    token = f'WRFORMULA{len(captured):010d}'
                    box = [float(n) / (image.shape[1] if i % 2 == 0 else image.shape[0]) for i, n in enumerate(form['bbox'])]
                    if len(box) != 4 or not (0 <= box[0] < box[2] <= 1.01 and 0 <= box[1] < box[3] <= 1.01):
                        raise ValueError('Invalid formula detection geometry.')
                    captured[token] = {'kind': form['label'], 'bbox': [min(1., n) for n in box]}
                    items.append({**form, 'latex': token})
                result.append(items)
            return result
    # Sole private seam, pinned to 4.0.11 and confined to this disposable process.
    HybridLocalModelContext.get_mfr_model = lambda self: SourceFormulaHook()
    parser = MinerUParser(tier='basic', parse_mode='auto', image_analysis=True)
    imported_at = time.perf_counter()
    try:
        for line in sys.stdin:
            if len(line) > 65536:
                raise ValueError('Oversized engine command.')
            command = json.loads(line)
            captured.clear()
            try:
                parse_started = time.perf_counter()
                result = parser.parse(Path(command['source']), page_range=str(command['page']))
                raw = result.to_dict(skip_defaults=False)
                if len(raw['pages']) != 1 or raw['pages'][0]['page_idx'] != command['page'] - 1:
                    raise ValueError('MinerU returned an incorrect page identity.')
                payload = {'raw_page': raw['pages'][0], 'detections': captured,
                           'sessions': sessions, 'formula_model_calls': 0, 'runtime_identity': runtime.identity,
                           'engine_timings': {'runtime_verification_ms': round((verified_at-started)*1000, 3),
                                              'integrity': integrity,
                                              'dependency_import_ms': round((imported_at-verified_at)*1000, 3),
                                              'page_parse_ms': round((time.perf_counter()-parse_started)*1000, 3),
                                              'cumulative_model_init_ms': round(sum(s['init_ms'] for s in sessions), 3)}}
            except Exception as error:
                from wise_reader.pdf_lab.conversion import _retryable_page_error, classify_error
                payload = {'error': {'message': str(error)[:1000], 'category': classify_error(error),
                                    'type': type(error).__name__, 'retryable': _retryable_page_error(error)}}
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
            if len(encoded.encode()) > MAX_MESSAGE:
                raise ValueError('MinerU page exceeds IPC budget.')
            protocol.write(encoded + '\n'); protocol.flush()
    finally:
        parser.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if _protocol is not None:
            _protocol.write(json.dumps({'error': {'message': str(error)[:1000], 'category': 'runtime_not_ready',
                                                  'type': type(error).__name__, 'retryable': False}}) + '\n')
            _protocol.flush()
        raise
