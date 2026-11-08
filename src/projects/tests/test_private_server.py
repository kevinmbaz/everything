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

ORIGIN = "https://jetson-energy.tail274ca7.ts.net:18919"
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
        actual = {"Origin": ORIGIN, "X-Projects-Request": "1", "If-Match": revision}
        if headers:
            actual.update(headers)
        return self.request(method, path, body, actual, server)

    def test_session_identifies_private_storage(self):
        status, _, body = self.request("GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"username": "Jetson storage", "storage": "jetson"})

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

    def test_kv_strings_persist_with_conditional_revisions(self):
            for name in ("settings", "projects", "trash", "templates", "views"):
                route = "/api/kv?" + urlencode({"key": "pm:" + name + ":v1"})
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
            for name in ("settings", "projects", "trash", "templates", "views"):
                route = "/api/kv?" + urlencode({"key": "pm:" + name + ":v1"})
                status, headers, body = self.request("GET", route, server=reopened)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), {"value": 'Unicode € / ' + name + ' / "quoted"\n'})
                self.assertEqual(headers.get("ETag"), '"1"')
                status, headers, _ = self.mutation("PUT", route, b'{"value":""}', revision='"1"',
                    headers={"Content-Type": "application/json"}, server=reopened)
                self.assertEqual((status, headers.get("ETag")), (200, '"2"'))
                self.assertEqual(json.loads(self.request("GET", route, server=reopened)[2]), {"value": ""})

    def test_files_preserve_binary_bytes_stat_and_deleted_revisions(self):
            paths = ["projects-data/project-Ab09.json", "projects-data/attachments/Ab09/Task1/Att1-reçu € 1.bin",
                 "projects-data/snapshots/project-Ab09/2026-11-08.json",
                 "projects-data/snapshots/project-Ab09/2026-11-08-1.json"]
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
                    self.assertEqual((status, json.loads(body)), (200, {"path": path, "size": len(data), "modified": 1}))
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

    def test_backup_restores_committed_resources_and_retains_seven(self):
        from contextlib import closing
        from dataclasses import replace
        import shutil
        import sqlite3
        import stat
        self.assertTrue(callable(getattr(backend, "backup_database", None)), "backup not implemented")
        kv = "/api/kv?key=pm:settings:v1"
        file = "/api/file?path=projects-data/attachments/Project1/Task1/Att1-file.bin"
        snapshot_file = "/api/file?path=projects-data/snapshots/project-Project1/2026-11-08.json"
        gone = "/api/file?path=projects-data/project-Project1.json"
        self.assertEqual(self.mutation("PUT", kv, b'{"value":"committed"}', headers={"Content-Type": "application/json"})[0], 200)
        self.assertEqual(self.mutation("PUT", file, b"\x00\xffbinary")[0], 200)
        self.assertEqual(self.mutation("PUT", snapshot_file, b'{"doc":{"tasks":[]}}')[0], 200)
        self.assertEqual(self.mutation("DELETE", gone)[0], 200)
        with closing(self.server.store.connect()) as writer:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("UPDATE resources SET value=? WHERE kind='kv'", (b"uncommitted",))
            snapshot = backend.backup_database(self.config.data_dir)
            writer.rollback()
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o600)
        with closing(sqlite3.connect(snapshot)) as db:
            self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        restored_dir = self.root / "restored"
        restored_dir.mkdir()
        shutil.copyfile(snapshot, restored_dir / "projects.sqlite3")
        restored = self.start_server(replace(self.config, data_dir=restored_dir))
        self.assertEqual(json.loads(self.request("GET", kv, server=restored)[2]), {"value": "committed"})
        self.assertEqual(self.request("GET", file, server=restored)[2], b"\x00\xffbinary")
        self.assertEqual(self.request("GET", snapshot_file, server=restored)[2], b'{"doc":{"tasks":[]}}')
        status, headers, body = self.request("GET", gone, server=restored)
        self.assertEqual((status, headers.get("ETag"), json.loads(body)["code"]), (404, '"1"', "ENOENT"))
        self.assertEqual(self.mutation("PUT", gone, b"stale", server=restored)[0], 409)
        unrelated = snapshot.parent / "unrelated.sqlite3"
        unrelated.write_bytes(b"keep")
        link = snapshot.parent / ("projects-backup-20000101T000000000000Z-" + "0" * 32 + ".sqlite3")
        link.symlink_to(unrelated)
        snapshots = [snapshot] + [backend.backup_database(self.config.data_dir) for _ in range(8)]
        self.assertEqual(len(set(snapshots)), 9)
        self.assertEqual([p.exists() for p in snapshots], [False, False] + [True] * 7)
        self.assertTrue(link.is_symlink())
        self.assertEqual(unrelated.read_bytes(), b"keep")
        with self.assertRaises(ValueError):
            backend.backup_database(self.config.data_dir, retain=0)

    def test_static_serving_is_confined_and_supports_retiring_worker(self):
        (self.dist / "sw.js").write_text("self.registration.unregister();")
        (self.dist / "assets").mkdir()
        (self.dist / "assets" / "app.js").write_text("console.log('private');")
        (self.dist / "outside.txt").symlink_to(self.login)
        (self.dist / "linkdir").symlink_to(self.root, target_is_directory=True)
        (self.dist / "empty").mkdir()
        (self.dist / "empty" / "index.html").symlink_to(self.login)
        for route, expected in [("/", b"<html>private app</html>"),
                                ("/assets/app.js", b"console.log('private');"),
                                ("/sw.js?private=1", b"self.registration.unregister();")]:
            with self.subTest(route=route):
                status, headers, body = self.request("GET", route)
                self.assertEqual((status, body), (200, expected))
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
                status, headers, body = self.request("HEAD", route)
                self.assertEqual((status, body), (200, b""))
                self.assertEqual(int(headers["Content-Length"]), len(expected))
        for route in ("/../owner.txt", "/%2e%2e/owner.txt", "/.hidden", "/outside.txt",
                      "/linkdir/owner.txt", "/empty/", "/assets/", "/assets//app.js",
                      "/api/unknown", "/?private=1", "/sw.js?private=2", "/sw.js?private=1&x=2"):
            with self.subTest(route=route):
                status, _, body = self.request("GET", route)
                self.assertIn(status, (400, 403, 404))
                self.assertNotIn(OWNER.encode(), body)

    def test_cli_supports_backup_and_rejects_nonloopback(self):
        import subprocess
        assert backend is not None
        script = str(Path(backend.__file__).resolve())
        result = subprocess.run([sys.executable, script, "--data-dir", str(self.config.data_dir), "--backup"],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip(), "CLI backup did not run")
        self.assertTrue(Path(result.stdout.strip()).is_file())
        result = subprocess.run([sys.executable, script, "--data-dir", str(self.config.data_dir),
                                 "--dist", str(self.dist), "--allowed-login-file", str(self.login),
                                 "--host", "0.0.0.0"], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1)

    def test_mutations_require_csrf_and_valid_revision(self):
        route = "/api/kv?key=pm:settings:v1"
        payload = b'{"value":"{}"}'
        for overrides, status in [({"Origin": None}, 403), ({"Origin": "https://evil.invalid"}, 403),
                                  ({"X-Projects-Request": None}, 403), ({"X-Projects-Request": "2"}, 403),
                                  ({"If-Match": None}, 428), ({"If-Match": "*"}, 400),
                                  ({"If-Match": '"00"'}, 400), ({"Sec-Fetch-Site": "cross-site"}, 403)]:
            with self.subTest(overrides=overrides):
                headers = {"Content-Type": "application/json", **overrides}
                self.assertEqual(self.mutation("PUT", route, payload, headers=headers)[0], status)
        self.assertEqual(json.loads(self.request("GET", route)[2]), {"value": None})
        for headers in ({"Origin": "https://evil.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("GET", route, headers=headers)[0], 403)

    def test_api_paths_and_body_limits_reject_invalid_inputs(self):
        for file in ("../owner.txt", "/etc/passwd", "projects-data/project-../x.json",
                     "projects-data/attachments/A/B/C-../../x", "projects-data/attachments/A/B/C-a\\b",
                     "projects-data/project-A.json\x00", "projects-data/snapshots/project-A/2026-02-31.json"):
            with self.subTest(file=file):
                self.assertEqual(self.request("GET", "/api/file?"+urlencode({"path": file}))[0], 400)
        for route in ("/api/kv?key=invc:settings:v1", "/api/kv?key=pm:settings:v1&key=pm:trash:v1",
                      "/api/file?path=%ZZ", "/api/files?prefix=projects-data/", "/api/session?x=1"):
            self.assertEqual(self.request("GET", route)[0], 400)
        route = "/api/kv?key=pm:settings:v1"
        for payload in (b'{"value":{}}', b'{"value":"a","value":"b"}', b'not json'):
            self.assertEqual(self.mutation("PUT", route, payload, headers={"Content-Type":"application/json"})[0], 400)
        self.assertEqual(self.mutation("PUT", route, b'{}', headers={"Content-Type":"text/plain"})[0], 415)
        self.assertEqual(self.mutation("PUT", route, b'', headers={"Content-Type":"application/json", "Content-Length":str(9*1024*1024)})[0], 413)

    def test_concurrent_cas_allows_one_winner(self):
        from concurrent.futures import ThreadPoolExecutor
        route = "/api/file?path=projects-data/project-Race1.json"
        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda n: self.mutation("PUT", route, str(n).encode())[0], range(8)))
        self.assertEqual(statuses.count(200), 1)
        self.assertEqual(statuses.count(409), 7)
        self.assertEqual(self.request("GET", route)[1]["ETag"], '"1"')

    def test_configuration_refuses_untrusted_locations(self):
        from dataclasses import replace
        assert backend is not None
        for config in (replace(self.config, host="0.0.0.0"), replace(self.config, origin="http://example.com"),
                       replace(self.config, data_dir=self.dist / "data"),
                       replace(self.config, allowed_login_file=self.dist / "owner.txt")):
            with self.subTest(config=config):
                with self.assertRaises(ValueError):
                    backend.create_server(config)

    def test_listing_full_descendants_metadata_and_tombstones(self):
        paths = [
            "projects-data/snapshots/project-Ab09/2026-11-08.json",
            "projects-data/snapshots/project-Ab09/2026-11-08-1.json",
            "projects-data/snapshots/project-Ab091/2026-11-07.json",
            "projects-data/attachments/Ab09/Task1/Att1-notes.txt",
            "projects-data/attachments/Ab09/Task11/Att2-image.png",
            "projects-data/attachments/Ab091/Task1/Att3-file.bin",
        ]
        for path in paths:
            self.assertEqual(self.mutation("PUT", "/api/file?" + urlencode({"path": path}), b"xyz")[0], 200)
        for prefix in ("projects-data/snapshots/", "projects-data/snapshots/project-Ab09/",
                       "projects-data/attachments/Ab09/", "projects-data/attachments/Ab09/Task1/",
                       "projects-data/attachments/Empty/Task1/"):
            route = "/api/files?" + urlencode({"prefix": prefix})
            status, _, body = self.request("GET", route)
            self.assertEqual(status, 200)
            expected = [{"path": p, "etag": '"1"', "size": 3, "modified": 1}
                        for p in sorted(paths) if p.startswith(prefix)]
            self.assertEqual(json.loads(body), {"files": expected})
        removed = paths[0]
        self.assertEqual(self.mutation("DELETE", "/api/file?" + urlencode({"path": removed}), revision='"1"')[0], 200)
        files = json.loads(self.request("GET", "/api/files?prefix=projects-data/snapshots/")[2])["files"]
        self.assertEqual([f["path"] for f in files], sorted(paths[1:3]))
