"""Second-batch policy contracts through real isolated HTTP/SQLite fixtures.

Reuse the first-batch fixture helpers, not its test methods. All databases and
CLI processes are disposable test instances; no deployed services are touched.
"""
from contextlib import closing
import http.client
import json
from pathlib import Path
import select
import shutil
import sqlite3
import subprocess
import sys
import unittest
from urllib.parse import urlencode

from private_storage import policies
from private_storage.tests import test_server as fixtures


SECOND_BATCH = {
    'solitaire': 'solitaire:state:v1',
    'sudoku': 'sudoku:state:v1',
    'contacts': 'contacts:book:v1',
}
FIRST_BATCH = {
    'expense': frozenset(('exp:settings:v1', 'exp:categories:v1', 'exp:months:v1')),
    'time-tracking': frozenset('hourly:' + name + ':v1' for name in (
        'settings', 'clients', 'projects', 'months', 'timer', 'backups', 'invoices')),
    'tasks': frozenset(('tasks:settings:v1', 'tasks:lists:v1', 'tasks:items:v1')),
}


class SecondBatchContract:
    # Bind only real fixture helpers; inheriting ServerTests would rerun/count
    # the entire first-batch suite for each app rather than test this contract.
    start = fixtures.ServerTests.start
    request = fixtures.ServerTests.request
    mutate = fixtures.ServerTests.mutate
    transaction = fixtures.ServerTests.transaction
    raw = fixtures.ServerTests.raw

    def setUp(self):
        fixtures.ServerTests.setUp(self)
        self.key = SECOND_BATCH[self.app]
        self.target = '/api/kv?' + urlencode({'key': self.key})
        self.assertIn(self.app, policies.KV_KEYS, 'second-batch app must be explicitly allowed')
        self.start(self.app)

    def assert_document(self, value, revision):
        status, headers, body = self.request('GET', self.target)
        self.assertEqual(status, 200)
        self.assertEqual(headers['ETag'], revision)
        self.assertEqual(json.loads(body), {'value': value})

    def operation(self, value='{}', revision='"0"'):
        return {'kind': 'kv', 'key': self.key, 'method': 'PUT',
                'ifMatch': revision, 'value': value}

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(fixtures.ROOT / 'private_storage/server.py'), *args],
            capture_output=True, text=True, timeout=10)

    def test_exact_native_document_policy_and_http(self):
        self.assertEqual(policies.KV_KEYS[self.app], frozenset((self.key,)))
        self.assertTrue(policies.valid_key(self.app, self.key))
        for app, keys in FIRST_BATCH.items():
            self.assertEqual(policies.KV_KEYS[app], keys)
        for bad in (None, [], {}, 1, True):
            with self.subTest(bad=bad):
                self.assertFalse(policies.valid_key(self.app, bad))
                self.assertFalse(policies.valid_file(self.app, bad))
                self.assertFalse(policies.valid_prefix(self.app, bad))
        self.assert_document(None, '"0"')
        native = {'version': 1, 'app': self.app, 'items': [None, False, 0, 'é😀']}
        wire = json.dumps(native, ensure_ascii=False)
        status, headers, body = self.mutate('PUT', self.target, {'value': wire})
        self.assertEqual((status, json.loads(body)), (200, {'ok': True}))
        self.assertEqual(headers['ETag'], '"1"')
        self.assert_document(wire, '"1"')
        self.assertEqual(json.loads(json.loads(self.request('GET', self.target)[2])['value']), native)

    def test_identity_host_origin_and_app_separation(self):
        status, _, body = self.request('GET', '/api/session')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'username': 'Jetson storage', 'uuid': 'jetson-owner',
                                          'storage': 'jetson', 'app': self.app})
        for target in ('/', '/api/session', self.target):
            for headers in ({'Tailscale-User-Login': 'other@example.test'},
                            {'Host': 'other.example.test'}, {'Origin': 'https://other.example.test'}):
                with self.subTest(target=target, headers=headers):
                    self.assertEqual(self.request('GET', target, headers=headers)[0], 403)
        original_headers = self.headers
        try:
            self.headers = {'Host': original_headers['Host']}
            self.assertEqual(self.request('GET', '/api/session')[0], 403)
        finally:
            self.headers = original_headers
        for header in ('Host', 'Tailscale-User-Login'):
            self.assertEqual(self.raw('GET', '/api/session', [(header, self.headers[header])])[0], 403)
        for headers in ({'Tailscale-User-Login': 'other@example.test'},
                        {'Origin': 'https://other.example.test'}, {'X-Everything-Request': '0'}):
            self.assertEqual(self.mutate('PUT', self.target, {'value': '{}'}, headers=headers)[0], 403)
        self.assertEqual(self.request('PUT', self.target, {'value': '{}'}, {'If-Match': '"0"'})[0], 403)
        self.assertEqual(self.request('GET', self.target, headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assert_document(None, '"0"')

    def test_foreign_and_near_match_keys_are_denied_on_every_method(self):
        foreign = set(SECOND_BATCH.values()) - {self.key}
        foreign.update(key for keys in FIRST_BATCH.values() for key in keys)
        invalid = sorted(foreign) + [self.key.upper(), self.key + ' ', ' ' + self.key,
                                    self.key + ':extra', self.key.replace(':v1', ':v2'),
                                    self.key + '\x00', self.key + '\n', '', '../' + self.key]
        for key in invalid:
            with self.subTest(key=key):
                self.assertFalse(policies.valid_key(self.app, key))
                target = '/api/kv?' + urlencode({'key': key})
                self.assertEqual(self.request('GET', target)[0], 400)
                self.assertEqual(self.request('HEAD', target)[0], 400)
                self.assertEqual(self.mutate('PUT', target, {'value': '{}'})[0], 400)
                self.assertEqual(self.mutate('DELETE', target)[0], 400)
        self.assert_document(None, '"0"')

    def test_files_stats_and_listings_are_never_permitted(self):
        paths = [self.key, self.app + '-data/state.json', 'contacts/avatar.png',
                 'expenses-data/exp-2026-11.json', 'expenses-data/receipts/photo.png',
                 'hourly-data/backups/backup-2026-11-08.json', 'hourly-data/logo-123.png',
                 'tasks-data/log-2026-11.json', '', '../secret', '/etc/passwd']
        for path in paths:
            with self.subTest(path=path):
                self.assertFalse(policies.valid_file(self.app, path))
                target = '/api/file?' + urlencode({'path': path})
                self.assertEqual(self.request('GET', target)[0], 400)
                self.assertEqual(self.request('HEAD', target)[0], 400)
                self.assertEqual(self.request('GET', target + '&stat=1')[0], 400)
                self.assertEqual(self.mutate('PUT', target, b'file')[0], 400)
                self.assertEqual(self.mutate('DELETE', target)[0], 400)
        for prefix in ('', '/', self.app + '-data/', 'contacts/',
                       'expenses-data/receipts/', 'hourly-data/backups/', 'tasks-data/'):
            with self.subTest(prefix=prefix):
                self.assertFalse(policies.valid_prefix(self.app, prefix))
                target = '/api/files?' + urlencode({'prefix': prefix})
                self.assertEqual(self.request('GET', target)[0], 400)
                self.assertEqual(self.request('HEAD', target)[0], 400)
        with closing(self.server.store.connect()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM resources').fetchone()[0], 0)

    def test_serialized_wire_values_preserve_native_json_types(self):
        values = [{'version': 1, 'id': '0001', 'nested': [True, None, '雪']},
                  [1, False, {'text': 'é😀'}], 'a native string', 0, 1.5, False, None]
        revision = '"0"'
        for index, native in enumerate(values, 1):
            with self.subTest(native=native):
                wire = json.dumps(native, ensure_ascii=False, separators=(',', ':'))
                status, headers, _ = self.mutate('PUT', self.target, {'value': wire}, revision)
                self.assertEqual(status, 200)
                revision = '"{}"'.format(index)
                self.assertEqual(headers['ETag'], revision)
                self.assert_document(wire, revision)
                decoded = json.loads(json.loads(self.request('GET', self.target)[2])['value'])
                self.assertEqual(decoded, native)
                self.assertIs(type(decoded), type(native))
        for invalid in ({}, [], 1, None, 'not JSON', 'NaN', '{"id":1,"id":2}'):
            with self.subTest(invalid=invalid):
                self.assertEqual(self.mutate('PUT', self.target, {'value': invalid}, revision)[0], 400)
                self.assert_document('null', revision)

    def test_stale_cas_delete_tombstone_and_required_precondition(self):
        self.assertEqual(self.mutate('PUT', self.target, {'value': '{}'}, revision=None)[0], 428)
        self.assertEqual(self.mutate('PUT', self.target, {'value': '{}'}, revision='*')[0], 400)
        self.assertEqual(self.mutate('PUT', self.target, {'value': '{"saved":true}'})[0], 200)
        for method in ('PUT', 'DELETE'):
            status, headers, body = self.mutate(method, self.target, {'value': '{}'} if method == 'PUT' else None)
            self.assertEqual(status, 409)
            self.assertEqual(headers['ETag'], '"1"')
            self.assertEqual(json.loads(body)['code'], 'CONFLICT')
            self.assert_document('{"saved":true}', '"1"')
        self.assertEqual(self.mutate('DELETE', self.target, revision='"1"')[0], 200)
        self.assert_document(None, '"2"')
        self.assertEqual(self.mutate('PUT', self.target, {'value': 'null'})[0], 409)
        self.assertEqual(self.mutate('PUT', self.target, {'value': 'null'}, '"2"')[0], 200)
        self.assert_document('null', '"3"')

    def test_single_operation_transaction_replay_mismatch_and_stale_cas(self):
        operation = self.operation('{"settled":true}')
        first = self.transaction([operation], 'single-document')
        self.assertEqual(first[0], 200)
        self.assertEqual(json.loads(first[2]), {'ok': True, 'revisions': [
            {'kind': 'kv', 'key': self.key, 'etag': '"1"'}]})
        self.assertEqual(self.transaction([operation], 'single-document')[0:3:2], first[0:3:2])
        self.assert_document(operation['value'], '"1"')
        status, _, body = self.transaction([dict(operation, value='[]')], 'single-document')
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)['code'], 'IDEMPOTENCY_MISMATCH')
        status, _, body = self.transaction([operation], 'stale-document')
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)['code'], 'CONFLICT')
        self.assert_document(operation['value'], '"1"')
        self.assertEqual(self.transaction([self.operation('[2]', '"1"')], 'next-document')[0], 200)
        # An old replay returns its original result, never rolls back newer data.
        self.assertEqual(self.transaction([operation], 'single-document')[0:3:2], first[0:3:2])
        self.assert_document('[2]', '"2"')
        deletion = {'kind': 'kv', 'key': self.key, 'method': 'DELETE', 'ifMatch': '"2"'}
        removed = self.transaction([deletion], 'delete-document')
        self.assertEqual(removed[0], 200)
        self.assertEqual(self.transaction([deletion], 'delete-document')[0:3:2], removed[0:3:2])
        self.assert_document(None, '"3"')

    def test_transaction_cannot_bypass_resource_policy(self):
        good = self.operation()
        foreign = sorted((set(SECOND_BATCH.values()) - {self.key}) |
                         {key for keys in FIRST_BATCH.values() for key in keys})
        forbidden = [dict(good, key=key) for key in foreign]
        forbidden += [{'kind': 'file', 'path': path, 'method': 'PUT', 'ifMatch': '"0"', 'value': '{}'}
                      for path in (self.app + '-data/state.json', 'expenses-data/receipts/id.png',
                                   'hourly-data/backups/backup-2026-11-08.json', 'tasks-data/log-2026-11.json')]
        for invalid in forbidden:
            for method in ('PUT', 'DELETE'):
                denied = dict(invalid, method=method)
                if method == 'DELETE':
                    denied.pop('value')
                for operations in ([denied], [good, denied]):
                    with self.subTest(operations=operations):
                        self.assertEqual(self.transaction(operations, 'denied-document')[0], 400)
                        self.assert_document(None, '"0"')
        self.assertEqual(self.transaction([good, good], 'duplicate-document')[0], 400)
        # Rejection did not reserve the idempotency key or partially write.
        self.assertEqual(self.transaction([good], 'denied-document')[0], 200)
        self.assert_document('{}', '"1"')

    def test_cli_backup_isolated_restore_preserves_revisions_and_replay(self):
        source = self.server
        operation = self.operation(json.dumps({'app': self.app, 'id': '0001', 'items': ['é', None]}))
        original = self.transaction([operation], 'backup-document')
        self.assertEqual(original[0], 200)
        command = ('--app', self.app, '--data-dir', str(source.store.data_dir), '--backup', '--retain', '1')
        # Hold a connection so the CLI backup must include committed WAL pages.
        with closing(source.store.connect()) as live:
            live.execute('PRAGMA wal_autocheckpoint=0')
            self.assertEqual(self.mutate('PUT', self.target, {'value': '["wal"]'}, '"1"')[0], 200)
            for _ in range(2):
                result = self.cli(*command)
                self.assertEqual(result.returncode, 0, result.stderr)
                snapshot = Path(result.stdout.strip())
                self.assertTrue(snapshot.is_file())
        self.assertEqual(list((source.store.data_dir / 'backups').glob(self.app + '-backup-*.sqlite3')), [snapshot])
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        with closing(sqlite3.connect(snapshot)) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
        self.assertEqual(self.mutate('DELETE', self.target, revision='"2"')[0], 200)
        restored = self.base / 'restored'
        restored.mkdir(mode=0o700)
        shutil.copyfile(snapshot, restored / (self.app + '.sqlite3'))
        self.start(self.app, restored)
        self.assert_document('["wal"]', '"2"')
        self.assertEqual(self.transaction([operation], 'backup-document')[0:3:2], original[0:3:2])
        self.assert_document('["wal"]', '"2"')
        self.assertEqual(self.mutate('PUT', self.target, {'value': '{}'}, '"1"')[0], 409)
        self.assertEqual(self.mutate('PUT', self.target, {'value': '{"restored":true}'}, '"2"')[0], 200)
        self.assert_document('{"restored":true}', '"3"')
        self.server = source
        self.assert_document(None, '"3"')

    def test_actual_cli_accepts_app_and_rejects_unknown_choices(self):
        data = self.base / 'cli-data'
        base = [sys.executable, str(fixtures.ROOT / 'private_storage/server.py'),
                '--app', self.app, '--data-dir', str(data), '--dist', str(self.dist),
                '--origin', self.origin, '--allowed-login-file', str(self.owner),
                '--host', '127.0.0.1', '--port', '0']
        process = subprocess.Popen(base, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 5)[0], 'CLI readiness timed out')
            line = process.stdout.readline().strip()
            self.assertRegex(line, r'^Listening on 127\.0\.0\.1:[0-9]+$')
            port = int(line.rsplit(':', 1)[1])
            with closing(http.client.HTTPConnection('127.0.0.1', port, timeout=5)) as conn:
                conn.request('GET', '/api/session', headers=self.headers)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['app'], self.app)
        finally:
            process.terminate()
            process.communicate(timeout=5)
        self.assertTrue((data / (self.app + '.sqlite3')).is_file())
        self.assertEqual(self.server.store.db_path.name, self.app + '.sqlite3')
        for invalid in ('unknown', self.app.upper(), self.app + ':state:v1'):
            denied_data = self.base / 'denied-cli'
            result = self.cli('--app', invalid, '--data-dir', str(denied_data), '--backup')
            self.assertEqual(result.returncode, 2)
            self.assertIn('invalid choice', result.stderr)
            self.assertFalse(denied_data.exists())


class SolitairePolicyTests(SecondBatchContract, unittest.TestCase):
    app = 'solitaire'


class SudokuPolicyTests(SecondBatchContract, unittest.TestCase):
    app = 'sudoku'


class ContactsPolicyTests(SecondBatchContract, unittest.TestCase):
    app = 'contacts'


if __name__ == '__main__':
    unittest.main()
