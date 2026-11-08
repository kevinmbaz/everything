"""Real loopback HTTP and isolated SQLite regression tests (no credentials)."""
from contextlib import closing
import concurrent.futures
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = Path.home() / '.hermes/cache/scratch'
SCRATCH.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=SCRATCH, prefix='private-storage-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.dist = self.base / 'dist-private'
        self.dist.mkdir()
        (self.dist / 'index.html').write_text('<h1>Private</h1>')
        self.owner = self.base / 'owner.txt'
        self.owner.write_text('synthetic-owner@example.test\n')
        self.origin = 'https://private.example.test:18900'
        self.headers = {'Host': 'private.example.test:18900',
                        'Tailscale-User-Login': 'synthetic-owner@example.test'}

    def start(self, app='tasks', data=None):
        self.assertIsNotNone(importlib.util.find_spec('private_storage.server'),
                             'private storage server has not been implemented')
        from private_storage.server import Config, create_server
        server = create_server(Config(app=app, dist=self.dist, data_dir=data or self.base / app,
                                      origin=self.origin, allowed_login_file=self.owner, port=0))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def stop():
            server.shutdown()
            server.server_close()
            thread.join()
        self.addCleanup(stop)
        self.server = server
        return server

    def request(self, method, target, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        h = dict(self.headers)
        if headers:
            h.update(headers)
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            h.setdefault('Content-Type', 'application/json')
        conn.request(method, target, body=body, headers=h)
        response = conn.getresponse()
        content = response.read()
        result = response.status, dict(response.getheaders()), content
        conn.close()
        return result

    def mutate(self, method, target, body=None, revision='"0"', headers=None):
        h = {'Origin': self.origin, 'X-Everything-Request': '1'}
        if revision is not None:
            h['If-Match'] = revision
        if headers:
            h.update(headers)
        return self.request(method, target, body, h)

    def test_authenticated_session_and_static(self):
        self.start()
        status, headers, body = self.request('GET', '/api/session')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'username': 'Jetson storage', 'uuid': 'jetson-owner',
                                          'storage': 'jetson', 'app': 'tasks'})
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(self.request('GET', '/')[2], b'<h1>Private</h1>')
        for target in ('/', '/api/session'):
            with self.subTest(target=target):
                self.assertEqual(self.request('GET', target, headers={'Tailscale-User-Login': 'wrong'})[0], 403)
                self.assertEqual(self.request('GET', target, headers={'Host': 'wrong'})[0], 403)

    def test_static_descriptor_confinement(self):
        self.start()
        outside = self.base / 'outside'
        outside.mkdir()
        (outside / 'secret').write_text('secret')
        (self.dist / 'escape').symlink_to(outside, target_is_directory=True)
        (self.dist / 'link.txt').symlink_to(outside / 'secret')
        (self.dist / '.hidden').write_text('secret')
        (self.dist / 'empty').mkdir()
        os.mkfifo(self.dist / 'pipe')
        (self.dist / 'worker.js').write_text('/* network only */')
        (self.dist / 'module.wasm').write_bytes(b'wasm')
        for target in ('/../owner.txt', '/%2e%2e/owner.txt', '/escape/secret', '/link.txt',
                       '/.hidden', '/empty/', '/pipe', '/%00', '/a\\b', '/?unknown=1'):
            with self.subTest(target=target):
                self.assertIn(self.request('GET', target)[0], (400, 403, 404))
        status, headers, _ = self.request('GET', '/module.wasm')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/wasm')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertIn("connect-src 'self'", headers['Content-Security-Policy'])
        self.assertEqual(self.request('GET', '/api/no-such-route')[0], 404)

    def test_kv_cas_tombstones_and_durable_sqlite(self):
        server = self.start()
        target = '/api/kv?key=tasks:items:v1'
        status, headers, body = self.request('GET', target)
        self.assertEqual(status, 200)
        self.assertEqual(headers['ETag'], '"0"')
        self.assertEqual(json.loads(body), {'value': None})
        self.assertEqual(self.mutate('PUT', target, {'value': '[{"id":1}]'})[1]['ETag'], '"1"')
        status, _, body = self.mutate('PUT', target, {'value': '[]'})
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)['code'], 'CONFLICT')
        self.assertEqual(self.request('GET', target)[2], b'{"value": "[{\\"id\\":1}]"}')
        self.assertEqual(self.mutate('DELETE', target, revision='"1"')[1]['ETag'], '"2"')
        self.assertEqual(json.loads(self.request('GET', target)[2]), {'value': None})
        self.assertEqual(self.mutate('PUT', target, {'value': 'null'})[0], 409)
        self.assertEqual(self.mutate('PUT', target, {'value': 'null'}, '"2"')[1]['ETag'], '"3"')
        self.assertEqual(json.loads(self.request('GET', target)[2]), {'value': 'null'})
        self.assertEqual(self.request('GET', '/api/kv?key=pm:settings:v1')[0], 400)
        database = self.base / 'tasks/tasks.sqlite3'
        self.assertTrue(database.is_file())
        self.assertEqual(database.stat().st_mode & 0o777, 0o600)
        self.assertEqual(database.parent.stat().st_mode & 0o777, 0o700)
        with closing(sqlite3.connect(database)) as db:
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        with closing(server.store.connect()) as db:
            self.assertEqual(db.execute('PRAGMA synchronous').fetchone()[0], 2)
        self.start(data=database.parent)
        self.assertEqual(self.request('GET', target)[1]['ETag'], '"3"')


    def test_mutations_require_csrf_and_single_valid_precondition(self):
        self.start()
        target = '/api/kv?key=tasks:settings:v1'
        for headers in ({}, {'Origin': self.origin},
                        {'Origin': 'https://evil.test', 'X-Everything-Request': '1'},
                        {'Origin': self.origin, 'X-Everything-Request': 'yes'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request('PUT', target, {'value': '{}'},
                                              dict(headers, **{'If-Match': '"0"'}))[0], 403)
        self.assertEqual(self.mutate('PUT', target, {'value': '{}'}, revision=None)[0], 428)
        for revision in ('0', '*', 'W/"0"', '"00"', '"-1"', '"0", "1"', '"9223372036854775808"'):
            with self.subTest(revision=revision):
                self.assertEqual(self.mutate('PUT', target, {'value': '{}'}, revision)[0], 400)
        self.assertEqual(self.request('GET', target, headers={'Origin': 'https://evil.test'})[0], 403)
        self.assertEqual(self.request('GET', target, headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.request('GET', target)[1]['ETag'], '"0"')

    def test_first_three_resource_policies_and_binary_files(self):
        policies = {
            'expense': {
                'keys': ['exp:settings:v1', 'exp:categories:v1', 'exp:months:v1'],
                'files': ['expenses-data/exp-2026-01.json', 'expenses-data/reports.json',
                          'expenses-data/statements.json', 'expenses-data/receipts/A_b-1.pdf'],
                'bad': ['expenses-data/exp-2026-13.json', 'expenses-data/exp-0000-01.json',
                        'expenses-data/receipts/a.svg', 'expenses-data/receipts/é.png',
                        'expenses-data/receipts/' + 'a' * 101 + '.png'],
                'prefix': 'expenses-data/receipts/'},
            'time-tracking': {
                'keys': ['hourly:' + k + ':v1' for k in ('settings', 'clients', 'projects', 'months',
                                                        'timer', 'backups', 'invoices')],
                'files': ['hourly-data/entries-2024-02.json', 'hourly-data/backups/backup-2024-02-29.json',
                          'hourly-data/logo-123.png', 'hourly-data/logo-123-A_b-1.webp'],
                'bad': ['hourly-data/entries-2026-00.json', 'hourly-data/backups/backup-2026-02-29.json',
                        'hourly-data/logo-abc.png', 'hourly-data/logo-123.svg'],
                'prefix': 'hourly-data/backups/'},
            'tasks': {
                'keys': ['tasks:' + k + ':v1' for k in ('settings', 'lists', 'items')],
                'files': ['tasks-data/log-2026-11.json'],
                'bad': ['tasks-data/log-2026-99.json', 'tasks-data/log-0000-01.json', 'tasks-data/share.ics'],
                'prefix': None}}
        for app, policy in policies.items():
            with self.subTest(app=app):
                self.start(app)
                for key in policy['keys']:
                    self.assertEqual(self.mutate('PUT', '/api/kv?' + urlencode({'key': key}), {'value': '[]'})[0], 200)
                for path in policy['files']:
                    target = '/api/file?' + urlencode({'path': path})
                    self.assertEqual(self.request('GET', target)[0:2][0], 404)
                    self.assertEqual(json.loads(self.request('GET', target)[2])['code'], 'ENOENT')
                    content = b'\x00\xffbinary\x80'
                    self.assertEqual(self.mutate('PUT', target, content)[0], 200)
                    self.assertEqual(self.request('GET', target)[2], content)
                    status, headers, body = self.request('GET', target + '&stat=1')
                    self.assertEqual(status, 200)
                    self.assertEqual(json.loads(body), {'path': path, 'size': len(content), 'modified': 1})
                    self.assertEqual(headers['ETag'], '"1"')
                for path in policy['bad'] + ['../secret', '/etc/passwd', 'tasks-data/../secret']:
                    self.assertEqual(self.mutate('PUT', '/api/file?' + urlencode({'path': path}), b'x')[0], 400)
                if policy['prefix']:
                    listing = '/api/files?' + urlencode({'prefix': policy['prefix']})
                    listed = json.loads(self.request('GET', listing)[2])['files']
                    self.assertEqual([f['path'] for f in listed], [p for p in policy['files'] if p.startswith(policy['prefix'])])
                    for entry in listed:
                        target = '/api/file?' + urlencode({'path': entry['path']})
                        self.assertEqual(self.mutate('DELETE', target, revision=entry['etag'])[1]['ETag'], '"2"')
                        self.assertEqual(self.request('GET', target)[1]['ETag'], '"2"')
                    self.assertEqual(json.loads(self.request('GET', listing)[2])['files'], [])
                self.assertEqual(self.request('GET', '/api/files?prefix=tasks-data/')[0], 400)
                self.assertEqual(self.request('GET', '/api/kv?key=unknown')[0], 400)

    def raw(self, method, target, headers=(), body=b''):
        pairs = list(self.headers.items()) + list(headers)
        request = (method + ' ' + target + ' HTTP/1.1\r\n' +
                   ''.join(k + ': ' + v + '\r\n' for k, v in pairs) + '\r\n').encode() + body
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=5) as sock:
            sock.sendall(request)
            sock.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(sock)
            response.begin()
            return response.status, dict(response.getheaders()), response.read()

    def test_malformed_requests_are_rejected_without_writes(self):
        self.start()
        target = '/api/kv?key=tasks:items:v1'
        base = [('Origin', self.origin), ('X-Everything-Request', '1'),
                ('If-Match', '"0"'), ('Content-Type', 'application/json')]
        for extra, expected in [([('Host', self.headers['Host'])], 403),
                                ([('Tailscale-User-Login', self.headers['Tailscale-User-Login'])], 403),
                                ([('Origin', self.origin)], 403),
                                ([('X-Everything-Request', '1')], 403),
                                ([('If-Match', '"0"')], 400),
                                ([('Content-Type', 'application/json')], 400),
                                ([('Content-Length', '2')], 400),
                                ([('Transfer-Encoding', 'chunked')], 400)]:
            with self.subTest(extra=extra):
                self.assertEqual(self.raw('PUT', target, base + [('Content-Length', '2')] + extra, b'{}')[0], expected)
        for value in (b'{}', b'[]', b'{"value":1}', b'{"value":"null","extra":0}',
                      b'{"value":"1","value":"2"}', b'{"value":"bad json"}',
                      b'{"value":"NaN"}', b'{"value":"{\\"x\\":1,\\"x\\":2}"}',
                      b'{"value":"\\ud800"}', b'\xff', b'{'):
            with self.subTest(value=value):
                self.assertEqual(self.mutate('PUT', target, value, headers={'Content-Type': 'application/json'})[0], 400)
        for length in ('-1', '+1', '1, 1', 'x', ''):
            self.assertEqual(self.raw('PUT', target, base + [('Content-Length', length)])[0], 400)
        self.assertEqual(self.raw('PUT', target, base)[0], 400)
        self.assertEqual(self.raw('PUT', target, base + [('Content-Length', '20')], b'{}')[0], 400)
        self.assertEqual(self.mutate('PUT', target, b'{"value":"0"}')[0], 415)
        self.assertEqual(self.request('GET', target, b'x')[0], 400)
        self.assertEqual(self.mutate('DELETE', target, b'x')[0], 400)
        for route in (target + '&key=tasks:items:v1', target + '&extra=1', '/api/session?extra=1',
                      '/api/kv?key=%ff', '/api/kv?key=%xx', '/api/session#fragment'):
            self.assertEqual(self.request('GET', route)[0], 400)
        for method, route in [('PUT', '/api/session'), ('PUT', '/'), ('POST', target), ('OPTIONS', target)]:
            self.assertEqual(self.mutate(method, route, b'')[0], 405)
        self.assertEqual(self.request('GET', target)[1]['ETag'], '"0"')

    def test_upload_limits_before_body_read(self):
        for app, target, limit in (
                ('expense', '/api/file?path=expenses-data/receipts/limit.bin', 10 * 1024 * 1024),
                ('time-tracking', '/api/file?path=hourly-data/logo-123.png', 32 * 1024 * 1024),
                ('tasks', '/api/kv?key=tasks:items:v1', 8 * 1024 * 1024)):
            self.start(app)
            headers = [('Origin', self.origin), ('X-Everything-Request', '1'),
                       ('If-Match', '"0"'), ('Content-Type', 'application/json')]
            for size in (str(limit + 1), '9' * 5000):
                self.assertEqual(self.raw('PUT', target, headers + [('Content-Length', size)])[0], 413)
            if '/file?' in target:
                payload = b'\x00' * limit
                self.assertEqual(self.mutate('PUT', target, payload)[0], 200)
                stat_body = json.loads(self.request('GET', target + '&stat=1')[2])
                self.assertEqual(stat_body['size'], limit)
                del payload

    def test_receipt_identifiers_cannot_be_reused(self):
        self.start('expense')
        target = '/api/file?path=expenses-data/receipts/immutable.pdf'
        self.assertEqual(self.mutate('PUT', target, b'original')[0], 200)
        self.assertEqual(self.mutate('PUT', target, b'replacement', '"1"')[0], 409)
        self.assertEqual(self.request('GET', target)[2], b'original')
        self.assertEqual(self.mutate('DELETE', target, revision='"1"')[0], 200)
        self.assertEqual(self.mutate('PUT', target, b'replacement', '"2"')[0], 409)
        self.assertEqual(self.request('GET', target)[0], 404)

    def transaction(self, operations, key='test-transaction', **kwargs):
        return self.mutate('POST', '/api/transaction',
                           {'idempotencyKey': key, 'operations': operations}, revision=None, **kwargs)

    def test_transaction_is_atomic_across_kv_files_and_sqlite_failure(self):
        server = self.start()
        operations = [
            {'kind': 'kv', 'key': 'tasks:items:v1', 'method': 'PUT', 'ifMatch': '"0"', 'value': '[1]'},
            {'kind': 'file', 'path': 'tasks-data/log-2026-11.json', 'method': 'PUT', 'ifMatch': '"0"', 'value': 'héllo'}]
        status, _, body = self.transaction(operations)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'ok': True, 'revisions': [
            {'kind': 'kv', 'key': 'tasks:items:v1', 'etag': '"1"'},
            {'kind': 'file', 'path': 'tasks-data/log-2026-11.json', 'etag': '"1"'}]})
        self.assertEqual(self.request('GET', '/api/file?path=tasks-data/log-2026-11.json')[2], 'héllo'.encode())
        operations[0].update(ifMatch='"1"', value='[2]')
        operations[1].update(value='changed')
        self.assertEqual(self.transaction(operations, 'stale')[0], 409)
        self.assertEqual(json.loads(self.request('GET', '/api/kv?key=tasks:items:v1')[2])['value'], '[1]')
        operations[1]['ifMatch'] = '"1"'
        with closing(server.store.connect()) as db:
            db.execute("CREATE TRIGGER fail_file BEFORE UPDATE ON resources WHEN NEW.kind='file' BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
        status, _, body = self.transaction(operations, 'db-failure')
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body)['code'], 'STORAGE_ERROR')
        self.assertEqual(self.request('GET', '/api/kv?key=tasks:items:v1')[1]['ETag'], '"1"')
        with closing(server.store.connect()) as db:
            db.execute('DROP TRIGGER fail_file')
        self.assertEqual(self.transaction(operations, 'db-failure')[0], 200)
        deleted = [{k: v for k, v in op.items() if k != 'value'} for op in operations]
        for op in deleted:
            op.update(method='DELETE', ifMatch='"2"')
        self.assertEqual(self.transaction(deleted, 'delete')[0], 200)
        self.assertEqual(self.request('GET', '/api/file?path=tasks-data/log-2026-11.json')[1]['ETag'], '"3"')
        self.assertEqual(json.loads(self.request('GET', '/api/kv?key=tasks:items:v1')[2])['value'], None)

    def test_transaction_validates_entire_batch_before_writes(self):
        self.start()
        good = {'kind': 'kv', 'key': 'tasks:items:v1', 'method': 'PUT', 'ifMatch': '"0"', 'value': '[]'}
        invalid = [dict(good, key='unknown'), dict(good, kind='other'), dict(good, method='GET'),
                   dict(good, extra=True), dict(good, value=[]), dict(good, value='not json'),
                   dict(good, ifMatch=0), dict(good, ifMatch='*'),
                   dict(good, method='DELETE'), {'kind': 'kv', 'key': 'tasks:lists:v1', 'method': 'PUT', 'ifMatch': '"0"'},
                   {'kind': 'file', 'path': '../outside', 'method': 'PUT', 'ifMatch': '"0"', 'value': 'x'},
                   {'kind': 'file', 'path': 'tasks-data/log-2026-11.json', 'method': 'PUT', 'ifMatch': '"0"', 'value': '\ud800'},
                   None, [], 'x']
        for bad in invalid:
            with self.subTest(bad=bad):
                self.assertEqual(self.transaction([good, bad])[0], 400)
                self.assertEqual(self.request('GET', '/api/kv?key=tasks:items:v1')[1]['ETag'], '"0"')
        for ops in ([], [good, dict(good)], [good] * 513, {}, None):
            self.assertEqual(self.transaction(ops)[0], 400)
        for key in ('', 'a' * 129, 'contains space', '../bad', 'é', '\n', 123, None):
            self.assertEqual(self.transaction([good], key)[0], 400)
        for body in ({}, [], {'idempotencyKey': 'x', 'operations': [good], 'extra': 1}):
            self.assertEqual(self.mutate('POST', '/api/transaction', body, revision=None)[0], 400)
        self.assertEqual(self.transaction([good], headers={'If-Match': '"0"'})[0], 400)
        headers = [('Origin', self.origin), ('X-Everything-Request', '1'),
                   ('Content-Type', 'application/json'), ('Content-Length', str(8 * 1024 * 1024 + 1))]
        self.assertEqual(self.raw('POST', '/api/transaction', headers)[0], 413)
        self.assertEqual(self.transaction([good])[0], 200)
        self.assertEqual(self.request('GET', '/api/kv?key=tasks:items:v1')[1]['ETag'], '"1"')

    def test_idempotency_is_durable_canonical_and_concurrent(self):
        server = self.start()
        ops = [{'kind': 'kv', 'key': 'tasks:items:v1', 'method': 'PUT', 'ifMatch': '"0"', 'value': '[1]'},
               {'kind': 'kv', 'key': 'tasks:lists:v1', 'method': 'PUT', 'ifMatch': '"0"', 'value': '[2]'}]
        first = self.transaction(ops, 'durable-replay')
        self.assertEqual(first[0], 200)
        self.assertEqual(self.transaction(ops, 'durable-replay')[0:3:2], first[0:3:2])
        reordered = [dict(reversed(list(op.items()))) for op in ops]
        self.assertEqual(self.transaction(reordered, 'durable-replay')[2], first[2])
        changed = [dict(ops[0], value='[9]'), ops[1]]
        status, _, body = self.transaction(changed, 'durable-replay')
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)['code'], 'IDEMPOTENCY_MISMATCH')
        self.start(data=server.store.data_dir)
        self.assertEqual(self.transaction(ops, 'durable-replay')[2], first[2])
        for op in ops:
            op['ifMatch'] = '"1"'
        barrier = threading.Barrier(6)
        def replay(i):
            barrier.wait()
            return self.transaction(ops, 'concurrent-replay')
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(replay, range(6)))
        self.assertEqual([r[0] for r in results], [200] * 6)
        self.assertTrue(all(r[2] == results[0][2] for r in results))
        self.assertEqual(self.request('GET', '/api/kv?key=tasks:items:v1')[1]['ETag'], '"2"')
        self.assertEqual(self.transaction(reordered, 'durable-replay')[2], first[2])
        # Competing distinct requests may not partially update the batch.
        for op in ops:
            op['ifMatch'] = '"2"'
        barrier = threading.Barrier(6)
        def compete(i):
            barrier.wait()
            return self.transaction([dict(op, value=json.dumps(i)) for op in ops], 'compete-' + str(i))[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            statuses = list(pool.map(compete, range(6)))
        self.assertEqual(sorted(statuses), [200] + [409] * 5)
        a = self.request('GET', '/api/kv?key=tasks:items:v1')
        b = self.request('GET', '/api/kv?key=tasks:lists:v1')
        self.assertEqual(a[1]['ETag'], '"3"')
        self.assertEqual(a[2], b[2])

    def test_configuration_rejects_nonloopback_source_data_and_symlinks(self):
        from private_storage.server import Config, create_server
        config = dict(app='tasks', dist=self.dist, data_dir=self.base / 'data',
                      origin=self.origin, allowed_login_file=self.owner, host='127.0.0.1', port=0)
        invalid = [dict(host=h) for h in ('0.0.0.0', '192.168.1.20', '::', 'localhost')]
        invalid += [dict(app='unknown'), dict(app='../escape'), dict(dist=ROOT), dict(dist=ROOT / 'src/tasks'),
                    dict(data_dir=self.dist / 'data'), dict(data_dir=ROOT / 'private_storage/test-data'),
                    dict(data_dir=self.base), dict(dist=Path('dist-private')), dict(data_dir=Path('relative')),
                    dict(allowed_login_file=self.dist / 'owner')]
        invalid += [dict(origin=o) for o in ('http://example.test', 'https://example.test/',
                     'https://user@example.test', 'https://example.test?x', 'https://example.test:bad',
                     'https://example.test#x', 'https://example.test\n')]
        from unittest.mock import patch
        for override in invalid:
            with self.subTest(config=override), patch('private_storage.server.PrivateServer',
                    side_effect=AssertionError('invalid configuration reached socket creation')):
                with self.assertRaises((ValueError, OSError)):
                    create_server(Config(**dict(config, **override)))
        data_link = self.base / 'linked-data'
        data_link.symlink_to(self.base / 'actual-data', target_is_directory=True)
        (self.base / 'actual-data').mkdir()
        nested_link = data_link / 'nested'
        for data in (data_link, nested_link):
            with self.assertRaises((ValueError, OSError)):
                server = create_server(Config(**dict(config, data_dir=data)))
                server.server_close()
        real_data = self.base / 'db-symlink'
        real_data.mkdir()
        victim = self.base / 'victim'
        victim.write_text('untouched')
        for suffix in ('', '-wal', '-shm'):
            link = real_data / ('tasks.sqlite3' + suffix)
            link.symlink_to(victim)
            with self.assertRaises((ValueError, OSError)):
                server = create_server(Config(**dict(config, data_dir=real_data)))
                server.server_close()
            link.unlink()
        self.assertEqual(victim.read_text(), 'untouched')
        self.owner.write_text('one\ntwo\n')
        with self.assertRaises(ValueError):
            server = create_server(Config(**config))
            server.server_close()

    def test_cli_is_loopback_only_and_serves_real_requests(self):
        from private_storage.server import create_server, Config
        # Validation already protects the binding boundary; subprocess tests exercise the actual CLI.
        base = [sys.executable, str(ROOT / 'private_storage/server.py'), '--app', 'tasks',
                '--dist', str(self.dist), '--data-dir', str(self.base / 'cli-data'),
                '--origin', self.origin, '--allowed-login-file', str(self.owner), '--port', '0']
        result = subprocess.run(base + ['--host', '0.0.0.0'], capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Listening', result.stdout)
        self.assertFalse((self.base / 'cli-data').exists())
        process = subprocess.Popen(base + ['--host', '127.0.0.1'], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            import select
            self.assertTrue(select.select([process.stdout], [], [], 5)[0], 'CLI readiness timed out')
            line = process.stdout.readline().strip()
            self.assertRegex(line, r'^Listening on 127\.0\.0\.1:[0-9]+$')
            port = int(line.rsplit(':', 1)[1])
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            try:
                conn.request('GET', '/api/session', headers=self.headers)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['app'], 'tasks')
            finally:
                conn.close()
        finally:
            process.terminate()
            process.communicate(timeout=5)
        self.assertTrue((self.base / 'cli-data/tasks.sqlite3').is_file())

    def test_backup_cli_retention_and_isolated_restore_preserve_idempotency(self):
        server = self.start('expense')
        ops = [{'kind': 'kv', 'key': 'exp:months:v1', 'method': 'PUT', 'ifMatch': '"0"', 'value': '["2026-11"]'},
               {'kind': 'file', 'path': 'expenses-data/exp-2026-11.json', 'method': 'PUT', 'ifMatch': '"0"', 'value': '[]'}]
        original = self.transaction(ops, 'backup-replay')
        receipt = '/api/file?path=expenses-data/receipts/backup.bin'
        self.assertEqual(self.mutate('PUT', receipt, b'\x00\xffreceipt')[0], 200)
        deleted = '/api/kv?key=exp:categories:v1'
        self.assertEqual(self.mutate('DELETE', deleted)[0], 200)
        command = [sys.executable, str(ROOT / 'private_storage/server.py'), '--app', 'expense',
                   '--data-dir', str(server.store.data_dir), '--backup']
        # Keep a WAL connection open; backups must include committed WAL pages.
        with closing(server.store.connect()) as live:
            live.execute('PRAGMA wal_autocheckpoint=0')
            self.assertEqual(self.mutate('PUT', '/api/kv?key=exp:settings:v1', {'value': '{"wal":true}'})[0], 200)
            for _ in range(8):
                result = subprocess.run(command, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                snapshot = Path(result.stdout.strip())
                self.assertTrue(snapshot.is_file())
                self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        backups = server.store.data_dir / 'backups'
        self.assertEqual(backups.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len(list(backups.glob('expense-backup-*.sqlite3'))), 7)
        unrelated = backups / 'unrelated.txt'
        unrelated.write_text('preserved')
        result = subprocess.run(command + ['--retain', '2'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        snapshot = Path(result.stdout.strip())
        self.assertEqual(len(list(backups.glob('expense-backup-*.sqlite3'))), 2)
        self.assertEqual(unrelated.read_text(), 'preserved')
        with closing(sqlite3.connect(snapshot)) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
        restored = self.base / 'isolated-restore'
        restored.mkdir(mode=0o700)
        shutil.copyfile(snapshot, restored / 'expense.sqlite3')
        self.start('expense', restored)
        self.assertEqual(self.request('GET', receipt)[2], b'\x00\xffreceipt')
        self.assertEqual(self.request('GET', deleted)[1]['ETag'], '"1"')
        self.assertEqual(json.loads(self.request('GET', '/api/kv?key=exp:settings:v1')[2])['value'], '{"wal":true}')
        replay = self.transaction(ops, 'backup-replay')
        self.assertEqual(replay[0:3:2], original[0:3:2])
        self.assertEqual(self.request('GET', '/api/kv?key=exp:months:v1')[1]['ETag'], '"1"')
        self.assertNotEqual(restored, server.store.data_dir)
        self.assertNotEqual(subprocess.run(command + ['--retain', '0'], capture_output=True, timeout=5).returncode, 0)

    def test_static_root_remains_pinned_after_directory_replacement(self):
        self.start()
        original = self.base / 'original-build'
        self.dist.rename(original)
        self.dist.mkdir()
        (self.dist / 'index.html').write_text('replacement source must not be served')
        self.assertEqual(self.request('GET', '/')[2], b'<h1>Private</h1>')

    def test_partial_upload_has_bounded_timeout(self):
        server = self.start()
        server.request_timeout = 0.05
        headers = dict(self.headers, **{'Origin': self.origin, 'X-Everything-Request': '1',
                                       'If-Match': '"0"', 'Content-Length': '20',
                                       'Content-Type': 'application/json'})
        wire = ('PUT /api/kv?key=tasks:items:v1 HTTP/1.1\r\n' +
                ''.join(k + ': ' + v + '\r\n' for k, v in headers.items()) + '\r\n{').encode()
        with socket.create_connection(('127.0.0.1', server.server_port), timeout=0.5) as sock:
            sock.sendall(wire)
            response = http.client.HTTPResponse(sock)
            try:
                response.begin()
                status = response.status
                response.read()
            except TimeoutError:
                status = None
            finally:
                response.close()
        self.assertEqual(status, 408, 'server must bound incomplete body reads')
        self.assertEqual(self.request('GET', '/api/kv?key=tasks:items:v1')[1]['ETag'], '"0"')

    def test_ambiguous_headers_and_request_targets_are_rejected(self):
        self.start()
        for headers in ([('X-Test', 'one'), ('x-test', 'two')],
                        [('If-Match', '"0"'), ('If-Match', '"1"')],
                        [('X-Test', 'one\r\n folded')]):
            self.assertEqual(self.raw('GET', '/api/session', headers)[0], 400)
        for target in ('//api/session', 'https://private.example.test:18900/api/session', '/api/session?x'):
            self.assertEqual(self.raw('GET', target)[0], 400)
        self.assertEqual(self.request('GET', '/api/session')[0], 200)

    def test_backup_safety_and_concurrent_retention(self):
        from private_storage.server import backup_database
        server = self.start()
        self.assertEqual(self.mutate('PUT', '/api/kv?key=tasks:items:v1', {'value': '[1]'})[0], 200)
        data = server.store.data_dir
        outside = self.base / 'outside-backup'
        outside.mkdir()
        (data / 'backups').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            backup_database(data, 'tasks')
        self.assertEqual(list(outside.iterdir()), [])
        (data / 'backups').unlink()
        first = backup_database(data, 'tasks', retain=2)
        victim = self.base / 'keep.sqlite3'
        victim.write_bytes(b'unchanged')
        suspicious = data / 'backups' / ('tasks-backup-20000101T000000000000Z-' + 'a' * 32 + '.sqlite3')
        suspicious.symlink_to(victim)
        hardlink = data / 'backups' / ('tasks-backup-20000101T000000000000Z-' + 'b' * 32 + '.sqlite3')
        os.link(victim, hardlink)
        barrier = threading.Barrier(4)
        def backup(i):
            barrier.wait()
            return backup_database(data, 'tasks', retain=2)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            completed = list(pool.map(backup, range(4)))
        normal = [p for p in (data / 'backups').iterdir()
                  if not p.is_symlink() and p.stat().st_nlink == 1]
        self.assertEqual(len(normal), 2)
        self.assertTrue(suspicious.is_symlink())
        self.assertEqual(victim.read_bytes(), b'unchanged')
        self.assertTrue(hardlink.is_file())
        self.assertEqual(len(set(completed)), 4)
        self.assertFalse(first.exists())
        for p in normal:
            with closing(sqlite3.connect(p)) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        linked_data = self.base / 'linked-backup-source'
        linked_data.symlink_to(data, target_is_directory=True)
        with self.assertRaises(ValueError):
            backup_database(linked_data, 'tasks')
        with self.assertRaises((ValueError, OSError)):
            backup_database(self.base / 'missing', 'tasks')

    def test_single_resource_and_transaction_writes_share_atomic_cas(self):
        self.start()
        target = '/api/kv?key=tasks:items:v1'
        ops = [{'kind': 'kv', 'key': 'tasks:items:v1', 'method': 'PUT', 'ifMatch': '"0"', 'value': '"transaction"'},
               {'kind': 'kv', 'key': 'tasks:lists:v1', 'method': 'PUT', 'ifMatch': '"0"', 'value': '[]'}]
        barrier = threading.Barrier(6)
        def compete(i):
            barrier.wait()
            if i % 2:
                return self.transaction(ops, 'mixed-' + str(i))[0]
            return self.mutate('PUT', target, {'value': '"single"'})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            statuses = list(pool.map(compete, range(6)))
        self.assertEqual(sorted(statuses), [200] + [409] * 5)
        status, headers, body = self.request('GET', target)
        self.assertEqual(headers['ETag'], '"1"')
        lists = self.request('GET', '/api/kv?key=tasks:lists:v1')
        self.assertEqual(lists[1]['ETag'], '"1"' if json.loads(body)['value'] == '"transaction"' else '"0"')

    def test_transaction_accepts_exactly_512_operations_and_receipt_guard(self):
        self.start('expense')
        ops = [{'kind': 'file', 'path': 'expenses-data/receipts/batch-' + str(i) + '.bin',
                'method': 'PUT', 'ifMatch': '"0"', 'value': 'x'} for i in range(512)]
        status, _, body = self.transaction(ops, 'batch512')
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)['revisions']), 512)
        listing = self.request('GET', '/api/files?prefix=expenses-data/receipts/')
        self.assertEqual(len(json.loads(listing[2])['files']), 512)
        self.assertEqual(self.transaction([dict(ops[0], ifMatch='"1"', value='y')], 'replace')[0], 409)
        self.assertEqual(self.transaction(ops, 'batch512')[2], body)

    def test_authenticated_navigation_from_private_hub_is_allowed(self):
        self.start()
        self.assertEqual(self.request('GET', '/', headers={'Sec-Fetch-Site': 'same-site'})[0], 200)
        self.assertEqual(self.request('GET', '/api/session', headers={'Sec-Fetch-Site': 'same-site'})[0], 403)
        self.assertEqual(self.request('GET', '/', headers={'Sec-Fetch-Site': 'same-site',
                                                        'Tailscale-User-Login': 'other'})[0], 403)

    def test_private_worker_retirement_url_is_served_without_cache(self):
        (self.dist / 'sw.js').write_text('/* private network-only worker */')
        self.start()
        status, headers, body = self.request('GET', '/sw.js?private=1')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'/* private network-only worker */')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        for route in ('/sw.js?private=0', '/sw.js?private=1&extra=1', '/?private=1'):
            self.assertEqual(self.request('GET', route)[0], 400)


if __name__ == '__main__':
    unittest.main()
