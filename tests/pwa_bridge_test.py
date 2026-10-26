import importlib.util
import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('https_bridge', ROOT / 'scripts/https_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Board(BaseHTTPRequestHandler):
    def do_GET(self):
        self.do_POST()

    def do_POST(self):
        size = int(self.headers.get('Content-Length', 0))
        self.server.seen = {'path': self.path, 'origin': self.headers.get('Origin'), 'host': self.headers.get('Host'), 'body': self.rfile.read(size).decode()}
        payload = json.dumps(self.server.seen).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        web = Path(cls.folder.name)
        for name, _ in bridge.ASSETS.values():
            path = web / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('build=__NANO_BUILD__' if name == 'sw.js' else 'app asset')
        cls.board = ThreadingHTTPServer(('127.0.0.1', 0), Board)
        cls.board_url = f'http://127.0.0.1:{cls.board.server_port}'
        cls.allowed_origin = 'https://app.example'
        cls.app = bridge.Bridge(0, cls.board_url, 'https://nano.test:8443', web, [cls.allowed_origin])
        for server in (cls.board, cls.app):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.app, cls.board):
            server.shutdown()
            server.server_close()
        cls.folder.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.app.server_port, timeout=3)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_api_uses_fixed_board_and_exact_origin(self):
        status, headers, raw = self.request('POST', '/api/write', '{"handle":1,"hex":"01"}', {
            'Host': 'nano.test:8443', 'Origin': 'https://nano.test:8443', 'Content-Type': 'application/json'})
        self.assertEqual(status, 200)
        result = json.loads(raw)
        self.assertEqual(result['origin'], self.board_url)
        self.assertEqual(result['host'], self.board_url.removeprefix('http://'))
        self.assertEqual(result['path'], '/api/write')
        self.assertEqual(headers['Cache-Control'], 'no-store')

    def test_rejects_cross_origin_open_proxy_and_traversal(self):
        attempts = [('/api/scan', {'Origin': 'https://other.test'}),
                    ('/api/state', {'Host': 'other.test'}),
                    ('http://other.test/api/state', {}), ('/../../etc/passwd', {}),
                    ('//other.test/api/state', {})]
        for path, headers in attempts:
            with self.subTest(path=path, headers=headers):
                self.assertIn(self.request('GET', path, headers=headers)[0], (400, 403, 404))

    def test_exact_allowed_origin_receives_cors_for_api_responses_and_errors(self):
        headers = {'Origin': self.allowed_origin, 'Sec-Fetch-Site': 'cross-site'}
        status, response_headers, body = self.request('GET', '/api/state', headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(response_headers['Access-Control-Allow-Origin'], self.allowed_origin)
        self.assertEqual(json.loads(body)['origin'], self.board_url)
        status, response_headers, _ = self.request('POST', '/api/write', '{}', headers)
        self.assertEqual(status, 415)
        self.assertEqual(response_headers['Access-Control-Allow-Origin'], self.allowed_origin)

    def test_preflight_uses_exact_allowlist_without_credentials_or_wildcard(self):
        headers = {'Origin': self.allowed_origin, 'Sec-Fetch-Site': 'cross-site',
                   'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'}
        status, response_headers, body = self.request('OPTIONS', '/api/write', headers=headers)
        self.assertEqual(status, 204)
        self.assertEqual(body, b'')
        self.assertEqual(response_headers['Access-Control-Allow-Origin'], self.allowed_origin)
        self.assertEqual(response_headers['Access-Control-Allow-Methods'], 'GET, POST')
        self.assertEqual(response_headers['Access-Control-Allow-Headers'], 'Content-Type')
        self.assertNotIn('Access-Control-Allow-Credentials', response_headers)
        self.assertNotIn('*', response_headers.values())

    def test_disallowed_preflight_has_no_cors_access(self):
        headers = {'Origin': 'https://other.test', 'Sec-Fetch-Site': 'cross-site',
                   'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'}
        status, response_headers, _ = self.request('OPTIONS', '/api/write', headers=headers)
        self.assertEqual(status, 403)
        self.assertNotIn('Access-Control-Allow-Origin', response_headers)

    def test_service_worker_version_changes_with_assets(self):
        status, headers, first = self.request('GET', '/sw.js')
        self.assertEqual(status, 200)
        self.assertNotIn(b'__NANO_BUILD__', first)
        self.assertEqual(headers['Service-Worker-Allowed'], '/')
        (self.app.web / 'app.bundle.js').write_text('changed asset')
        self.assertNotEqual(first, self.request('GET', '/sw.js')[2])

    def test_json_only_and_body_limit(self):
        self.assertEqual(self.request('POST', '/api/write', '{}')[0], 415)
        self.assertEqual(self.request('POST', '/api/write', 'x' * 4097, {'Content-Type': 'application/json'})[0], 413)

    def test_fixed_target_validation(self):
        for url in ('https://nano.test', 'http://user:secret@nano.test', 'http://nano.test/path', 'http://nano.test?target=other'):
            with self.assertRaises(ValueError):
                bridge.board_target(url)

    def test_nested_api_paths_forward_to_the_fixed_board(self):
        status, _, body = self.request('POST', '/api/network/hotspot-password', '{}', {'Content-Type': 'application/json'})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['path'], '/api/network/hotspot-password')

    def test_app_link_navigation_is_allowed_without_cross_site_api_access(self):
        headers = {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate'}
        self.assertEqual(self.request('GET', '/', headers=headers)[0], 200)
        self.assertEqual(self.request('GET', '/api/state', headers=headers)[0], 403)
        self.assertEqual(self.request('POST', '/api/scan', '{}', headers)[0], 403)


if __name__ == '__main__':
    unittest.main()
