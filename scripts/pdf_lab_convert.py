#!/usr/bin/env python3
"""JSONL PDF worker; Omarchy transfer requires explicit --engine omarchy."""
from __future__ import annotations

import argparse
import contextlib
import json
import socket
import signal
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))

from wise_reader.pdf_lab.conversion import classify_error, convert_pdf, get_capabilities


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capabilities',action='store_true')
    parser.add_argument('--local-capabilities',action='store_true',help='Probe local adapters without contacting Omarchy.')
    parser.add_argument('--source',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--engine',default='auto',choices=['auto','digital','docling','omarchy','mineru_source'])
    parser.add_argument('--start-page',type=int,default=1)
    parser.add_argument('--end-page',type=int)
    parser.add_argument('--sharded',action='store_true',help='Write bounded page files and a schema v2 index.')
    parser.add_argument('--resume',action='store_true',help='Validate and resume matching sharded checkpoints.')
    args=parser.parse_args()
    if args.capabilities or args.local_capabilities:
        print(json.dumps(get_capabilities(include_remote=not args.local_capabilities),ensure_ascii=False))
        return 0
    if args.source is None or args.output is None:
        parser.error('--source and --output are required for conversion')
    if args.resume and not args.sharded:
        parser.error('--resume requires --sharded')
    # SIGTERM uses the same finally cleanup as Ctrl-C, including owned model child.
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    events=sys.stdout
    def emit(event):
        print(json.dumps(event,ensure_ascii=False),file=events,flush=True)
    try:
        # Dependencies may print banners. Keep stdout parseable JSONL.
        # No Python Internet sockets. The explicitly selected Omarchy driver
        # uses its bounded SSH subprocess; local/auto engines remain local.
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
        with contextlib.redirect_stdout(sys.stderr):
            convert_pdf(args.source,args.output,args.engine,args.start_page,args.end_page,emit,sharded=args.sharded,resume=args.resume)
        return 0
    except KeyboardInterrupt:
        emit({'event':'interrupted','category':'cancelled','error':'Worker interrupted; completed pages retained.'})
        return 130
    except Exception as error:
        print(json.dumps({'category':classify_error(error),'error':str(error)},ensure_ascii=False),file=sys.stderr)
        return 1
    finally:
        if 'original_connect' in locals():
            socket.socket.connect, socket.socket.connect_ex = original_connect, original_connect_ex


if __name__=='__main__':
    raise SystemExit(main())
