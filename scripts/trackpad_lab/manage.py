"""Start/status/stop the local reader bridge, without login autostart."""
import argparse
import json
import os
import secrets
import signal
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
RUNTIME=ROOT/'.runtime/trackpad-lab'
PID=RUNTIME/'process.json'
BINARY=RUNTIME/'PhaseMonitor'

def health():
    try:
        with urllib.request.urlopen('http://127.0.0.1:8769/health',timeout=1) as response: return json.load(response)
    except Exception: return None

def owned():
    if not PID.exists(): return None
    value=json.loads(PID.read_text())
    command=subprocess.run(['ps','-p',str(value['pid']),'-o','command='],capture_output=True,text=True).stdout
    return value['pid'] if 'trackpad_lab.server:app' in command and '8769' in command else None

def start():
    if (h:=health()) and h['ok']:
        if (RUNTIME/'client.json').exists(): print(json.dumps(h));return
        stop() # Migrate the original prototype-only connection once.
    if owned(): raise SystemExit('进程存在但未就绪，请查看 .runtime/trackpad-lab/server.log')
    RUNTIME.mkdir(parents=True,exist_ok=True)
    subprocess.run(['swiftc',str(ROOT/'scripts/trackpad_lab/PhaseMonitor.swift'),'-o',str(BINARY)],check=True)
    token=secrets.token_urlsafe(32)
    url='ws://127.0.0.1:8769/events?token='+token
    client=RUNTIME/'client.json'
    client.write_text(json.dumps({'url':url}))
    client.chmod(0o600)
    config=ROOT/'web/prototypes/trackpad-native/bridge-config.js'
    config.write_text('export const bridgeURL = '+json.dumps(url)+';\n')
    env={**os.environ,'WR_PHASE_TOKEN':token,'WR_PHASE_BINARY':str(BINARY)}
    with (RUNTIME/'server.log').open('ab') as log:
        process=subprocess.Popen([str(ROOT/'.venv/bin/python'),'-m','uvicorn','scripts.trackpad_lab.server:app','--host','127.0.0.1','--port','8769','--no-access-log','--log-level','warning'],cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    PID.write_text(json.dumps({'pid':process.pid}))
    for _ in range(100):
        if (h:=health()) and h['ok']: print(json.dumps(h));return
        time.sleep(.1)
    raise SystemExit('本机监听未就绪，请查看日志；连接不能当作真实手势验收')

def stop():
    if pid:=owned():
        os.kill(pid,signal.SIGTERM)
        for _ in range(50):
            if not owned(): break
            time.sleep(.1)
        else: raise SystemExit('监听服务尚未退出，未清理 PID；请稍后检查')
    PID.unlink(missing_ok=True)
    print('Local trackpad bridge stopped')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['start','status','stop']);args=parser.parse_args()
    if args.action=='start':start()
    elif args.action=='stop':stop()
    else: print(json.dumps(health()))
