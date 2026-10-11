"""Disposable browser-test server; copy only public provider cache, never accounts."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

root = Path(__file__).resolve().parents[1]
os.chdir(root)
sys.path.insert(0, str(root))
os.environ['DISPATCH_DB'] = str(root / '.tmp' / f'browser-{uuid.uuid4().hex}.sqlite')
from backend.store import Store

store = Store()
public_cache = root / 'data' / 'dispatch.sqlite'
if public_cache.exists():
    with sqlite3.connect(public_cache) as source:
        for value, in source.execute("SELECT value FROM objects WHERE kind='road_cache'"):
            store.put('road_cache', json.loads(value))

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('backend.main:app', host='127.0.0.1', port=8081)
