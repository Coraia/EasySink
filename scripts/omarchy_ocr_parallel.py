#!/usr/bin/env python3
"""Bounded persistent RapidOCR workers; atomic per-page streaming over SSH."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import select
import signal
import subprocess
import sys
import threading
import time
from omarchy_ocr_bench import atomic_json, digest


def stop_worker_groups(processes):
    """Every bench owns a new session; stop its engine descendants as well."""
    for process in processes:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    until = time.monotonic() + 2
    for process in processes:
        try:
            process.wait(timeout=max(.01, until-time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    # SIGSTOP'd descendants cannot handle TERM, even if their supervisor exited.
    for process in processes:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=2)


def main():
    started = time.perf_counter()
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pages', required=True)
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--rec-batch', type=int, default=64)
    parser.add_argument('--rec-medium-path', type=Path)
    parser.add_argument('--max-side', type=int, default=2200)
    parser.add_argument('--det-side', type=int, default=736)
    parser.add_argument('--deadline', type=float, default=600)
    parser.add_argument('--page-timeout', type=float, default=15)
    parser.add_argument('--engine-start-timeout', type=float, default=30)
    parser.add_argument('--stream-pages', action='store_true')
    parser.add_argument('--watch-stdin', action='store_true')
    args = parser.parse_args()
    numbers = sorted(set(int(n) for n in args.pages.split(',')))
    if (not numbers or min(numbers)<1 or not 1<=args.workers<=4 or not 1<=args.deadline<=1200
            or not 1<=args.page_timeout<=120 or not 1<=args.engine_start_timeout<=120):
        raise ValueError('Invalid bounded runner settings')
    args.output.mkdir(parents=True,exist_ok=False)
    (args.output/'pages').mkdir()
    cancelled = threading.Event()
    shutdown = threading.Event()
    events = queue.Queue()
    processes = []
    manifests = {}
    pages = {}
    finished = {}
    source_sha = digest(args.source)
    identity = {'protocol_version':1,'source_sha256':source_sha,
                'pages_requested':numbers,'workers':args.workers,'rec_batch':args.rec_batch,
                'max_side':args.max_side,'det_side':args.det_side,
                'page_timeout_seconds':args.page_timeout,
                'engine_start_timeout_seconds':args.engine_start_timeout,
                'runner_sha256':digest(Path(__file__)),
                'worker_sha256':digest(Path(__file__).with_name('omarchy_ocr_bench.py'))}
    if args.rec_medium_path:
        identity['recognizer_override'] = {'path':str(args.rec_medium_path),
                                          'sha256':digest(args.rec_medium_path)}
    atomic_json(args.output/'identity.json',identity)
    log = (args.output/'events.jsonl').open('w',encoding='utf8')
    def emit(event):
        event={**event,'elapsed_ms':round((time.perf_counter()-started)*1000,3)}
        line=json.dumps(event,ensure_ascii=False,allow_nan=False)
        log.write(line+'\n');log.flush()
        try:
            print(line,flush=True)
        except BrokenPipeError:
            cancelled.set()
    def read_events(index, process):
        try:
            for line in process.stdout:
                try:
                    events.put((index,json.loads(line)))
                except ValueError:
                    events.put((index,{'event':'invalid_stdout','message':line[:200]}))
        finally:
            process.wait()
            events.put((index,{'event':'worker_exited','exit_code':process.returncode}))
    def watch_input():
        # Avoid holding BufferedReader's lock in a daemon thread at interpreter
        # shutdown; that aborts otherwise-successful streamed runs.
        descriptor = sys.stdin.fileno()
        while not shutdown.is_set():
            ready, _, _ = select.select([descriptor], [], [], .2)
            if ready and not os.read(descriptor, 1):
                cancelled.set()
                return
    def watchdog():
        # stdout can block indefinitely when SSH stops reading. Cleanup must not
        # depend on the event loop making progress or writing another event.
        while not shutdown.wait(.2):
            expired = time.perf_counter()-started > args.deadline
            if not cancelled.is_set() and not expired:
                continue
            cancelled.set()
            stop_worker_groups(processes)
            atomic_json(args.output/'cancelled.json', {
                'reason':'deadline' if expired else 'disconnect_or_signal',
                'worker_exit_codes':[process.returncode for process in processes],
                'elapsed_ms':round((time.perf_counter()-started)*1000,3)})
            if not shutdown.wait(1):
                os._exit(2)
            return
    for name in ('SIGTERM','SIGINT','SIGHUP'):
        if hasattr(signal,name):signal.signal(getattr(signal,name),lambda *_:cancelled.set())
    if args.watch_stdin:
        threading.Thread(target=watch_input,daemon=True).start()
    exits = {}
    try:
        for index in range(min(args.workers,len(numbers))):
            assigned = numbers[index::args.workers]
            command=[sys.executable,str(Path(__file__).with_name('omarchy_ocr_bench.py')),
                     '--source',str(args.source),'--output',str(args.output/f'worker-{index}'),
                     '--pages',','.join(map(str,assigned)),'--device','cuda',
                     '--rec-batch',str(args.rec_batch),'--max-side',str(args.max_side),
                     '--det-side',str(args.det_side), '--page-timeout',str(args.page_timeout),
                     '--engine-start-timeout',str(args.engine_start_timeout)]
            if args.rec_medium_path:
                command.extend(['--rec-medium-path',str(args.rec_medium_path)])
            stderr=(args.output/f'worker-{index}.stderr').open('w')
            process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                                     stderr=stderr,text=True,bufsize=1,start_new_session=True)
            stderr.close();processes.append(process)
            threading.Thread(target=read_events,args=(index,process),daemon=True).start()
        threading.Thread(target=watchdog,daemon=True).start()
        while len(exits)<len(processes):
            if cancelled.is_set() or time.perf_counter()-started>args.deadline:
                emit({'event':'cancelled','reason':'disconnect_or_signal' if cancelled.is_set() else 'deadline'})
                break
            try:index,event=events.get(timeout=.2)
            except queue.Empty:continue
            kind=event.get('event')
            if kind=='started':
                manifests[index]=event
                atomic_json(args.output/'manifest.json',{'identity':identity,'workers':manifests})
                emit({'event':'worker_ready','worker':index,'manifest':event})
            elif kind=='page_completed':
                number=event['page_number']
                value=json.loads((args.output/f'worker-{index}'/'pages'/f'p{number:06d}.json').read_text())
                if number not in numbers or number in pages or value['source_sha256']!=source_sha:
                    raise ValueError('Worker page identity mismatch')
                atomic_json(args.output/'pages'/f'p{number:06d}.json',value)
                pages[number]={**event,'worker':index}
                payload={'event':'page_completed','worker':index,'page_number':number,
                         'page_path':f'pages/p{number:06d}.json','characters':len(value['text']),
                         'quality_state':value['quality_state'],'conversion_ms':value['conversion_ms']}
                if args.stream_pages:
                    payload['page']=value
                    payload['raw']=json.loads((args.output/f'worker-{index}'/'raw'/f'p{number:06d}.json').read_text())
                emit(payload)
            elif kind=='finished':finished[index]=event
            elif kind=='worker_exited':exits[index]=event['exit_code']
            else:emit({'worker':index,**event})
        missing=sorted(set(numbers)-set(pages))
        result={'event':'finished','identity':identity,'requested':len(numbers),'completed':len(pages),
                'empty_ocr':sum(p['quality_state']=='ocr_empty' for p in pages.values()),
                'missing_pages':missing,'workers':finished,'exit_codes':exits,
                'elapsed_ms':round((time.perf_counter()-started)*1000,3)}
        atomic_json(args.output/'result.json',result)
        emit(result)
        return 0 if (not missing and not result['empty_ocr']
                     and len(exits)==len(processes) and all(code==0 for code in exits.values())
                     and not cancelled.is_set()) else 2
    finally:
        stop_worker_groups(processes)
        log.close()
        shutdown.set()


if __name__=='__main__':
    raise SystemExit(main())
