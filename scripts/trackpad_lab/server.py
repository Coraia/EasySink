"""Loopback-only prototype phase bridge. Never stores native input events."""
import asyncio
import json
import os
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

TOKEN = os.environ['WR_PHASE_TOKEN']
BINARY = Path(os.environ['WR_PHASE_BINARY'])
ORIGINS = {'http://127.0.0.1:8766', 'http://localhost:8766'}
clients = {}
process = None
ready = False
native_events = 0
last_gate = False

def update_gate():
    global last_gate
    active = any(v['active'] for v in clients.values())
    if process and process.returncode is None and active != last_gate:
        process.stdin.write(b'on\n' if active else b'off\n')
        last_gate = active

async def reader():
    global ready, native_events
    while line := await process.stdout.readline():
        try: event = json.loads(line)
        except ValueError: continue
        if event.get('source') == 'monitor-ready':
            ready = True
            continue
        native_events += 1
        for client in list(clients.values()):
            if not client['active']: continue
            q = client['queue']
            if q.full():
                # Fail explicitly; do not silently drop a gesture-end phase.
                while not q.empty(): q.get_nowait()
                q.put_nowait({'source':'bridge-overflow'})
                client['active'] = False
                update_gate()
            else: q.put_nowait(event)
    ready = False
    for c in list(clients.values()): c['queue'].put_nowait({'source':'monitor-exited'})

@asynccontextmanager
async def lifespan(app):
    global process
    process = await asyncio.create_subprocess_exec(str(BINARY), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    task = asyncio.create_task(reader())
    yield
    task.cancel()
    if process.returncode is None:
        process.terminate()
        await process.wait()

app = FastAPI(lifespan=lifespan)

@app.get('/health')
async def health():
    return {'ok':ready,'mask':'scrollWheel','native_events':native_events,'clients':len(clients),'active_clients':sum(c['active'] for c in clients.values())}

@app.websocket('/events')
async def events(ws: WebSocket):
    if ws.headers.get('origin') not in ORIGINS or ws.query_params.get('token') != TOKEN or len(clients)>=4:
        await ws.close(code=1008)
        return
    await ws.accept()
    client = {'active':False,'queue':asyncio.Queue(maxsize=128)}
    clients[ws] = client
    await ws.send_json({'source':'bridge-ready','monitorReady':ready})
    async def send():
        while True: await ws.send_json(await client['queue'].get())
    task=asyncio.create_task(send())
    try:
        while True:
            data = await ws.receive_json()
            client['active'] = data.get('active') is True and ready
            update_gate()
    except (WebSocketDisconnect, ValueError): pass
    finally:
        task.cancel()
        clients.pop(ws,None)
        update_gate()
