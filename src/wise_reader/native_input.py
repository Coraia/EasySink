"""Local-only connection discovery; credentials are ephemeral and never logged."""
import json
import os
import sys
import urllib.request
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse


def register(app, root: Path):
    @app.get('/api/reading/native-trackpad')
    def native_trackpad(request: Request):
        result = {'available': False, 'platform': sys.platform}
        if (sys.platform == 'darwin' and os.environ.get('WR_NATIVE_TRACKPAD') != '0'
                and request.client and request.client.host in {'127.0.0.1', '::1'}):
            try:
                config = json.loads((root / '.runtime/trackpad-lab/client.json').read_text())
                with urllib.request.urlopen('http://127.0.0.1:8769/health', timeout=.3) as response:
                    ready = json.load(response).get('ok') is True
                if ready and config['url'].startswith('ws://127.0.0.1:8769/events?token='):
                    result.update(available=True, url=config['url'])
            except (OSError, ValueError, KeyError):
                pass
        return JSONResponse(result, headers={'Cache-Control': 'no-store'})
