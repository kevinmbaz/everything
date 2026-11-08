"""Private Invoicing HTTP storage (Python 3.10+, standard library only).

Trust boundary: bind only to loopback behind Tailscale Serve, which supplies
Tailscale-User-Login. Local processes are trusted; this header is not a secret.
All resource mutations compare quoted If-Match revisions atomically in SQLite.
"""
import argparse
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import stat
import sys
import unicodedata
import uuid
from urllib.parse import parse_qsl, quote, unquote, urlsplit

KV_KEYS = frozenset("invc:" + name + ":v1" for name in (
    "settings", "clients", "items", "recurring", "years",
))
YEAR_PATH = re.compile(r"invoicing-data/docs-[0-9]{4}\.json")
ATTACH_PREFIX = re.compile(r"invoicing-data/attachments/[A-Za-z0-9]{1,40}/")
METADATA_LIMIT = 8 * 1024 * 1024
FILE_LIMIT = 32 * 1024 * 1024
CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self' data:; connect-src 'self'; object-src 'none'; "
       "frame-ancestors 'none'; base-uri 'self'")


class RequestError(Exception):
    def __init__(self, status, message, code=None, revision=None):
        super().__init__(message)
        self.status, self.code, self.revision = status, code, revision


def etag(revision):
    return '"{}"'.format(revision)


def valid_file(path):
    if YEAR_PATH.fullmatch(path):
        return True
    folder, _, filename = path.rpartition("/")
    return bool(ATTACH_PREFIX.fullmatch(folder + "/") and filename
                and not filename.startswith(".") and "\\" not in filename
                and not any(unicodedata.category(c).startswith("C") for c in filename))


def parse_target(target):
    if (not target.startswith("/") or target.startswith("//")
            or any(ord(c) < 32 or ord(c) == 127 for c in target)
            or re.search(r"%(?![0-9a-fA-F]{2})", target)):
        raise ValueError("Invalid URL")
    route = urlsplit(target)
    if route.scheme or route.netloc or route.fragment or "#" in target:
        raise ValueError("Invalid URL")
    path = unquote(route.path, encoding="utf-8", errors="strict")
    pairs = parse_qsl(route.query, keep_blank_values=True, strict_parsing=True,
                      encoding="utf-8", errors="strict", max_num_fields=8) if route.query else []
    query = dict(pairs)
    if len(query) != len(pairs):
        raise ValueError("Duplicate parameters")
    return path, query


def require_query(query, required, optional=()):
    if not set(required) <= query.keys() or query.keys() - set(required) - set(optional):
        raise RequestError(400, "Invalid query parameters.")


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON fields")
    return result


class SQLiteStore:
    """One connection per operation; compare-and-write is one SQLite transaction."""
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).absolute()
        if self.data_dir.is_symlink():
            raise ValueError("data directory must not be a symlink")
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.data_dir.chmod(0o700)
        self.db_path = self.data_dir / "invoicing.sqlite3"
        fd = os.open(self.db_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        with closing(self.connect()) as db:
            if db.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
                raise sqlite3.OperationalError("WAL mode unavailable")
            db.execute("""CREATE TABLE IF NOT EXISTS resources (
                kind TEXT NOT NULL, name TEXT NOT NULL, value BLOB,
                revision INTEGER NOT NULL CHECK(revision > 0),
                PRIMARY KEY(kind, name)
            )""")

    def connect(self):
        db = sqlite3.connect(self.db_path.as_uri() + "?mode=rw", uri=True,
                             timeout=10, isolation_level=None)
        try:
            db.execute("PRAGMA synchronous=FULL")
            return db
        except Exception:
            db.close()
            raise

    def get(self, kind, name):
        with closing(self.connect()) as db:
            row = db.execute("SELECT value, revision FROM resources WHERE kind=? AND name=?",
                             (kind, name)).fetchone()
            return row if row is not None else (None, 0)

    def put(self, kind, name, value, expected):
        with closing(self.connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT revision FROM resources WHERE kind=? AND name=?",
                             (kind, name)).fetchone()
            revision = row[0] if row is not None else 0
            if expected != etag(revision):
                raise RequestError(409, "Changed on another device. Reload before saving.",
                                   "CONFLICT", revision)
            revision += 1
            db.execute("""INSERT INTO resources(kind, name, value, revision) VALUES (?, ?, ?, ?)
                ON CONFLICT(kind, name) DO UPDATE SET value=excluded.value, revision=excluded.revision
                """, (kind, name, value, revision))
            db.commit()
            return revision


    def files(self, prefix):
        with closing(self.connect()) as db:
            rows = db.execute("""SELECT name, revision FROM resources
                WHERE kind='file' AND value IS NOT NULL AND substr(name, 1, length(?))=?
                ORDER BY name""", (prefix, prefix)).fetchall()
            return [{"path": name, "etag": etag(revision)} for name, revision in rows]


def backup_database(data_dir, retain=7):
    """Return a consistent, standalone snapshot in data_dir/backups.

    Only completed, regularly named snapshots participate in retention. A
    directory lock serializes backup jobs; link publishes without overwriting.
    Restore with the server stopped by copying a snapshot into a fresh data
    directory as invoicing.sqlite3 (never mix it with an older WAL/SHM pair).
    """
    if not isinstance(retain, int) or retain < 1:
        raise ValueError("retain must be at least 1")
    data_dir = Path(data_dir).absolute()
    source = data_dir / "invoicing.sqlite3"
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
        name = "invoicing-backup-" + stamp + "-" + uuid.uuid4().hex + ".sqlite3"
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
        pattern = re.compile(r"invoicing-backup-[0-9]{8}T[0-9]{12}Z-[0-9a-f]{32}\.sqlite3")
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
    dist: Path
    data_dir: Path
    origin: str
    allowed_login_file: Path
    host: str = "127.0.0.1"
    port: int = 18723


class Handler(SimpleHTTPRequestHandler):
    server: "PrivateServer"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def parse_request(self):
        if not super().parse_request():
            return False
        config = self.server.config
        if (self.headers.get_all("Host", []) != [urlsplit(config.origin).netloc]
                or self.headers.get_all("Tailscale-User-Login", []) != [self.server.owner]):
            self.json_response(403, {"error": "Forbidden."})
            return False
        try:
            self.route, self.query = parse_target(self.path)
        except (ValueError, UnicodeError):
            self.json_response(400, {"error": "Invalid URL."})
            return False
        if self.route == "/api" or self.route.startswith("/api/"):
            origins = self.headers.get_all("Origin", [])
            sites = self.headers.get_all("Sec-Fetch-Site", [])
            if ((origins and origins != [config.origin])
                    or (sites and sites not in (["same-origin"], ["none"]))):
                self.json_response(403, {"error": "Forbidden."})
                return False
        lengths = self.headers.get_all("Content-Length", [])
        if (self.headers.get_all("Transfer-Encoding") or len(lengths) > 1
                or (lengths and not re.fullmatch(r"[0-9]+", lengths[0]))
                or (self.command != "PUT" and lengths and lengths[0].strip("0"))):
            self.json_response(400, {"error": "Invalid request body framing."})
            return False
        return True

    def read_body(self, limit):
        lengths = self.headers.get_all("Content-Length", [])
        if (self.headers.get_all("Transfer-Encoding") or len(lengths) != 1
                or not re.fullmatch(r"[0-9]+", lengths[0])):
            raise RequestError(400, "A single Content-Length is required; chunked bodies are not supported.")
        if len(lengths[0]) > 12 or int(lengths[0]) > limit:
            raise RequestError(413, "Request body is too large.")
        length = int(lengths[0])
        try:
            body = self.rfile.read(length)
        except TimeoutError:
            raise RequestError(408, "Request body timed out.") from None
        if len(body) != length:
            raise RequestError(400, "Incomplete request body.")
        return body

    def read_kv(self):
        if (len(self.headers.get_all("Content-Type", [])) != 1
                or self.headers.get_content_type() != "application/json"):
            raise RequestError(415, "Content-Type must be application/json.")
        body = self.read_body(METADATA_LIMIT)
        try:
            value = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object)
            if not isinstance(value, dict) or set(value) != {"value"} or not isinstance(value["value"], str):
                raise ValueError("Expected a string value")
            return value["value"].encode("utf-8")
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError(400, "Expected JSON containing only a string value.") from None

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.close_connection = True
        super().end_headers()

    def send_head(self):
        """Open relative to dist, refusing every symlink, even an index symlink.

        Walking directory descriptors avoids the resolve/check/open race in
        SimpleHTTPRequestHandler; the inherited copyfile still streams assets.
        """
        require_query(self.query, ())
        parts = self.route.split("/")[1:]
        trailing_slash = parts[-1] == ""
        if trailing_slash:
            parts.pop()
        if (any(not part or part.startswith(".") for part in parts)
                or "\\" in self.route
                or any(unicodedata.category(c).startswith("C") for c in self.route)):
            raise RequestError(403, "Forbidden path.")
        fd = None
        try:
            fd = os.open(self.server.dist, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            for part in parts:
                next_fd = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            info = os.fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                next_fd = os.open("index.html", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                os.close(fd)
                fd = next_fd
                parts.append("index.html")
                info = os.fstat(fd)
            elif trailing_slash:
                raise RequestError(404, "Not found.")
            if not stat.S_ISREG(info.st_mode):
                raise RequestError(404, "Not found.")
            file = os.fdopen(fd, "rb")
            fd = None
        except OSError:
            raise RequestError(404, "Not found.") from None
        finally:
            if fd is not None:
                os.close(fd)
        try:
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(parts[-1]))
            self.send_header("Content-Length", str(info.st_size))
            self.end_headers()
            return file
        except Exception:
            file.close()
            raise

    def response(self, status, body, content_type, revision=None, disposition=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if revision is not None:
            self.send_header("ETag", etag(revision))
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json_response(self, status, value, revision=None):
        self.response(status, json.dumps(value).encode("utf-8"),
                      "application/json; charset=utf-8", revision)

    def dispatch(self):
        try:
            route, query = self.route, self.query
            expected = None
            if self.command not in ("GET", "HEAD", "OPTIONS"):
                if (self.headers.get_all("Origin", []) != [self.server.config.origin]
                        or self.headers.get_all("X-Invoicing-Request", []) != ["1"]):
                    raise RequestError(403, "Forbidden.")
                matches = self.headers.get_all("If-Match", [])
                if not matches:
                    raise RequestError(428, "If-Match is required.")
                if len(matches) != 1 or not re.fullmatch(r'"(0|[1-9][0-9]{0,18})"', matches[0]):
                    raise RequestError(400, "Invalid If-Match revision.")
                expected = matches[0]
            if route == "/api/session":
                require_query(query, ())
                if self.command not in ("GET", "HEAD"):
                    raise RequestError(405, "Method not allowed.")
                self.json_response(200, {"username": "Jetson storage", "storage": "jetson"})
            elif route == "/api/kv":
                require_query(query, ("key",))
                key = query["key"]
                if key not in KV_KEYS:
                    raise RequestError(400, "Invalid key.")
                if self.command in ("GET", "HEAD"):
                    value, revision = self.server.store.get("kv", key)
                    self.json_response(200, {"value": value.decode("utf-8") if value is not None else None}, revision)
                elif self.command == "PUT":
                    revision = self.server.store.put("kv", key, self.read_kv(), expected)
                    self.json_response(200, {"ok": True}, revision)
                else:
                    raise RequestError(405, "Method not allowed.")
            elif route == "/api/file":
                require_query(query, ("path",), ("stat",) if self.command in ("GET", "HEAD") else ())
                path = query["path"]
                if not valid_file(path) or ("stat" in query and query["stat"] != "1"):
                    raise RequestError(400, "Invalid file path or stat parameter.")
                if self.command in ("GET", "HEAD"):
                    value, revision = self.server.store.get("file", path)
                    if value is None:
                        raise RequestError(404, "File not found.", "ENOENT", revision)
                    if query.get("stat") == "1":
                        self.json_response(200, {"path": path, "size": len(value)}, revision)
                    else:
                        self.response(200, value, "application/octet-stream", revision,
                                      "attachment; filename*=UTF-8''" + quote(path.rsplit("/", 1)[-1], safe=""))
                elif self.command in ("PUT", "DELETE"):
                    limit = METADATA_LIMIT if YEAR_PATH.fullmatch(path) else FILE_LIMIT
                    value = self.read_body(limit) if self.command == "PUT" else None
                    revision = self.server.store.put("file", path, value, expected)
                    self.json_response(200, {"ok": True}, revision)
                else:
                    raise RequestError(405, "Method not allowed.")
            elif route == "/api/files":
                require_query(query, ("prefix",))
                if not ATTACH_PREFIX.fullmatch(query["prefix"]):
                    raise RequestError(400, "Invalid attachment folder.")
                if self.command not in ("GET", "HEAD"):
                    raise RequestError(405, "Method not allowed.")
                self.json_response(200, {"files": self.server.store.files(query["prefix"])})
            elif route == "/api" or route.startswith("/api/"):
                raise RequestError(404, "Not found.")
            elif self.command == "GET":
                super().do_GET()
            elif self.command == "HEAD":
                super().do_HEAD()
            else:
                raise RequestError(405, "Method not allowed.")
        except RequestError as error:
            body = {"error": str(error)}
            if error.code:
                body["code"] = error.code
            self.json_response(error.status, body, error.revision)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except (sqlite3.Error, OSError):
            self.json_response(500, {"error": "Storage unavailable.", "code": "STORAGE_ERROR"})

    do_GET = dispatch
    do_HEAD = dispatch
    do_PUT = dispatch
    do_DELETE = dispatch

    def log_message(self, format, *args):
        # Never log paths, invoices, forwarded identities, or request headers.
        pass


class PrivateServer(ThreadingHTTPServer):
    def __init__(self, config, owner):
        self.config = config
        self.owner = owner
        self.dist = Path(config.dist).resolve(strict=True)
        if not self.dist.is_dir():
            raise ValueError("dist must be a directory")
        self.store = SQLiteStore(config.data_dir)
        self.address_family = socket.AF_INET6 if ":" in config.host else socket.AF_INET
        super().__init__((config.host, config.port), Handler)


def create_server(config):
    if not ipaddress.ip_address(config.host).is_loopback:
        raise ValueError("host must be a loopback IP address")
    dist = Path(config.dist).resolve(strict=True)
    if (Path(config.data_dir).resolve().is_relative_to(dist)
            or Path(config.allowed_login_file).resolve().is_relative_to(dist)):
        raise ValueError("data directory and allowed-login-file must be outside dist")
    origin = urlsplit(config.origin)
    try:
        local_http = origin.scheme == "http" and ipaddress.ip_address(origin.hostname).is_loopback
    except ValueError:
        local_http = False
    if ((origin.scheme != "https" and not local_http) or not origin.hostname or origin.username
            or origin.password or origin.path or origin.query or origin.fragment
            or any(c.isspace() or ord(c) < 32 for c in config.origin)
            or "?" in config.origin or "#" in config.origin):
        raise ValueError("origin must be exact HTTPS, or explicit loopback HTTP, without a path")
    origin.port  # Validate an explicitly supplied port.
    owner = Path(config.allowed_login_file).read_text(encoding="utf-8").rstrip("\r\n")
    if not owner or any(c.isspace() or ord(c) < 32 for c in owner):
        raise ValueError("allowed-login-file must contain one nonempty login")
    return PrivateServer(config, owner)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="loopback IP only (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=18723, help="backend port (default: 18723)")
    parser.add_argument("--dist", type=Path, default=Path(__file__).resolve().parent / "dist",
                        help="built static assets directory (default: adjacent dist)")
    parser.add_argument("--data-dir", type=Path, required=True, help="private SQLite storage directory")
    parser.add_argument("--origin", default="https://jetson-energy.tail274ca7.ts.net:18923",
                        help="exact HTTPS origin; explicit loopback HTTP is also allowed")
    parser.add_argument("--allowed-login-file", type=Path,
                        help="file containing the sole allowed Tailscale login; required for serving")
    parser.add_argument("--backup", action="store_true", help="make a consistent snapshot and exit; no listener")
    parser.add_argument("--retain", type=int, default=7, help="keep this many named snapshots (default: 7)")
    args = parser.parse_args(argv)
    if not args.backup and args.allowed_login_file is None:
        parser.error("--allowed-login-file is required for serving")
    try:
        if args.backup:
            print(backup_database(args.data_dir, retain=args.retain))
            return 0
        config = Config(dist=args.dist, data_dir=args.data_dir, origin=args.origin,
                        allowed_login_file=args.allowed_login_file, host=args.host, port=args.port)
        with create_server(config) as server:
            print("Listening on {}:{}".format(config.host, server.server_port), flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
        return 0
    except (ValueError, OSError, sqlite3.Error):
        # No file contents, identities, request paths, or SQL details in logs.
        print("Unable to start storage or complete backup. Check configuration, permissions, and database.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
