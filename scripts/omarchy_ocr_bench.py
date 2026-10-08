#!/usr/bin/env python3
"""Bounded real-PDF OCR, supervised outside the disposable warm CUDA process."""
from __future__ import annotations
import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import math
import multiprocessing
import os
from pathlib import Path
import queue
import sys
import threading
import time

MAX_IPC_BYTES = 8 * 1024 * 1024


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf8') as handle:
        json.dump(value, handle, ensure_ascii=False, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for data in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


class EngineIdentityError(RuntimeError):
    pass


class EngineProtocolError(RuntimeError):
    pass


class EngineCleanupError(RuntimeError):
    pass


def send(connection, value):
    data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf8')
    if len(data) > MAX_IPC_BYTES:
        raise ValueError('Engine response exceeds the bounded IPC payload budget.')
    connection.send_bytes(data)


def recognize(args, doc, engine, number, attempt, source_sha):
    started = time.perf_counter()
    page = doc[number - 1]
    bitmap = None
    try:
        width, height = page.get_size()
        scale = min(1.0, args.max_side / max(width, height))
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil().convert('RGB')
        pixels = image.size
        if args.preview:
            image.save(args.output/'raw'/f'p{number:06d}-attempt{attempt}-input.jpg', quality=95)
    finally:
        if bitmap is not None:
            bitmap.close()
        page.close()
    rendered = time.perf_counter()
    try:
        result = engine(image)
    finally:
        image.close()
    recognized = time.perf_counter()
    boxes = [] if result.boxes is None else result.boxes.tolist()
    texts = [] if result.txts is None else list(result.txts)
    scores = [] if result.scores is None else [float(s) for s in result.scores]
    raw = {'page_number': number, 'pixel_dimensions': pixels,
           'original_dimensions': [width, height], 'boxes': boxes,
           'texts': texts, 'scores': scores, 'engine_stage_seconds': list(result.elapse_list or [])}
    # Keep the first response even if cardinality/geometry validation fails.
    attempt_path = args.output/'raw'/f'p{number:06d}-attempt{attempt}.json'
    if attempt_path.exists():
        raise EngineProtocolError('Attempt would overwrite retained raw evidence.')
    atomic_json(attempt_path, raw)
    if not len(boxes) == len(texts) == len(scores):
        raise ValueError('OCR output cardinalities differ')
    blocks = []
    for index, (box, text, score) in enumerate(zip(boxes, texts, scores)):
        x = [point[0] * width / pixels[0] for point in box]
        y = [point[1] * height / pixels[1] for point in box]
        untrimmed = [min(x), min(y), max(x), max(y)]
        if (not all(math.isfinite(v) for v in untrimmed) or min(x)<-1e-6 or min(y)<-1e-6
                or max(x)>width+1e-6 or max(y)>height+1e-6):
            raise ValueError(f'Out-of-source box at OCR line {index}')
        bbox = [max(0., min(x)), max(0., min(y)), min(width, max(x)), min(height, max(y))]
        if not 0 <= bbox[0] < bbox[2] <= width or not 0 <= bbox[1] < bbox[3] <= height:
            raise ValueError(f'Invalid source box at OCR line {index}')
        blocks.append({'id': f'p{number:06d}-b{index+1:05d}', 'type': 'paragraph',
                       'text': text, 'confidence': score,
                       'source': {'page_number': number, 'bbox': bbox,
                                  'coordinate_space': 'rotated_crop_top_left'}})
    value = {'page_number': number, 'width': width, 'height': height,
             'coordinate_space': 'rotated_crop_top_left', 'extraction_method': 'omarchy_ocr',
             'quality_state': 'candidate' if texts else 'ocr_empty',
             'text': '\n'.join(texts), 'blocks': blocks, 'source_sha256': source_sha,
             'ocr_language': 'chinese_cht', 'attempt': attempt,
             'metrics': {'render_ms': round((rendered-started)*1000, 3),
                         'ocr_ms': round((recognized-rendered)*1000, 3),
                         'engine_stage_seconds': list(result.elapse_list or []),
                         'characters': sum(len(t) for t in texts), 'lines': len(texts)}}
    value['conversion_ms'] = round((time.perf_counter()-started)*1000, 3)
    return {'raw': raw, 'page': value}


def engine_child(connection, args, numbers, source_sha, generation):
    # Redirect the actual descriptor too, so native logging cannot corrupt JSONL.
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    os.environ['OMP_NUM_THREADS'] = '2'
    started = time.perf_counter()
    doc = None
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import onnxruntime as ort
            if args.device == 'cuda':
                ort.preload_dlls()
            import pypdfium2 as pdfium
            import rapidocr
            from rapidocr import RapidOCR, LangRec, ModelType
            params = {'EngineConfig.onnxruntime.use_cuda': args.device == 'cuda',
                      'EngineConfig.onnxruntime.intra_op_num_threads': 2,
                      'EngineConfig.onnxruntime.inter_op_num_threads': 1,
                      'Global.use_cls': False, 'Global.text_score': 0.0,
                      'Rec.lang_type': LangRec.CHINESE_CHT,
                      'Rec.rec_batch_num': args.rec_batch, 'Det.limit_side_len': args.det_side}
            if args.rec_medium_path:
                if digest(args.rec_medium_path) != 'eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b':
                    raise EngineIdentityError('Medium model digest mismatch')
                params.update({'Rec.model_type': ModelType.MEDIUM, 'Rec.model_path': str(args.rec_medium_path)})
            engine = RapidOCR(params=params)
        providers = {name: getattr(engine, name).session.session.get_providers()
                     for name in ('text_det', 'text_rec', 'text_cls')}
        if args.device == 'cuda' and any(providers[name][0] != 'CUDAExecutionProvider'
                                         for name in ('text_det', 'text_rec')):
            raise EngineIdentityError('CUDA required but actual providers fell back: ' + str(providers))
        models = {p.name: {'sha256': digest(p), 'bytes': p.stat().st_size}
                  for p in (Path(rapidocr.__file__).parent / 'models').glob('*.onnx')}
        if args.rec_medium_path:
            models[args.rec_medium_path.name] = {'sha256': digest(args.rec_medium_path),
                                               'bytes': args.rec_medium_path.stat().st_size}
        if digest(args.source) != source_sha:
            raise EngineIdentityError('Source checksum changed before engine initialization.')
        doc = pdfium.PdfDocument(args.source)
        if max(numbers) > len(doc):
            raise EngineIdentityError('Page outside original PDF')
        metadata = {'source_sha256': source_sha, 'pages_requested': numbers,
            'versions': {name: importlib.metadata.version(name)
                         for name in ('rapidocr', 'onnxruntime-gpu', 'pypdfium2')},
            'providers': providers, 'models': models, 'language': 'chinese_cht',
            'settings': {'device': args.device, 'max_side': args.max_side, 'det_side': args.det_side,
                         'rec_batch': args.rec_batch, 'text_score': 0.0, 'use_cls': False,
                         'max_retries': args.max_retries, 'page_timeout_seconds': args.page_timeout,
                         'engine_start_timeout_seconds': args.engine_start_timeout},
            'init_ms': round((time.perf_counter()-started)*1000, 3),
            'runner_sha256': digest(Path(__file__)),
            'engine_pid': os.getpid(), 'engine_generation': generation}
        if args.rec_medium_path:
            metadata['recognizer_override'] = str(args.rec_medium_path)
        send(connection, {'kind': 'ready', 'generation': generation, 'manifest': metadata})
        while True:
            command = json.loads(connection.recv_bytes(4096))
            if command is None:
                return
            number, attempt = command['page_number'], command['attempt']
            if (command.get('generation') != generation or number not in numbers or
                    type(attempt) is not int or not 1 <= attempt <= args.max_retries + 1):
                raise EngineProtocolError('Engine command identity mismatch.')
            response = {'generation': generation, 'page_number': number, 'attempt': attempt}
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    response.update(recognize(args, doc, engine, number, attempt, source_sha))
                response['kind'] = 'page'
            except Exception as error:
                response.update(kind='page_error', type=type(error).__name__, message=str(error),
                                fatal=isinstance(error, (EngineProtocolError, EngineIdentityError)))
            send(connection, response)
    except (EOFError, BrokenPipeError):
        pass
    except Exception as error:
        try:
            send(connection, {'kind': 'startup_error', 'generation': generation,
                              'type': type(error).__name__, 'message': str(error),
                              'fatal': isinstance(error, (EngineIdentityError, EngineProtocolError))})
        except (BrokenPipeError, OSError):
            pass
    finally:
        if doc is not None:
            doc.close()
        connection.close()


class WarmEngine:
    def __init__(self, args, numbers, source_sha, generation, record):
        self.generation, self.record = generation, record
        self.queue, self.stopped = queue.Queue(maxsize=2), threading.Event()
        context = multiprocessing.get_context('spawn')
        self.connection, child = context.Pipe(duplex=True)
        self.process = context.Process(target=engine_child,
            args=(child, args, numbers, source_sha, generation), daemon=False)
        self.process.start()
        child.close()
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.record('engine_starting', pid=self.process.pid, generation=generation)

    def enqueue(self, value):
        while not self.stopped.is_set():
            try:
                self.queue.put(value, timeout=.1)
                return
            except queue.Full:
                pass

    def read(self):
        try:
            while not self.stopped.is_set():
                # Full-frame receive is confined to this thread: poll followed
                # by recv in the deadline loop could hang on a partial frame.
                self.enqueue(json.loads(self.connection.recv_bytes(MAX_IPC_BYTES)))
        except Exception as error:
            self.enqueue(error)

    def receive(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Engine operation exceeded its hard wall deadline.')
        try:
            value = self.queue.get(timeout=remaining)
        except queue.Empty as error:
            raise TimeoutError('Engine operation exceeded its hard wall deadline.') from error
        if time.monotonic() > deadline:
            raise TimeoutError('Engine response arrived after its hard wall deadline.')
        if isinstance(value, Exception):
            if not isinstance(value, EOFError):
                raise EngineProtocolError(f'Invalid engine IPC response: {type(value).__name__}: {value}') from value
            raise RuntimeError(f'Engine child response ended: {type(value).__name__}: {value}') from value
        if not isinstance(value, dict) or value.get('generation') != self.generation:
            raise EngineProtocolError('Engine response generation mismatch.')
        return value

    def close(self, reason):
        self.record('engine_stopping', pid=self.process.pid, generation=self.generation, reason=reason)
        self.stopped.set()
        if self.process.is_alive():
            self.process.terminate()
        self.process.join(1)
        if self.process.is_alive():
            self.process.kill()
            self.process.join(1)
        if self.process.is_alive():
            raise EngineCleanupError('Engine child could not be reaped; replacement is forbidden.')
        self.reader.join(.5)
        if self.reader.is_alive():
            raise EngineCleanupError('Engine IPC reader did not stop after child was reaped.')
        self.connection.close()
        self.record('engine_stopped', pid=self.process.pid, generation=self.generation,
                    reason=reason, exit_code=self.process.exitcode)
        self.process.close()


def identity(manifest):
    return {key: value for key, value in manifest.items()
            if key not in ('init_ms', 'engine_pid', 'engine_generation')}


def main():
    started = time.perf_counter()
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pages', required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cuda')
    parser.add_argument('--max-side', type=int, default=2200)
    parser.add_argument('--det-side', type=int, default=736)
    parser.add_argument('--rec-batch', type=int, default=16)
    parser.add_argument('--rec-medium-path', type=Path)
    parser.add_argument('--max-retries', type=int, default=1)
    parser.add_argument('--page-timeout', type=float, default=15)
    parser.add_argument('--engine-start-timeout', type=float, default=30)
    parser.add_argument('--preview', action='store_true')
    args = parser.parse_args()
    numbers = sorted(set(int(n) for n in args.pages.split(',')))
    if (not numbers or min(numbers)<1 or not 512<=args.max_side<=4000 or not 1<=args.rec_batch<=128
            or not 0<=args.max_retries<=1 or not 0<args.page_timeout<=60
            or not 0<args.engine_start_timeout<=60):
        raise ValueError('Invalid bounded experiment settings')
    args.output.mkdir(parents=True, exist_ok=False)
    for name in ('pages', 'raw', 'errors', 'engines'):
        (args.output/name).mkdir()
    source_sha = digest(args.source)
    event_log = (args.output/'engine-events.jsonl').open('x', encoding='utf8')
    def record(event, **fields):
        event_log.write(json.dumps({'event': event, **fields,
            'elapsed_ms': round((time.perf_counter()-started)*1000, 3)}, allow_nan=False)+'\n')
        event_log.flush()
    engine, first_manifest, generation = None, None, 0
    summaries, failures = [], []
    def start_engine():
        nonlocal engine, generation, first_manifest
        generation += 1
        deadline = time.monotonic() + args.engine_start_timeout
        engine = WarmEngine(args, numbers, source_sha, generation, record)
        try:
            response = engine.receive(deadline)
            if response.get('kind') != 'ready':
                if response.get('fatal'):
                    raise EngineIdentityError(response.get('message', 'Engine startup identity failed.'))
                raise RuntimeError(response.get('message', 'Engine did not become ready.'))
            manifest = response['manifest']
            atomic_json(args.output/'engines'/f'g{generation:04d}.json', manifest)
            if first_manifest is not None and identity(manifest) != identity(first_manifest):
                raise EngineIdentityError('Replacement engine identity differs from first actual engine.')
            record('engine_ready', pid=engine.process.pid, generation=generation, init_ms=manifest['init_ms'])
            return manifest
        except Exception:
            engine.close('initialization_failed')
            engine = None
            raise
    try:
        first_manifest = start_engine()
        atomic_json(args.output/'manifest.json', first_manifest)
        emit({'event': 'started', **first_manifest})
        for number in numbers:
            for attempt in range(1, args.max_retries + 2):
                attempt_started = time.perf_counter()
                try:
                    if engine is None:
                        start_engine()
                    deadline = time.monotonic() + args.page_timeout
                    record('page_started', pid=engine.process.pid, generation=generation,
                           page_number=number, attempt=attempt, page_timeout_seconds=args.page_timeout)
                    send(engine.connection, {'generation': generation, 'page_number': number, 'attempt': attempt})
                    response = engine.receive(deadline)
                    if response.get('page_number') != number or response.get('attempt') != attempt:
                        raise EngineProtocolError('Engine page/attempt response identity mismatch.')
                    if response.get('kind') == 'page_error':
                        if response.get('fatal'):
                            raise EngineProtocolError(response.get('message', 'Fatal child page protocol error.'))
                        raise RuntimeError(f"{response.get('type', 'PageError')}: {response.get('message', '')}")
                    if response.get('kind') != 'page':
                        raise EngineProtocolError('Unexpected engine response kind.')
                    value, raw = response['page'], response['raw']
                    if (value['page_number'] != number or value['attempt'] != attempt or
                            value['source_sha256'] != source_sha or raw['page_number'] != number):
                        raise EngineProtocolError('Engine page payload source identity mismatch.')
                    atomic_json(args.output/'raw'/f'p{number:06d}.json', raw)
                    atomic_json(args.output/'pages'/f'p{number:06d}.json', value)
                    summary = {'page_number': number, **value['metrics'], 'conversion_ms': value['conversion_ms'],
                               'attempt': attempt, 'quality_state': value['quality_state'],
                               'elapsed_ms': round((time.perf_counter()-started)*1000, 3)}
                    summaries.append(summary)
                    record('page_finished', pid=engine.process.pid, generation=generation,
                           page_number=number, attempt=attempt,
                           supervisor_attempt_ms=round((time.perf_counter()-attempt_started)*1000, 3))
                    emit({'event': 'page_completed', **summary})
                    break
                except (EngineIdentityError, EngineProtocolError, EngineCleanupError):
                    raise
                except Exception as error:
                    failure = {'page_number': number, 'attempt': attempt, 'type': type(error).__name__,
                        'message': str(error), 'category': 'page_timeout' if isinstance(error, TimeoutError) else 'remote_page_error',
                        'generation': generation, 'pid': engine.process.pid if engine is not None else None,
                        'elapsed_ms': round((time.perf_counter()-started)*1000, 3),
                        'attempt_ms': round((time.perf_counter()-attempt_started)*1000, 3)}
                    atomic_json(args.output/'errors'/f'p{number:06d}-attempt{attempt}.json', failure)
                    if engine is not None:
                        engine.close('page_timeout' if isinstance(error, TimeoutError) else 'page_error')
                        engine = None
                    emit({'event': 'page_error', **failure})
                    if attempt == args.max_retries + 1:
                        failures.append(failure)
        complete = {'event': 'finished', 'source_sha256': source_sha, 'requested': len(numbers),
                    'completed': len(summaries), 'empty_ocr': sum(s['quality_state']=='ocr_empty' for s in summaries),
                    'failures': failures, 'pages': summaries,
                    'elapsed_ms': round((time.perf_counter()-started)*1000, 3),
                    'init_ms': first_manifest['init_ms'], 'engine_generations': generation}
        atomic_json(args.output/'result.json', complete)
        emit(complete)
        return 0 if not failures and not complete['empty_ocr'] else 2
    finally:
        if engine is not None:
            engine.close('worker_finished')
        event_log.close()


if __name__ == '__main__':
    raise SystemExit(main())
