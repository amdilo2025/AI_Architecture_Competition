"""Serve both frontend and Python API on one local port."""
from pathlib import Path
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def app_is_running(base_url: str) -> bool:
    """Reuse this application's healthy server when launched twice."""
    try:
        with urlopen(f'{base_url}/api/v1/health', timeout=2) as response:
            health = json.load(response)
        with urlopen(f'{base_url}/openapi.json', timeout=2) as response:
            schema = json.load(response)
        return (
            health.get('status') == 'ok'
            and schema.get('info', {}).get('title') == '路序 · 城市配送调度 API'
        )
    except (HTTPError, URLError, OSError, ValueError, AttributeError):
        return False

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    os.chdir(root)
    port = int(os.getenv('PORT', '8080'))
    base_url = f'http://127.0.0.1:{port}'
    if app_is_running(base_url):
        print(f'Service is already running. Open {base_url}/ in your browser.')
        raise SystemExit(0)
    if not (root / 'frontend/dist/index.html').exists():
        raise SystemExit('Frontend is not built. Run setup.ps1 or npm --prefix frontend run build first.')
    import uvicorn
    uvicorn.run('backend.main:app', host='127.0.0.1', port=port)
