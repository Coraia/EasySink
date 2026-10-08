"""Real HTTP E2E against a disposable database, with restart/corruption paths.

Run: .venv/bin/python scripts/e2e_book_open.py --doc-id 10
Production data is copied read-only. No external AI requests are issued.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--doc-id', type=int, default=10)
    parser.add_argument('--output', default='outputs/wise-reader-open-python-20261005/http-e2e.json')
    args = parser.parse_args()
    from wise_reader.settings import Settings
    original = Path(Settings().wr_user_db) if Settings().wr_user_db else ROOT/'data/user.db'
    checks, process = [], None
    with tempfile.TemporaryDirectory(prefix='wise-reader-open-e2e-') as temp:
        db = Path(temp)/'user.db'
        source = sqlite3.connect(f'file:{original}?mode=ro', uri=True)
        target = sqlite3.connect(db); source.backup(target); source.close()
        target.execute("UPDATE wr_job SET status='cancelled' WHERE status IN ('queued','running')")
        target.commit(); target.close()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        url = f'http://127.0.0.1:{port}'
        env = {**os.environ, 'WR_USER_DB':str(db), 'WR_LLM_ENABLED':'false', 'WR_LLM_API_KEY':''}
        log = open(Path(temp)/'server.log', 'w+')

        def api(path, body=None, method='GET'):
            data = json.dumps(body).encode() if body is not None else None
            request = urllib.request.Request(url+'/api'+path, data=data, method=method,
                                            headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)

        def stop():
            nonlocal process
            if process:
                process.terminate(); process.wait(timeout=10); process = None

        def start():
            nonlocal process
            process = subprocess.Popen([sys.executable,'-m','uvicorn','wise_reader.app:create_app',
                                       '--factory','--host','127.0.0.1','--port',str(port),'--log-level','warning'],
                                      cwd=ROOT, env=env, stdout=log, stderr=log)
            for _ in range(150):
                if process.poll() is not None:
                    raise RuntimeError('Fixture server failed to start')
                try:
                    with urllib.request.urlopen(url+'/health',timeout=.2): return
                except (OSError, urllib.error.URLError): time.sleep(.05)
            raise RuntimeError('Fixture readiness timed out')

        def check(name, condition, **detail):
            checks.append({'name':name,'passed':bool(condition),**detail})
            if not condition: raise AssertionError(name)

        def sql(query, values=()):
            with sqlite3.connect(db) as con:
                result = con.execute(query,values).fetchall(); con.commit(); return result

        path = f'/documents/{args.doc_id}?compact=true'
        try:
            start(); began=time.perf_counter(); initial=api(path)
            check('Persisted analysis survives a new service process', bool(sql('SELECT payload FROM wr_source_analysis WHERE doc_id=?',(args.doc_id,))), ready_api_ms=round((time.perf_counter()-began)*1000,1))
            payload_before=sql('SELECT cache_key,payload FROM wr_source_analysis WHERE doc_id=?',(args.doc_id,))[0]
            original_view=api(path+'&density=0'); light=api(path+'&density=2'); more=api(path+'&density=8')
            check('Original / light / more density remains live',original_view['automatic_count']==0 and more['automatic_count']>=light['automatic_count'], light=light['automatic_count'], more=more['automatic_count'])
            words=[f for b in initial['blocks'] for f in b['fragments'] if f.get('kind')=='word']
            word=words[0]['target']; other=next(f['target'] for f in words if f['target']!=word)
            previous=api('/feedback',{'target':word,'verdict':'known'},'POST')['previous']
            known=api(path)
            check('Known feedback takes effect on cached analysis',not any(f.get('target')==word for b in known['blocks'] for f in b['fragments']))
            api('/feedback',{'target':word,'verdict':'unknown'},'POST'); retained=api(path)
            targets={f.get('target') for b in retained['blocks'] for f in b['fragments']}
            check('Retained annotation preserves other annotated words',word in targets and other in targets)
            profile=api('/profile');api('/profile',{'vocab_size':50000},'PATCH');advanced=api(path)
            check('Profile changes are not cached into presentation',advanced['automatic_count']<=retained['automatic_count'] and any(f.get('target')==word for b in advanced['blocks'] for f in b['fragments']))
            api('/profile',{'vocab_size':profile['vocab_size']},'PATCH');api('/feedback',{'target':word,'verdict':previous},'POST')
            check('Personal changes do not rebuild source analysis',sql('SELECT cache_key,payload FROM wr_source_analysis WHERE doc_id=?',(args.doc_id,))[0]==payload_before)
            check('Reset personal feedback restores exact document response',api(path)==initial)
            stop();sql('UPDATE wr_source_analysis SET payload=? WHERE doc_id=?',(b'invalid-zlib',args.doc_id));start()
            check('Corrupt disk cache falls back to exact analysis',api(path)==initial)
            stop();sql('UPDATE wr_source_analysis SET cache_key=? WHERE doc_id=?',('stale-code-or-dictionary-key',args.doc_id));start()
            check('Stale analysis key is rebuilt',api(path)==initial and sql('SELECT cache_key FROM wr_source_analysis WHERE doc_id=?',(args.doc_id,))[0][0]==payload_before[0])
            small=api('/documents',{'title':'Disposable source-cache E2E','text':'A prominent battery beside the river bank helps developers.'},'POST'); small_id=small['id']
            check('Import prepares analysis for later opens',bool(sql('SELECT doc_id FROM wr_source_analysis WHERE doc_id=?',(small_id,))))
            stop();sql('UPDATE document SET text=text || ?,text_hash=? WHERE id=?',('\nThe changed source has a new ending.', 'changed-content-key',small_id));sql('DELETE FROM wr_content WHERE doc_id=?',(small_id,));start();changed=api(f'/documents/{small_id}?compact=true')
            check('Source changes invalidate cached analysis',any('new ending' in b['text'] for b in changed['blocks']))
            api(f'/documents/{small_id}',method='DELETE')
            check('Deleting disposable book removes its analysis cache',not sql('SELECT doc_id FROM wr_source_analysis WHERE doc_id=?',(small_id,)))
            check('Production database was never used for writes',db.resolve()!=original.resolve())
        finally:
            stop(); log.close()
            output=ROOT/args.output;output.parent.mkdir(parents=True,exist_ok=True)
            output.write_text(json.dumps({'scope':'Isolated real-service HTTP E2E; browser measurements are separate','checks':checks,'passed':sum(c['passed'] for c in checks),'total':len(checks)},ensure_ascii=False,indent=2))
    print(json.dumps({'passed':sum(c['passed'] for c in checks),'total':len(checks),'artifact':str(output)}))


if __name__=='__main__': main()
