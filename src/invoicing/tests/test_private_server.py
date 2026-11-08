"""Real loopback HTTP tests; all state and fake identities live under TMPDIR."""
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.parse import urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    import private_server as backend
except ModuleNotFoundError:
    backend = None

ORIGIN = "https://jetson-energy.tail274ca7.ts.net:18923"
OWNER = "private-storage-test@example.invalid"


class PrivateServerTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(backend, "private_server backend is not implemented")
        self.temp = tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"])
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dist = self.root / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<html>private app</html>", encoding="utf-8")
        self.login = self.root / "owner.txt"
        self.login.write_text(OWNER + "\n", encoding="utf-8")
        self.config = backend.Config(
            host="127.0.0.1", port=0, dist=self.dist,
            data_dir=self.root / "data", origin=ORIGIN,
            allowed_login_file=self.login,
        )
        self.server = self.start_server(self.config)

    def start_server(self, config):
        server = backend.create_server(config)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())

        self.addCleanup(stop)
        return server

    def request(self, method, path, body=None, headers=None, server=None):
        target = server or self.server
        connection = http.client.HTTPConnection("127.0.0.1", target.server_port, timeout=10)
        actual = {"Host": urlsplit(ORIGIN).netloc, "Tailscale-User-Login": OWNER}
        if headers:
            actual.update(headers)
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            if body is not None and "Content-Length" not in actual:
                actual["Content-Length"] = str(len(body))
            for name, value in actual.items():
                if value is not None:
                    connection.putheader(name, value)
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        except (TimeoutError, http.client.RemoteDisconnected) as error:
            self.fail("HTTP request did not return a response: " + str(error))
        finally:
            connection.close()

    def mutation(self, method, path, body=b"", revision='"0"', headers=None, server=None):
        actual = {"Origin": ORIGIN, "X-Invoicing-Request": "1", "If-Match": revision}
        if headers:
            actual.update(headers)
        return self.request(method, path, body, actual, server)

    def test_every_method_requires_exact_owner_and_host(self):
        invalid = [
            {"Tailscale-User-Login": None}, {"Tailscale-User-Login": "other@example.invalid"},
            {"Tailscale-User-Login": OWNER.upper()}, {"Host": None},
            {"Host": "localhost"}, {"Host": urlsplit(ORIGIN).netloc + ".evil"},
            {"Tailscale-User-Login": None, "X-Forwarded-User": OWNER},
        ]
        for method in ("GET", "HEAD", "PUT", "DELETE", "OPTIONS", "POST", "TRACE", "MYSTERY"):
            for headers in invalid:
                with self.subTest(method=method, headers=headers):
                    status, _, _ = self.request(method, "/api/session", headers=headers)
                    self.assertEqual(status, 403)
        self.assertEqual(self.request("GET", "/", headers={"Tailscale-User-Login": None})[0], 403)

    def test_api_reads_reject_cross_origin_requests(self):
        for headers in (
            {"Origin": "https://evil.invalid"}, {"Origin": "null"},
            {"Origin": ORIGIN + "/"}, {"Sec-Fetch-Site": "same-site"},
            {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": ""},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("GET", "/api/session", headers=headers)[0], 403)
        for site in ("same-origin", "none"):
            self.assertEqual(self.request("GET", "/api/session", headers={
                "Origin": ORIGIN, "Sec-Fetch-Site": site,
            })[0], 200)

    def test_config_fails_closed(self):
        from dataclasses import replace
        for changes in (
            {"host": "0.0.0.0"}, {"host": "192.0.2.1"}, {"host": "::"},
            {"host": "localhost"}, {"origin": "http://private.invalid"},
            {"origin": ORIGIN + "/"}, {"origin": ORIGIN + "?query=x"},
            {"origin": "https://user:password@private.invalid"},
        ):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    with backend.create_server(replace(self.config, **changes)):
                        pass
        self.login.write_text("\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            with backend.create_server(self.config):
                pass

    def test_kv_strings_persist_with_conditional_revisions(self):
        for name in ("settings", "clients", "items", "recurring", "years"):
            route = "/api/kv?" + urlencode({"key": "invc:" + name + ":v1"})
            with self.subTest(name=name):
                status, headers, body = self.request("GET", route)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), {"value": None})
                self.assertEqual(headers.get("ETag"), '"0"')
                value = 'Unicode € / ' + name + ' / "quoted"\n'
                payload = json.dumps({"value": value}).encode()
                status, headers, body = self.mutation("PUT", route, payload,
                    headers={"Content-Type": "application/json"})
                self.assertEqual((status, json.loads(body)), (200, {"ok": True}))
                self.assertEqual(headers.get("ETag"), '"1"')
                status, _, body = self.mutation("PUT", route, payload,
                    headers={"Content-Type": "application/json"})
                self.assertEqual(status, 409)
                self.assertEqual(json.loads(body), {
                    "error": "Changed on another device. Reload before saving.", "code": "CONFLICT",
                })
        self.server.shutdown()
        self.server.server_close()
        reopened = self.start_server(self.config)
        for name in ("settings", "clients", "items", "recurring", "years"):
            route = "/api/kv?" + urlencode({"key": "invc:" + name + ":v1"})
            status, headers, body = self.request("GET", route, server=reopened)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"value": 'Unicode € / ' + name + ' / "quoted"\n'})
            self.assertEqual(headers.get("ETag"), '"1"')
            status, headers, _ = self.mutation("PUT", route, b'{"value":""}', revision='"1"',
                headers={"Content-Type": "application/json"}, server=reopened)
            self.assertEqual((status, headers.get("ETag")), (200, '"2"'))
            self.assertEqual(json.loads(self.request("GET", route, server=reopened)[2]), {"value": ""})

    def test_sqlite_is_durable_and_private(self):
        import sqlite3
        import stat
        self.assertTrue((self.config.data_dir / "invoicing.sqlite3").is_file())
        self.assertEqual(stat.S_IMODE(self.config.data_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.server.store.db_path.stat().st_mode), 0o600)
        connection = self.server.store.connect()
        self.addCleanup(connection.close)
        self.assertIsInstance(connection, sqlite3.Connection)
        self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        self.assertEqual(connection.execute("PRAGMA synchronous").fetchone()[0], 2)

    def test_mutations_require_explicit_csrf_and_revision_headers(self):
        route = "/api/kv?key=invc:settings:v1"
        for headers, expected in (
            ({"Origin": None}, 403), ({"Origin": "https://evil.invalid"}, 403),
            ({"Origin": "null"}, 403), ({"X-Invoicing-Request": None}, 403),
            ({"X-Invoicing-Request": "true"}, 403), ({"Sec-Fetch-Site": "cross-site"}, 403),
            ({"If-Match": None}, 428), ({"If-Match": "0"}, 400),
            ({"If-Match": "*"}, 400), ({"If-Match": 'W/"0"'}, 400),
            ({"If-Match": '"0", "1"'}, 400), ({"If-Match": '"00"'}, 400),
            ({"If-Match": '"-1"'}, 400),
        ):
            with self.subTest(headers=headers):
                status, _, _ = self.mutation("PUT", route, b'{"value":"unauthorized"}',
                    headers={"Content-Type": "application/json", **headers})
                self.assertEqual(status, expected)
                self.assertEqual(self.request("GET", route)[1].get("ETag"), '"0"')
        self.assertEqual(self.mutation("PUT", route, b'{"value":"ok"}', headers={
            "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin",
        })[0], 200)

    def test_files_preserve_binary_bytes_stat_and_deleted_revisions(self):
        paths = ["invoicing-data/docs-2026.json", "invoicing-data/attachments/Ab09/reçu € 1.bin"]
        for path in paths:
            with self.subTest(path=path):
                route = "/api/file?" + urlencode({"path": path})
                for suffix in ("", "&stat=1"):
                    status, headers, body = self.request("GET", route + suffix)
                    self.assertEqual(status, 404)
                    self.assertEqual(json.loads(body).get("code"), "ENOENT")
                    self.assertIn("not found", json.loads(body)["error"].lower())
                    self.assertEqual(headers.get("ETag"), '"0"')
                data = bytes(range(256)) + b"\x00\xff\n"
                status, headers, body = self.mutation("PUT", route, data)
                self.assertEqual((status, json.loads(body)), (200, {"ok": True}))
                self.assertEqual(headers.get("ETag"), '"1"')
                reopened = self.start_server(self.config)
                status, headers, body = self.request("GET", route, server=reopened)
                self.assertEqual((status, body), (200, data))
                self.assertEqual(headers.get("ETag"), '"1"')
                self.assertEqual(headers.get("Content-Type"), "application/octet-stream")
                self.assertTrue(headers.get("Content-Disposition", "").startswith("attachment"))
                status, headers, body = self.request("GET", route + "&stat=1")
                self.assertEqual((status, json.loads(body)), (200, {"path": path, "size": len(data)}))
                self.assertEqual(headers.get("ETag"), '"1"')
                self.assertEqual(self.mutation("DELETE", route)[0], 409)
                status, headers, body = self.mutation("DELETE", route, revision='"1"')
                self.assertEqual((status, json.loads(body)), (200, {"ok": True}))
                self.assertEqual(headers.get("ETag"), '"2"')
                for suffix in ("", "&stat=1"):
                    status, headers, body = self.request("GET", route + suffix, server=reopened)
                    self.assertEqual((status, json.loads(body)["code"]), (404, "ENOENT"))
                    self.assertEqual(headers.get("ETag"), '"2"')
                for stale in ('"0"', '"1"'):
                    self.assertEqual(self.mutation("PUT", route, data, revision=stale)[0], 409)
                status, headers, _ = self.mutation("PUT", route, b"", revision='"2"')
                self.assertEqual((status, headers.get("ETag")), (200, '"3"'))
                self.assertEqual(self.request("GET", route)[2], b"")
                self.assertEqual(self.mutation("DELETE", route, revision='"1"')[0], 409)

    def test_attachment_listing_is_exact_and_excludes_tombstones(self):
        prefix = "invoicing-data/attachments/Doc1/"
        for path in (prefix + "z.txt", prefix + "a.txt", "invoicing-data/attachments/Doc11/b.txt",
                     "invoicing-data/docs-2026.json"):
            self.assertEqual(self.mutation("PUT", "/api/file?" + urlencode({"path": path}), b"x")[0], 200)
        route = "/api/files?" + urlencode({"prefix": prefix})
        status, _, body = self.request("GET", route)
        self.assertEqual((status, json.loads(body)), (200, {"files": [
            {"path": prefix + "a.txt", "etag": '"1"'}, {"path": prefix + "z.txt", "etag": '"1"'},
        ]}))
        self.assertEqual(self.mutation("DELETE", "/api/file?" + urlencode({"path": prefix + "a.txt"}),
            revision='"1"')[0], 200)
        self.assertEqual(json.loads(self.request("GET", route)[2]), {"files": [
            {"path": prefix + "z.txt", "etag": '"1"'},
        ]})
        self.assertEqual(json.loads(self.request("GET", "/api/files?" + urlencode({
            "prefix": "invoicing-data/attachments/Empty/",
        }))[2]), {"files": []})

    def test_api_validates_only_owned_resources_and_exact_query_shapes(self):
        invalid_keys = ("", "invc:other:v1", "invc:settings:v2", "INVC:settings:v1", "invc:settings:v1\x00")
        for key in invalid_keys:
            route = "/api/kv?" + urlencode({"key": key})
            self.assertEqual(self.request("GET", route)[0], 400)
            self.assertEqual(self.mutation("PUT", route, b'{"value":"x"}', headers={
                "Content-Type": "application/json",
            })[0], 400)
        invalid_paths = (
            "", "../owner.txt", "/invoicing-data/docs-2026.json", "invoicing-data/docs-26.json",
            "invoicing-data/docs-２０２６.json", "invoicing-data/docs-2026.json/extra",
            "invoicing-data/public/x.html", "invoicing-data/attachments/x/../outside",
            "invoicing-data/attachments/a-b/file", "invoicing-data/attachments/" + "x" * 41 + "/f",
            "invoicing-data/attachments/x/", "invoicing-data/attachments/x/.",
            "invoicing-data/attachments/x/..", "invoicing-data/attachments/x/.hidden",
            "invoicing-data/attachments/x/a/b", "invoicing-data/attachments/x/a\\b",
            "invoicing-data/attachments/x/a\x00b", "invoicing-data/attachments/x/a\x1fb",
            "invoicing-data/attachments/x/a\x7fb", "invoicing-data/attachments/x/a\x85b",
        )
        for path in invalid_paths:
            route = "/api/file?" + urlencode({"path": path})
            for method in ("GET", "PUT", "DELETE"):
                with self.subTest(path=path, method=method):
                    result = self.request(method, route) if method == "GET" else self.mutation(method, route, b"x")
                    self.assertEqual(result[0], 400)
        for prefix in ("", "invoicing-data/attachments/", "invoicing-data/attachments/x",
                       "invoicing-data/attachments/x/*", "invoicing-data/attachments/x/sub/",
                       "invoicing-data/attachments/x%/", "invoicing-data/attachments/../"):
            self.assertEqual(self.request("GET", "/api/files?" + urlencode({"prefix": prefix}))[0], 400)
        for route in (
            "/api/session?x=1", "/api/kv", "/api/kv?key=invc:settings:v1&key=invc:settings:v1",
            "/api/kv?key=invc:settings:v1&%6bey=invc:clients:v1", "/api/kv?key=invc:settings:v1&x=1",
            "/api/file", "/api/file?path=invoicing-data/docs-2026.json&stat=0",
            "/api/file?path=invoicing-data/docs-2026.json&stat=1&stat=1", "/api/files",
            "/api/kv?key=%ZZ", "/api/kv?key=%FF", "/api/session?x", "/api/session#bad",
            "https://evil.invalid/api/session",
        ):
            with self.subTest(route=route):
                self.assertEqual(self.request("GET", route)[0], 400)
        self.assertEqual(self.mutation("PUT", "/api/file?path=invoicing-data/docs-2026.json&stat=1", b"x")[0], 400)
        self.assertEqual(self.request("GET", "/api/not-an-endpoint")[0], 404)
        self.assertEqual(self.request("HEAD", "/api/not-an-endpoint")[0], 404)

    def test_url_components_are_decoded_once_without_auth_bypass(self):
        path = "invoicing-data/attachments/Doc1/literal%2Fname + café.bin"
        route = "/api/file?" + urlencode({"path": path})
        self.assertEqual(self.mutation("PUT", route, b"literal")[0], 200)
        self.assertEqual(self.request("GET", route)[2], b"literal")
        self.assertEqual(self.request("GET", "/api/file?" + urlencode({
            "path": "invoicing-data/attachments/Doc1/literal/name + café.bin",
        }))[0], 400)
        self.assertEqual(self.request("GET", "/%61pi/session")[0], 200)
        self.assertEqual(self.request("GET", "/%61pi/session", headers={"Origin": "https://evil.invalid"})[0], 403)
        self.assertEqual(self.request("GET", "/%2561pi/session")[0], 404)

    def test_bounded_bodies_reject_oversize_before_reading(self):
        metadata_limit, file_limit = 8 * 1024 * 1024, 32 * 1024 * 1024
        kv = "/api/kv?key=invc:settings:v1"
        document = "/api/file?path=invoicing-data/docs-2026.json"
        attachment = "/api/file?path=invoicing-data/attachments/Doc1/data.bin"
        for route, limit in ((kv, metadata_limit), (document, metadata_limit), (attachment, file_limit)):
            with self.subTest(route=route):
                status, _, _ = self.mutation("PUT", route, headers={
                    "Content-Type": "application/json", "Content-Length": str(limit + 1),
                })
                self.assertEqual(status, 413)
                self.assertEqual(self.request("GET", route)[1].get("ETag"), '"0"')
        payload = b'{"value":"' + b"x" * (metadata_limit - len(b'{"value":""}')) + b'"}'
        self.assertEqual(len(payload), metadata_limit)
        self.assertEqual(self.mutation("PUT", kv, payload, headers={"Content-Type": "application/json"})[0], 200)
        self.assertEqual(self.mutation("PUT", document, b"x" * metadata_limit)[0], 200)
        self.assertEqual(self.mutation("PUT", attachment, b"x" * file_limit)[0], 200)
        self.assertEqual(json.loads(self.request("GET", attachment + "&stat=1")[2])["size"], file_limit)

    def test_invalid_bodies_never_change_data(self):
        route = "/api/kv?key=invc:settings:v1"
        for body in (b"", b"{", b"[]", b"{}", b'{"value":null}', b'{"value":1}', b'{"value":true}',
                     b'{"value":"ok","extra":1}', b'{"value":"x","value":"y"}',
                     b'{"value":"\\ud800"}', b'{"value":"\xff"}'):
            with self.subTest(body=body):
                self.assertEqual(self.mutation("PUT", route, body, headers={"Content-Type": "application/json"})[0], 400)
        for content_type in (None, "text/plain", "application/octet-stream"):
            self.assertEqual(self.mutation("PUT", route, b'{"value":"x"}', headers={"Content-Type": content_type})[0], 415)
        for length in (None, "", "-1", "+1", "1.0", "one", "0, 0"):
            self.assertEqual(self.mutation("PUT", route, headers={
                "Content-Length": length, "Content-Type": "application/json",
            })[0], 400)
        self.assertEqual(self.mutation("PUT", route, headers={
            "Content-Type": "application/json", "Transfer-Encoding": "chunked",
        })[0], 400)
        self.assertEqual(self.request("GET", route)[1].get("ETag"), '"0"')
        self.assertEqual(self.mutation("PUT", route, b'{"value":"ok"}', headers={
            "Content-Type": "application/json; charset=utf-8",
        })[0], 200)

    def test_static_serves_only_confined_dist_files(self):
        (self.dist / "app.js").write_bytes(b"const ok = true;")
        (self.dist / "literal%2e.txt").write_bytes(b"decoded once")
        (self.dist / ".secret").write_bytes(b"private")
        (self.dist / "nested").mkdir()
        (self.dist / "nested" / "index.html").write_bytes(b"nested app")
        (self.dist / "listing").mkdir()
        (self.dist / "listing" / "visible.txt").write_bytes(b"not a listing")
        outside = self.root / "outside.txt"
        outside.write_bytes(b"must not serve")
        (self.dist / "escape.txt").symlink_to(outside)
        (self.dist / "external").symlink_to(self.root, target_is_directory=True)
        (self.dist / "nested" / "index.html").unlink()
        (self.dist / "nested" / "index.html").symlink_to(outside)
        (self.dist / "api").mkdir()
        (self.dist / "api" / "missing").write_bytes(b"not an API response")
        for route, expected in (("/", b"<html>private app</html>"), ("/app.js", b"const ok = true;"),
                                ("/literal%252e.txt", b"decoded once")):
            status, _, body = self.request("GET", route)
            self.assertEqual((status, body), (200, expected))
            status, headers, body = self.request("HEAD", route)
            self.assertEqual((status, body), (200, b""))
            self.assertEqual(int(headers["Content-Length"]), len(expected))
        for route in ("/../outside.txt", "/%2e%2e/outside.txt", "/%2Esecret", "/.secret",
                      "/escape.txt", "/external/outside.txt", "/nested/", "/listing/", "/listing",
                      "/app.js/", "/%00", "/a\\b", "/api/missing", "/api", "/private_server.py",
                      "/invoicing-data/docs-2026.json", "/api/../index.html"):
            with self.subTest(route=route):
                status, _, body = self.request("GET", route)
                self.assertIn(status, (400, 403, 404))
                self.assertNotIn(b"must not serve", body)
                self.assertNotIn(b"not an API response", body)
                self.assertNotIn(b"Directory listing", body)
        self.assertEqual(self.request("GET", "/api/session")[0], 200)

    def test_every_response_has_security_and_no_cache_headers(self):
        for route, request_headers in (("/", {}), ("/api/session", {}), ("/missing", {}),
                ("/api/kv?key=invc:settings:v1", {}),
                ("/api/file?path=invoicing-data/docs-2026.json", {}),
                ("/api/session", {"Tailscale-User-Login": None})):
            with self.subTest(route=route, request_headers=request_headers):
                _, headers, _ = self.request("GET", route, headers=request_headers)
                self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
                self.assertEqual(headers.get("X-Frame-Options"), "DENY")
                self.assertEqual(headers.get("Cache-Control"), "no-store")
                self.assertNotIn("Access-Control-Allow-Origin", headers)
                csp = headers.get("Content-Security-Policy", "")
                for directive in ("default-src 'self'", "script-src 'self' 'unsafe-inline'",
                    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
                    "font-src 'self' data:", "connect-src 'self'", "object-src 'none'",
                    "frame-ancestors 'none'", "base-uri 'self'"):
                    self.assertIn(directive, csp)

    def test_sqlite_failures_are_honest_and_do_not_log_private_data(self):
        from contextlib import closing, redirect_stderr
        import io
        route = "/api/kv?key=invc:settings:v1"
        secret = "private database error details"
        with closing(self.server.store.connect()) as db:
            db.execute("CREATE TRIGGER deny_write BEFORE INSERT ON resources BEGIN "
                       "SELECT RAISE(ABORT, 'private database error details'); END")
        captured = io.StringIO()
        with redirect_stderr(captured):
            status, _, body = self.mutation("PUT", route, b'{"value":"must not be saved"}',
                headers={"Content-Type": "application/json"})
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body), {"error": "Storage unavailable.", "code": "STORAGE_ERROR"})
        self.assertNotIn(secret, body.decode())
        self.assertEqual(captured.getvalue(), "")
        self.assertEqual(json.loads(self.request("GET", route)[2]), {"value": None})
        self.assertEqual(self.request("GET", route)[1].get("ETag"), '"0"')
        with closing(self.server.store.connect()) as db:
            db.execute("ALTER TABLE resources RENAME TO unavailable")
        for target in (route, "/api/file?path=invoicing-data/docs-2026.json",
                       "/api/files?prefix=invoicing-data/attachments/Doc1/"):
            with redirect_stderr(captured):
                status, _, body = self.request("GET", target)
            self.assertEqual(status, 500)
            self.assertEqual(json.loads(body)["code"], "STORAGE_ERROR")
        self.assertEqual(captured.getvalue(), "")

    def test_concurrent_http_writes_across_servers_have_one_winner(self):
        from concurrent.futures import ThreadPoolExecutor
        second = self.start_server(self.config)
        for route, is_kv in (("/api/kv?key=invc:settings:v1", True),
                            ("/api/file?path=invoicing-data/docs-2026.json", False)):
            barrier = threading.Barrier(8)

            def write(index):
                value = "writer-" + str(index)
                payload = json.dumps({"value": value}).encode() if is_kv else value.encode()
                barrier.wait(timeout=10)
                result = self.mutation("PUT", route, payload,
                    headers={"Content-Type": "application/json"},
                    server=self.server if index % 2 else second)
                return value, result

            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(write, range(8)))
            self.assertEqual(sorted(result[0] for _, result in results), [200] + [409] * 7)
            winner = next(value for value, result in results if result[0] == 200)
            for target in (self.server, second):
                status, headers, body = self.request("GET", route, server=target)
                self.assertEqual(status, 200)
                self.assertEqual(headers.get("ETag"), '"1"')
                self.assertEqual(json.loads(body)["value"] if is_kv else body.decode(), winner)

    def test_deleting_missing_file_creates_a_persistent_tombstone(self):
        route = "/api/file?path=invoicing-data/attachments/Doc1/missing.bin"
        status, headers, body = self.mutation("DELETE", route)
        self.assertEqual((status, json.loads(body), headers.get("ETag")), (200, {"ok": True}, '"1"'))
        second = self.start_server(self.config)
        status, headers, body = self.request("GET", route, server=second)
        self.assertEqual((status, json.loads(body)["code"], headers.get("ETag")), (404, "ENOENT", '"1"'))
        self.assertEqual(self.mutation("PUT", route, b"stale", server=second)[0], 409)
        self.assertEqual(self.mutation("DELETE", route, revision='"1"', server=second)[1].get("ETag"), '"2"')

    def test_explicit_loopback_http_origin_keeps_identity_and_csrf_checks(self):
        from dataclasses import replace
        origin = "http://127.0.0.1:18724"
        server = self.start_server(replace(self.config, origin=origin))
        headers = {"Host": "127.0.0.1:18724"}
        self.assertEqual(self.request("GET", "/api/session", headers=headers, server=server)[0], 200)
        self.assertEqual(self.request("GET", "/api/session", headers={**headers,
            "Tailscale-User-Login": None}, server=server)[0], 403)
        route = "/api/kv?key=invc:settings:v1"
        self.assertEqual(self.mutation("PUT", route, b'{"value":"ok"}', headers={
            **headers, "Origin": origin, "Content-Type": "application/json",
        }, server=server)[0], 200)
        self.assertEqual(self.mutation("PUT", route, b'{"value":"bad"}', revision='"1"', headers={
            **headers, "Content-Type": "application/json",
        }, server=server)[0], 403)
        for bad in ("http://192.0.2.1:18724", "http://localhost:18724", "http://127.0.0.1.evil:18724"):
            with self.assertRaises(ValueError):
                with backend.create_server(replace(self.config, origin=bad)):
                    pass

    def test_backup_restores_committed_bytes_revisions_and_tombstones(self):
        from contextlib import closing
        from dataclasses import replace
        import shutil
        import sqlite3
        import stat
        self.assertTrue(callable(getattr(backend, "backup_database", None)), "backup helper is not implemented")
        kv = "/api/kv?key=invc:settings:v1"
        file = "/api/file?path=invoicing-data/attachments/Doc1/binary.bin"
        gone = "/api/file?path=invoicing-data/docs-2026.json"
        self.assertEqual(self.mutation("PUT", kv, b'{"value":"committed"}', headers={"Content-Type": "application/json"})[0], 200)
        self.assertEqual(self.mutation("PUT", file, b"\x00\xffbinary")[0], 200)
        self.assertEqual(self.mutation("DELETE", gone)[0], 200)
        with closing(self.server.store.connect()) as writer:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("UPDATE resources SET value=? WHERE kind='kv'", (b"uncommitted",))
            snapshot = backend.backup_database(self.config.data_dir, retain=2)
            writer.rollback()
        self.assertTrue(snapshot.is_file())
        self.assertEqual(snapshot.parent, self.config.data_dir / "backups")
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o600)
        with closing(sqlite3.connect(snapshot)) as db:
            self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        restored_dir = self.root / "restored"
        restored_dir.mkdir()
        shutil.copyfile(snapshot, restored_dir / "invoicing.sqlite3")
        restored = self.start_server(replace(self.config, data_dir=restored_dir))
        self.assertEqual(json.loads(self.request("GET", kv, server=restored)[2]), {"value": "committed"})
        self.assertEqual(self.request("GET", kv, server=restored)[1].get("ETag"), '"1"')
        self.assertEqual(self.request("GET", file, server=restored)[2], b"\x00\xffbinary")
        self.assertEqual(self.request("GET", gone, server=restored)[1].get("ETag"), '"1"')
        self.assertEqual(self.mutation("PUT", gone, b"[]", server=restored)[0], 409)
        unrelated = snapshot.parent / "other-backup.sqlite3"
        unrelated.write_bytes(b"keep")
        link = snapshot.parent / ("invoicing-backup-20000101T000000000000Z-" + "0" * 32 + ".sqlite3")
        link.symlink_to(unrelated)
        directory = snapshot.parent / ("invoicing-backup-20000101T000000000000Z-" + "1" * 32 + ".sqlite3")
        directory.mkdir()
        snapshots = [snapshot] + [backend.backup_database(self.config.data_dir, retain=2) for _ in range(3)]
        self.assertEqual(len(set(snapshots)), 4)
        self.assertEqual([p.exists() for p in snapshots], [False, False, True, True])
        self.assertTrue(link.is_symlink())
        self.assertTrue(directory.is_dir())
        self.assertEqual(unrelated.read_bytes(), b"keep")
        with self.assertRaises(ValueError):
            backend.backup_database(self.config.data_dir, retain=0)
        with self.assertRaises((FileNotFoundError, ValueError)):
            backend.backup_database(self.root / "missing")

    def test_cli_help_backup_and_real_server(self):
        import select
        import signal
        import subprocess
        from types import SimpleNamespace
        script = str(Path(backend.__file__).resolve())
        command = [sys.executable, "-B", script]
        help_result = subprocess.run(command + ["--help"], capture_output=True, text=True, timeout=10)
        self.assertEqual(help_result.returncode, 0)
        for option in ("--host", "--port", "--dist", "--data-dir", "--origin", "--allowed-login-file", "--backup", "--retain"):
            self.assertIn(option, help_result.stdout)
        route = "/api/kv?key=invc:clients:v1"
        self.assertEqual(self.mutation("PUT", route, b'{"value":"CLI backup"}', headers={"Content-Type": "application/json"})[0], 200)
        result = subprocess.run(command + ["--backup", "--data-dir", str(self.config.data_dir), "--retain", "2"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(Path(result.stdout.strip()).is_file())
        result = subprocess.run(command + ["--backup", "--data-dir", str(self.config.data_dir), "--retain", "0"],
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        args = ["--host", "127.0.0.1", "--port", "0", "--dist", str(self.dist),
                "--data-dir", str(self.root / "cli-data"), "--origin", "http://127.0.0.1:18724",
                "--allowed-login-file", str(self.login)]
        process = subprocess.Popen(command + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def stop_process():
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=10)

        self.addCleanup(stop_process)
        self.assertTrue(select.select([process.stdout], [], [], 10)[0], "CLI did not announce readiness")
        line = process.stdout.readline().strip()
        self.assertRegex(line, r"^Listening on 127\.0\.0\.1:[0-9]+$")
        live = SimpleNamespace(server_port=int(line.rsplit(":", 1)[-1]))
        status, _, body = self.request("GET", "/api/session", headers={"Host": "127.0.0.1:18724"}, server=live)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["storage"], "jetson")
        self.assertEqual(self.request("GET", "/api/session", headers={
            "Host": "127.0.0.1:18724", "Tailscale-User-Login": None,
        }, server=live)[0], 403)
        process.send_signal(signal.SIGINT)
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual((process.returncode, stdout, stderr), (0, "", ""))

    def test_configuration_never_exposes_data_or_owner_file_through_dist(self):
        from dataclasses import replace
        for changes in ({"data_dir": self.dist / "private-data"}, {"dist": self.root}):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    with backend.create_server(replace(self.config, **changes)):
                        pass
        link = self.root / "data-link"
        link.symlink_to(self.config.data_dir, target_is_directory=True)
        with self.assertRaises(ValueError):
            with backend.create_server(replace(self.config, data_dir=link)):
                pass

    def test_duplicate_headers_and_invalid_framing_fail_closed(self):
        import socket
        route = "/api/file?path=invoicing-data/docs-2026.json"
        base = [("Host", urlsplit(ORIGIN).netloc), ("Tailscale-User-Login", OWNER),
                ("Origin", ORIGIN), ("X-Invoicing-Request", "1"), ("If-Match", '"0"')]

        def raw(method, extra, body=b"", length="0"):
            headers = base + [("Content-Length", length)] + extra
            payload = (method + " " + route + " HTTP/1.1\r\n" + "".join(
                name + ": " + value + "\r\n" for name, value in headers) + "\r\n").encode() + body
            with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=10) as sock:
                sock.sendall(payload)
                sock.shutdown(socket.SHUT_WR)
                response = http.client.HTTPResponse(sock)
                response.begin()
                result = response.status, response.read()
                response.close()
                return result

        for name, value, status in (("Host", urlsplit(ORIGIN).netloc, 403),
            ("Tailscale-User-Login", OWNER, 403), ("Origin", ORIGIN, 403),
            ("X-Invoicing-Request", "1", 403), ("If-Match", '"0"', 400),
            ("Content-Length", "0", 400), ("Transfer-Encoding", "chunked", 400)):
            with self.subTest(name=name):
                self.assertEqual(raw("PUT", [(name, value)])[0], status)
        self.assertEqual(raw("PUT", [], b"short", "20")[0], 400)
        self.assertEqual(raw("GET", [("Content-Length", "0")])[0], 400)
        self.assertEqual(raw("DELETE", [("Transfer-Encoding", "chunked")])[0], 400)
        self.assertEqual(raw("DELETE", [], b"x", "1")[0], 400)
        self.assertEqual(self.request("GET", route)[1].get("ETag"), '"0"')

    def test_session_identifies_private_storage(self):
        status, headers, body = self.request("GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"username": "Jetson storage", "storage": "jetson"})


if __name__ == "__main__":
    unittest.main()
