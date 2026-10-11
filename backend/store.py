"""Local SQLite JSON object store; every operation uses an independent connection."""
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock


def identifier(prefix):
    return f'{prefix}_{uuid.uuid4().hex[:12]}'


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path=None):
        self.path = Path(path or os.getenv('DISPATCH_DB', 'data/dispatch.sqlite'))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        with self.connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS objects (kind TEXT, id TEXT PRIMARY KEY, value TEXT NOT NULL)')

    def connection(self):
        return sqlite3.connect(self.path, timeout=15)

    def put(self, kind, value):
        with self.lock, self.connection() as db:
            db.execute('INSERT OR REPLACE INTO objects VALUES (?,?,?)', (kind, value['id'], json.dumps(value, ensure_ascii=False)))
        return value

    def get(self, kind, id):
        with self.connection() as db:
            row = db.execute('SELECT value FROM objects WHERE kind=? AND id=?', (kind, id)).fetchone()
        return json.loads(row[0]) if row else None

    def all(self, kind):
        with self.connection() as db:
            rows = db.execute('SELECT value FROM objects WHERE kind=? ORDER BY rowid DESC', (kind,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def delete(self, kind, id):
        with self.lock, self.connection() as db:
            db.execute('DELETE FROM objects WHERE kind=? AND id=?', (kind, id))
