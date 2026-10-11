"""Password hashing, expiring opaque sessions and server-side account isolation."""
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from fastapi import HTTPException
from .store import identifier, timestamp

COOKIE = 'dispatch_session'
SESSION_SECONDS = 7 * 86400


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f'scrypt${salt}${digest}'


def public_user(user):
    return {k: user[k] for k in ('id', 'username', 'display_name')}


class Auth:
    def __init__(self, store):
        self.store = store
        self.attempts = {}
        with store.connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY COLLATE NOCASE, value TEXT NOT NULL)')
        self.dummy_hash = password_hash(secrets.token_urlsafe(20))

    def throttle(self, address, username):
        key = (address, username.casefold())
        now = time.monotonic()
        with self.store.lock:
            attempts = [t for t in self.attempts.get(key, []) if now-t < 300]
            if len(attempts) >= 8:
                raise HTTPException(429, '尝试次数过多，请五分钟后再试')
            attempts.append(now)
            self.attempts[key] = attempts
        return key

    def register(self, body):
        import json
        user = {'id': identifier('user'), 'username': body.username, 'display_name': body.display_name, 'password_hash': password_hash(body.password), 'created_at': timestamp()}
        try:
            with self.store.lock, self.store.connection() as db:
                db.execute('INSERT INTO accounts VALUES (?,?)', (body.username, json.dumps(user, ensure_ascii=False)))
        except sqlite3.IntegrityError:
            raise HTTPException(409, '该用户名已注册，请登录或更换用户名')
        return user

    def login(self, body):
        import json
        with self.store.connection() as db:
            row = db.execute('SELECT value FROM accounts WHERE username=? COLLATE NOCASE', (body.username,)).fetchone()
        user = json.loads(row[0]) if row else None
        saved = user['password_hash'] if user else self.dummy_hash
        salt = saved.split('$')[1]
        valid = hmac.compare_digest(password_hash(body.password, salt), saved)
        if not user or not valid:
            raise HTTPException(401, '用户名或密码不正确')
        return user

    def session(self, user, response):
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        self.store.put('session', {'id': digest, 'user_id': user['id'], 'user': public_user(user), 'expires': time.time()+SESSION_SECONDS})
        response.set_cookie(COOKIE, token, httponly=True, samesite='lax', secure=os.getenv('COOKIE_SECURE', 'false').lower() == 'true', max_age=SESSION_SECONDS, path='/')
        return public_user(user)

    def current(self, request):
        token = request.cookies.get(COOKIE)
        session = self.store.get('session', hashlib.sha256(token.encode()).hexdigest()) if token else None
        if not session or session['expires'] < time.time():
            raise HTTPException(401, {'code': 'AUTH_REQUIRED', 'message': '请登录后继续'})
        return session['user']

    def logout(self, request, response):
        token = request.cookies.get(COOKIE)
        if token:
            self.store.delete('session', hashlib.sha256(token.encode()).hexdigest())
        response.delete_cookie(COOKIE, path='/')
