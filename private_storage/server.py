"""Single-owner loopback storage behind Tailscale Serve (stdlib only).

Tailscale Serve is the identity boundary. Local processes are trusted.
"""
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import uuid
import sqlite3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import socket
import hashlib
import json
import os
import re
import stat
import unicodedata
from pathlib import Path
from urllib.parse import parse_qsl, quote, unquote, urlsplit

if __package__:
    from . import policies
else:
    import policies

METADATA_LIMIT = 8 * 1024 * 1024
FILE_LIMIT = 32 * 1024 * 1024
RECEIPT_LIMIT = 10 * 1024 * 1024

CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self' data:; connect-src 'self'; object-src 'none'; "
       "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")


class RequestError(Exception):
    def __init__(self, status, message, code=None, revision=None):
        super().__init__(message)
        self.status, self.code, self.revision = status, code, revision


def parse_target(target):
    if (not target.startswith('/') or target.startswith('//')
            or any(ord(c) < 32 or ord(c) == 127 for c in target)
            or re.search(r'%(?![0-9a-fA-F]{2})', target)):
        raise ValueError('Invalid URL')
    route = urlsplit(target)
    if route.scheme or route.netloc or route.fragment or '#' in target:
        raise ValueError('Invalid URL')
    path = unquote(route.path, encoding='utf-8', errors='strict')
    pairs = parse_qsl(route.query, keep_blank_values=True, strict_parsing=True,
                      encoding='utf-8', errors='strict', max_num_fields=8) if route.query else []
    query = dict(pairs)
    if len(query) != len(pairs):
        raise ValueError('Duplicate query parameters')
    return path, query


def require_query(query, required, optional=()):
    if not set(required) <= query.keys() or query.keys() - set(required) - set(optional):
        raise RequestError(400, 'Invalid query parameters.')



def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError('Duplicate JSON fields')
    return result


def reject_constant(value):
    raise ValueError('Non-finite JSON number')


def load_json(text):
    try:
        return json.loads(text, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise RequestError(400, 'Invalid JSON.') from None


def kv_bytes(value):
    if not isinstance(value, str):
        raise RequestError(400, 'KV value must be serialized JSON text.')
    load_json(value)
    try:
        return value.encode('utf-8')
    except UnicodeError:
        raise RequestError(400, 'Invalid UTF-8 text.') from None


def validate_match(value):
    if (not isinstance(value, str) or not re.fullmatch(r'"(0|[1-9][0-9]{0,18})"', value)
            or int(value[1:-1]) >= 9223372036854775807):
        raise RequestError(400, 'Invalid If-Match revision.')
    return value


def etag(revision):
    return '"{}"'.format(revision)


def validate_transaction(app, body):
    if not isinstance(body, dict) or set(body) != {'idempotencyKey', 'operations'}:
        raise RequestError(400, 'Invalid transaction fields.')
    key, operations = body['idempotencyKey'], body['operations']
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_:.-]{1,128}', key):
        raise RequestError(400, 'Invalid idempotency key.')
    if not isinstance(operations, list) or not 1 <= len(operations) <= 512:
        raise RequestError(400, 'Transaction requires 1 to 512 operations.')
    seen, prepared = set(), []
    for op in operations:
        if not isinstance(op, dict) or op.get('kind') not in ('kv', 'file') or op.get('method') not in ('PUT', 'DELETE'):
            raise RequestError(400, 'Invalid operation.')
        kind = op['kind']
        field = 'key' if kind == 'kv' else 'path'
        fields = {'kind', field, 'method', 'ifMatch'} | ({'value'} if op['method'] == 'PUT' else set())
        if set(op) != fields:
            raise RequestError(400, 'Invalid operation fields.')
        name = op[field]
        valid = policies.valid_key(app, name) if kind == 'kv' else policies.valid_file(app, name)
        if not valid:
            raise RequestError(400, 'Invalid resource.')
        if (kind, name) in seen:
            raise RequestError(400, 'Duplicate resource in transaction.')
        seen.add((kind, name))
        expected = validate_match(op['ifMatch'])
        value = None
        if op['method'] == 'PUT':
            if not isinstance(op['value'], str):
                raise RequestError(400, 'Operation value must be text.')
            try:
                value = kv_bytes(op['value']) if kind == 'kv' else op['value'].encode('utf-8')
            except UnicodeError:
                raise RequestError(400, 'Invalid UTF-8 text.') from None
        prepared.append((kind, name, value, expected))
    return prepared


def no_symlink_components(path):
    path = Path(path)
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError('Symlink path components are not allowed.')
    return path


def data_path(data_dir, app):
    if app not in policies.KV_KEYS:
        raise ValueError('Unknown app.')
    data_dir = Path(data_dir)
    if not data_dir.is_absolute():
        raise ValueError('Data directory must be absolute.')
    no_symlink_components(data_dir)
    if data_dir.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
        raise ValueError('Data directory must be outside the repository.')
    database = data_dir / (app + '.sqlite3')
    for candidate in (database, Path(str(database) + '-wal'), Path(str(database) + '-shm')):
        if candidate.is_symlink() or (candidate.exists() and not stat.S_ISREG(candidate.lstat().st_mode)):
            raise ValueError('Database and sidecars must be regular files.')
    return database


class SQLiteStore:
    def __init__(self, data_dir, app):
        self.db_path = data_path(data_dir, app)
        self.data_dir = self.db_path.parent
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.data_dir.chmod(0o700)
        fd = os.open(self.db_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        with closing(self.connect()) as db:
            if db.execute('PRAGMA journal_mode=WAL').fetchone()[0] != 'wal':
                raise sqlite3.OperationalError('WAL unavailable')
            db.execute("""CREATE TABLE IF NOT EXISTS resources (
                kind TEXT NOT NULL, name TEXT NOT NULL, value BLOB,
                revision INTEGER NOT NULL CHECK(revision > 0),
                PRIMARY KEY(kind, name))""")
            db.execute("""CREATE TABLE IF NOT EXISTS idempotency (
                key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)""")

    def connect(self):
        db = sqlite3.connect(self.db_path.as_uri() + '?mode=rw', uri=True,
                             timeout=10, isolation_level=None)
        try:
            db.execute('PRAGMA synchronous=FULL')
            return db
        except Exception:
            db.close()
            raise

    def get(self, kind, name):
        with closing(self.connect()) as db:
            row = db.execute('SELECT value, revision FROM resources WHERE kind=? AND name=?',
                             (kind, name)).fetchone()
            return row if row is not None else (None, 0)

    def put(self, kind, name, value, expected):
        with closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            revision = self.check_revision(db, kind, name, value, expected)
            self.write(db, kind, name, value, revision)
            db.commit()
            return revision

    @staticmethod
    def check_revision(db, kind, name, value, expected):
        row = db.execute('SELECT revision FROM resources WHERE kind=? AND name=?',
                         (kind, name)).fetchone()
        revision = row[0] if row is not None else 0
        if expected != etag(revision):
            raise RequestError(409, 'Changed on another device.', 'CONFLICT', revision)
        if kind == 'file' and policies.RECEIPT.fullmatch(name) and value is not None and revision:
            raise RequestError(409, 'Receipt IDs are immutable. Use a new ID.', 'CONFLICT', revision)
        return revision + 1

    @staticmethod
    def write(db, kind, name, value, revision):
        db.execute("""INSERT INTO resources(kind,name,value,revision) VALUES(?,?,?,?)
            ON CONFLICT(kind,name) DO UPDATE SET value=excluded.value,revision=excluded.revision
            """, (kind, name, value, revision))

    def transaction(self, operations, key, fingerprint):
        with closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            replay = db.execute('SELECT fingerprint, result FROM idempotency WHERE key=?', (key,)).fetchone()
            if replay is not None:
                if replay[0] != fingerprint:
                    raise RequestError(409, 'Idempotency key used with a different payload.', 'IDEMPOTENCY_MISMATCH')
                return json.loads(replay[1])
            pending = []
            for kind, name, value, expected in operations:
                revision = self.check_revision(db, kind, name, value, expected)
                pending.append((kind, name, value, revision))
            for args in pending:
                self.write(db, *args)
            result = {'ok': True, 'revisions': [
                {'kind': kind, 'key' if kind == 'kv' else 'path': name, 'etag': etag(revision)}
                for kind, name, value, revision in pending]}
            db.execute('INSERT INTO idempotency(key,fingerprint,result) VALUES(?,?,?)',
                       (key, fingerprint, json.dumps(result)))
            db.commit()
            return result

    def files(self, prefix):
        with closing(self.connect()) as db:
            rows = db.execute("""SELECT name, revision, length(value) FROM resources
                WHERE kind='file' AND value IS NOT NULL AND substr(name,1,length(?))=?
                ORDER BY name""", (prefix, prefix)).fetchall()
            return [{'path': name, 'etag': etag(rev), 'size': size, 'modified': rev}
                    for name, rev, size in rows]


def backup_database(data_dir, app, retain=7):
    """Publish a consistent standalone snapshot; never copy live WAL files."""
    if type(retain) is not int or retain < 1:
        raise ValueError("retain must be at least 1")
    source = data_path(data_dir, app)
    data_dir = source.parent
    if data_dir.is_symlink() or not stat.S_ISREG(source.lstat().st_mode):
        raise ValueError("backup source must be a regular database")
    directory = data_dir / "backups"
    if directory.is_symlink():
        raise ValueError("backup directory must not be a symlink")
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(directory_fd, fcntl.LOCK_EX)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        name = app + "-backup-" + stamp + "-" + uuid.uuid4().hex + ".sqlite3"
        snapshot = directory / name
        temporary = directory / ("." + name + ".partial")
        fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as origin:
                with closing(sqlite3.connect(temporary)) as target:
                    origin.backup(target)
                    target.execute("PRAGMA journal_mode=DELETE")
                    target.execute("PRAGMA synchronous=FULL")
                    if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                        raise sqlite3.DatabaseError("Backup integrity check failed")
            os.fsync(fd)
            os.link(temporary, snapshot, follow_symlinks=False)
        finally:
            os.close(fd)
            temporary.unlink()
        os.fsync(directory_fd)
        pattern = re.compile(re.escape(app) + r"-backup-[0-9]{8}T[0-9]{12}Z-[0-9a-f]{32}\.sqlite3")
        older = []
        for candidate in directory.iterdir():
            if candidate == snapshot or not pattern.fullmatch(candidate.name):
                continue
            info = candidate.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                older.append(candidate)
        for candidate in sorted(older, reverse=True)[retain - 1:]:
            candidate.unlink()
        os.fsync(directory_fd)
        return snapshot
    finally:
        os.close(directory_fd)


@dataclass(frozen=True)
class Config:
    app: str
    dist: Path
    data_dir: Path
    origin: str
    allowed_login_file: Path
    host: str = '127.0.0.1'
    port: int = 0


class Handler(SimpleHTTPRequestHandler):
    server: "PrivateServer"
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(args[2].config.dist), **kwargs)

    def setup(self):
        super().setup()
        self.connection.settimeout(self.server.request_timeout)

    def parse_request(self):
        if not super().parse_request():
            return False
        if (self.headers.get_all('Host', []) != [urlsplit(self.server.config.origin).netloc]
                or self.headers.get_all('Tailscale-User-Login', []) != [self.server.owner]):
            self.json_response(403, {'error': 'Forbidden.'})
            return False
        try:
            # BaseHTTPRequestHandler normalizes a leading //; inspect the original target.
            original_target = self.requestline.split()[1]
            self.route, self.query = parse_target(original_target)
        except (ValueError, UnicodeError):
            self.json_response(400, {'error': 'Invalid URL.'})
            return False
        origins = self.headers.get_all('Origin', [])
        sites = self.headers.get_all('Sec-Fetch-Site', [])
        if ((origins and origins != [self.server.config.origin])
                or ((self.route == '/api' or self.route.startswith('/api/'))
                    and sites and sites not in (['same-origin'], ['none']))):
            self.json_response(403, {'error': 'Forbidden.'})
            return False
        requests = self.headers.get_all('X-Everything-Request', [])
        if len(requests) > 1:
            self.json_response(403, {'error': 'Forbidden.'})
            return False
        names = [name.lower() for name in self.headers.keys()]
        if (len(names) != len(set(names)) or self.headers.defects
                or any('\r' in value or '\n' in value for value in self.headers.values())):
            self.json_response(400, {'error': 'Ambiguous request headers.'})
            return False
        lengths = self.headers.get_all('Content-Length', [])
        if (self.headers.get_all('Transfer-Encoding') or len(lengths) > 1
                or (lengths and not re.fullmatch(r'[0-9]+', lengths[0]))
                or (self.command not in ('PUT', 'POST') and lengths and lengths[0].strip('0'))
                or len(self.headers.get_all('Content-Type', [])) > 1):
            self.json_response(400, {'error': 'Invalid request body framing.'})
            return False
        return True

    def read_body(self, limit=METADATA_LIMIT):
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1:
            raise RequestError(400, 'Content-Length is required.')
        if len(lengths[0]) > 12 or int(lengths[0]) > limit:
            raise RequestError(413, 'Request body is too large.')
        length = int(lengths[0])
        try:
            body = self.rfile.read(length)
        except TimeoutError:
            raise RequestError(408, 'Request body timed out.') from None
        if len(body) != length:
            raise RequestError(400, 'Incomplete request body.')
        return body

    def read_json(self):
        if (len(self.headers.get_all('Content-Type', [])) != 1
                or self.headers.get_content_type() != 'application/json'):
            raise RequestError(415, 'Content-Type must be application/json.')
        try:
            return load_json(self.read_body().decode('utf-8'))
        except UnicodeError:
            raise RequestError(400, 'Invalid UTF-8 JSON.') from None

    def read_kv(self):
        body = self.read_json()
        if not isinstance(body, dict) or set(body) != {'value'}:
            raise RequestError(400, 'Expected only a value field.')
        return kv_bytes(body['value'])

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.close_connection = True
        super().end_headers()

    def json_response(self, status, value, revision=None):
        self.response(status, json.dumps(value).encode('utf-8'), 'application/json; charset=utf-8', revision)

    def response(self, status, body, content_type, revision=None, disposition=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        if disposition:
            self.send_header('Content-Disposition', disposition)
        self.send_header('Content-Length', str(len(body)))
        if revision is not None:
            self.send_header('ETag', '"{}"'.format(revision))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_head(self):
        if not (self.route == '/sw.js' and self.query == {'private': '1'}):
            require_query(self.query, ())
        parts = self.route.split('/')[1:]
        trailing_slash = parts[-1] == ''
        if trailing_slash:
            parts.pop()
        if (any(not p or p.startswith('.') for p in parts) or '\\' in self.route
                or any(unicodedata.category(c).startswith('C') for c in self.route)):
            raise RequestError(403, 'Forbidden path.')
        fd = None
        try:
            fd = os.dup(self.server.dist_fd)
            for part in parts:
                next_fd = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            info = os.fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                next_fd = os.open('index.html', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                os.close(fd)
                fd = next_fd
                parts.append('index.html')
                info = os.fstat(fd)
            elif trailing_slash:
                raise RequestError(404, 'Not found.')
            if not stat.S_ISREG(info.st_mode):
                raise RequestError(404, 'Not found.')
            file = os.fdopen(fd, 'rb')
            fd = None
        except OSError:
            raise RequestError(404, 'Not found.') from None
        finally:
            if fd is not None:
                os.close(fd)
        try:
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(parts[-1]))
            self.send_header('Content-Length', str(info.st_size))
            self.end_headers()
            return file
        except Exception:
            file.close()
            raise

    def dispatch(self):
        try:
            expected = None
            if self.command not in ('GET', 'HEAD', 'OPTIONS'):
                if (self.headers.get_all('Origin', []) != [self.server.config.origin]
                        or self.headers.get_all('X-Everything-Request', []) != ['1']):
                    raise RequestError(403, 'Forbidden.')
                matches = self.headers.get_all('If-Match', [])
                if self.route != '/api/transaction':
                    if not matches:
                        raise RequestError(428, 'If-Match is required.')
                    if len(matches) != 1:
                        raise RequestError(400, 'Ambiguous If-Match.')
                    expected = validate_match(matches[0])
            if self.route == '/api/session':
                require_query(self.query, ())
                if self.command not in ('GET', 'HEAD'):
                    raise RequestError(405, 'Method not allowed.')
                self.json_response(200, {'username': 'Jetson storage', 'uuid': 'jetson-owner',
                                         'storage': 'jetson', 'app': self.server.config.app})
            elif self.route == '/api/kv':
                require_query(self.query, ('key',))
                key = self.query['key']
                if not policies.valid_key(self.server.config.app, key):
                    raise RequestError(400, 'Invalid key.')
                if self.command in ('GET', 'HEAD'):
                    value, revision = self.server.store.get('kv', key)
                    self.json_response(200, {'value': value.decode('utf-8') if value is not None else None}, revision)
                elif self.command in ('PUT', 'DELETE'):
                    value = self.read_kv() if self.command == 'PUT' else None
                    revision = self.server.store.put('kv', key, value, expected)
                    self.json_response(200, {'ok': True}, revision)
                else:
                    raise RequestError(405, 'Method not allowed.')
            elif self.route == '/api/file':
                require_query(self.query, ('path',), ('stat',) if self.command in ('GET', 'HEAD') else ())
                path = self.query['path']
                if (not policies.valid_file(self.server.config.app, path)
                        or ('stat' in self.query and self.query['stat'] != '1')):
                    raise RequestError(400, 'Invalid file path or stat.')
                if self.command in ('GET', 'HEAD'):
                    value, revision = self.server.store.get('file', path)
                    if value is None:
                        raise RequestError(404, 'File not found.', 'ENOENT', revision)
                    if self.query.get('stat') == '1':
                        self.json_response(200, {'path': path, 'size': len(value), 'modified': revision}, revision)
                    else:
                        self.response(200, value, 'application/octet-stream', revision,
                                      "attachment; filename*=UTF-8''" + quote(path.rsplit('/', 1)[-1], safe=''))
                elif self.command in ('PUT', 'DELETE'):
                    limit = RECEIPT_LIMIT if self.server.config.app == 'expense' and policies.RECEIPT.fullmatch(path) else FILE_LIMIT
                    value = self.read_body(limit) if self.command == 'PUT' else None
                    revision = self.server.store.put('file', path, value, expected)
                    self.json_response(200, {'ok': True}, revision)
                else:
                    raise RequestError(405, 'Method not allowed.')
            elif self.route == '/api/files':
                require_query(self.query, ('prefix',))
                if not policies.valid_prefix(self.server.config.app, self.query['prefix']):
                    raise RequestError(400, 'Invalid listing prefix.')
                if self.command not in ('GET', 'HEAD'):
                    raise RequestError(405, 'Method not allowed.')
                self.json_response(200, {'files': self.server.store.files(self.query['prefix'])})
            elif self.route == '/api/transaction':
                require_query(self.query, ())
                if self.command != 'POST':
                    raise RequestError(405, 'Method not allowed.')
                if self.headers.get_all('If-Match'):
                    raise RequestError(400, 'Transaction uses operation preconditions, not global If-Match.')
                body = self.read_json()
                operations = validate_transaction(self.server.config.app, body)
                canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
                fingerprint = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
                self.json_response(200, self.server.store.transaction(operations, body['idempotencyKey'], fingerprint))
            elif self.route == '/api' or self.route.startswith('/api/'):
                raise RequestError(404, 'Not found.')
            elif self.command == 'HEAD':
                super().do_HEAD()
            elif self.command == 'GET':
                super().do_GET()
            else:
                raise RequestError(405, 'Method not allowed.')
        except RequestError as error:
            body = {'error': str(error)}
            if error.code:
                body['code'] = error.code
            self.json_response(error.status, body, error.revision)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except (sqlite3.Error, OSError):
            self.json_response(500, {'error': 'Storage unavailable.', 'code': 'STORAGE_ERROR'})

    do_GET = dispatch
    do_HEAD = dispatch
    do_PUT = dispatch
    do_DELETE = dispatch
    do_POST = dispatch
    do_OPTIONS = dispatch
    do_PATCH = dispatch

    def log_message(self, format, *args):
        pass  # Never log request paths, bodies, or identities.


class PrivateServer(ThreadingHTTPServer):
    request_timeout = 30
    def __init__(self, config, owner):
        self.config, self.owner = config, owner
        self.dist_fd = os.open(config.dist, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self.store = SQLiteStore(config.data_dir, config.app)
            self.address_family = socket.AF_INET6 if ':' in config.host else socket.AF_INET
            super().__init__((config.host, config.port), Handler)
        except Exception:
            if self.dist_fd is not None:
                os.close(self.dist_fd)
                self.dist_fd = None
            raise

    def server_close(self):
        try:
            super().server_close()
        finally:
            if self.dist_fd is not None:
                os.close(self.dist_fd)
                self.dist_fd = None


def create_server(config):
    if not ipaddress.ip_address(config.host).is_loopback:
        raise ValueError('Host must be a loopback IP address.')
    data_path(config.data_dir, config.app)
    dist = no_symlink_components(config.dist)
    if not dist.is_absolute() or dist.name != 'dist-private' or not dist.is_dir():
        raise ValueError('Dist must be an absolute dist-private build directory.')
    dist = dist.resolve(strict=True)
    data = Path(config.data_dir).resolve()
    if (data.is_relative_to(dist) or dist.is_relative_to(data)
            or Path(config.allowed_login_file).resolve().is_relative_to(dist)):
        raise ValueError('Data and owner configuration must be outside dist; dist must not be inside data.')
    origin = urlsplit(config.origin)
    try:
        local_http = origin.scheme == 'http' and ipaddress.ip_address(origin.hostname).is_loopback
    except ValueError:
        local_http = False
    if ((origin.scheme != 'https' and not local_http) or not origin.hostname or origin.username
            or origin.password or origin.path or origin.query or origin.fragment
            or any(c.isspace() or ord(c) < 32 for c in config.origin)
            or '?' in config.origin or '#' in config.origin):
        raise ValueError('Origin must be exact HTTPS, or loopback HTTP, without a path.')
    origin.port
    owner = Path(config.allowed_login_file).read_text(encoding='utf-8').rstrip('\r\n')
    if not owner or any(c.isspace() or ord(c) < 32 for c in owner):
        raise ValueError('Owner file must contain one nonempty login.')
    return PrivateServer(config, owner)


def main(argv=None):
    import argparse
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', choices=tuple(policies.KV_KEYS), required=True)
    parser.add_argument('--host', default='127.0.0.1', help='loopback IP only')
    parser.add_argument('--port', type=int)
    parser.add_argument('--dist', type=Path)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--origin')
    parser.add_argument('--allowed-login-file', type=Path)
    parser.add_argument('--backup', action='store_true')
    parser.add_argument('--retain', type=int, default=7)
    args = parser.parse_args(argv)
    if not args.backup and any(getattr(args, field) is None for field in ('port', 'dist', 'origin', 'allowed_login_file')):
        parser.error('--port, --dist, --origin, and --allowed-login-file are required for serving')
    try:
        if args.backup:
            print(backup_database(args.data_dir, args.app, args.retain))
            return 0
        config = Config(app=args.app, host=args.host, port=args.port, dist=args.dist,
                        data_dir=args.data_dir, origin=args.origin, allowed_login_file=args.allowed_login_file)
        with create_server(config) as server:
            print('Listening on {}:{}'.format(args.host, server.server_port), flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
        return 0
    except (ValueError, OSError, sqlite3.Error):
        print('Unable to start storage or complete backup. Check configuration, permissions, and database.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
