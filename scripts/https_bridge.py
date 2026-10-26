#!/usr/bin/env python3
import argparse
import hashlib
import http.client
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
ASSETS = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/app.bundle.js': ('app.bundle.js', 'text/javascript; charset=utf-8'),
    '/app.bundle.css': ('app.bundle.css', 'text/css; charset=utf-8'),
    '/metadata-v1.json': ('metadata-v1.json', 'application/json'),
    '/vendors.json': ('vendors.json', 'application/json'),
    '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json'),
    '/sw.js': ('sw.js', 'text/javascript; charset=utf-8'),
    **{f'/icons/nanoscope-{n}.png': (f'icons/nanoscope-{n}.png', 'image/png') for n in (180, 192, 512)},
}
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' http: https:; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"


def board_target(value):
    url = urlsplit(value)
    if url.scheme != 'http' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('Board target must be a fixed HTTP origin, for example http://nanoscope.local')
    if not url.port:
        return url.hostname, 80, url.netloc
    return url.hostname, url.port, url.netloc


def public_origin(value):
    url = urlsplit(value)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('Public origin must contain a scheme and host without a path')
    if url.scheme == 'http' and url.hostname not in ('localhost', '127.0.0.1'):
        raise ValueError('Remote app origins require HTTPS')
    return f'{url.scheme}://{url.netloc}'


class Bridge(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, board, origin, web=ROOT / 'web', allow_origins=()):
        self.board_host, self.board_port, self.board_authority = board_target(board)
        self.public_origin = public_origin(origin)
        self.api_origins = {self.public_origin, *(public_origin(value) for value in allow_origins)}
        self.web = Path(web)
        super().__init__(('127.0.0.1', port), Handler)
        self.allowed_hosts = {urlsplit(self.public_origin).netloc, f'127.0.0.1:{self.server_port}', f'localhost:{self.server_port}'}

    def build_id(self):
        digest = hashlib.sha256()
        for name, _ in sorted(ASSETS.values()):
            digest.update(name.encode())
            digest.update((self.web / name).read_bytes())
        return digest.hexdigest()[:16]


class Handler(BaseHTTPRequestHandler):
    server_version = 'NanoScopeBridge/1'

    def log_message(self, *_):
        pass

    def respond(self, status, body, content_type='application/json', api=False, preflight=False):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store' if api else 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Referrer-Policy', 'same-origin')
        if api and getattr(self, 'cors_origin', ''):
            self.send_header('Access-Control-Allow-Origin', self.cors_origin)
            self.send_header('Vary', 'Origin')
            if preflight:
                self.send_header('Access-Control-Allow-Methods', 'GET, POST')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type')
                self.send_header('Access-Control-Max-Age', '600')
        if self.path == '/sw.js':
            self.send_header('Service-Worker-Allowed', '/')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def error(self, status, message):
        self.respond(status, json.dumps({'error': message}).encode(), api=True)

    def dispatch(self):
        self.cors_origin = ''
        host = self.headers.get('Host', '')
        if host not in self.server.allowed_hosts:
            self.error(403, 'Unrecognized app host')
            return
        same_app_origins = {self.server.public_origin}
        if host.startswith(('127.0.0.1:', 'localhost:')):
            same_app_origins.add(f'http://{host}')
        origin = self.headers.get('Origin')
        if len(self.path) > 2048:
            self.error(414, 'Request path is too long')
            return
        parsed = urlsplit(self.path)
        if parsed.scheme or parsed.netloc or parsed.fragment:
            self.error(400, 'Expected a local app path')
            return
        api = bool(re.fullmatch(r'/api/[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*', parsed.path))
        allowed_api_origins = self.server.api_origins | same_app_origins
        if api:
            if origin and origin not in allowed_api_origins:
                self.error(403, 'This app origin is not allowed to use the board API')
                return
            if self.headers.get('Sec-Fetch-Site') == 'cross-site' and origin not in self.server.api_origins:
                self.error(403, 'This app origin is not allowed to use the board API')
                return
            if origin in allowed_api_origins:
                self.cors_origin = origin
            if self.command == 'OPTIONS':
                method = self.headers.get('Access-Control-Request-Method', '')
                requested = {value.strip().lower() for value in self.headers.get('Access-Control-Request-Headers', '').split(',') if value.strip()}
                if method not in ('GET', 'POST') or not requested.issubset({'content-type'}):
                    self.error(403, 'Unsupported board API preflight')
                    return
                self.respond(204, b'', api=True, preflight=True)
                return
            self.proxy()
        else:
            navigation = self.command in ('GET', 'HEAD') and parsed.path == '/' and self.headers.get('Sec-Fetch-Mode') == 'navigate'
            if (origin and origin not in same_app_origins) or self.headers.get('Sec-Fetch-Site') == 'cross-site' and not navigation:
                self.error(403, 'Open the Gattelier app directly')
                return
        if api:
            return
        if self.command in ('GET', 'HEAD') and parsed.path in ASSETS:
            try:
                filename, kind = ASSETS[parsed.path]
                body = (self.server.web / filename).read_bytes()
                if parsed.path == '/sw.js':
                    body = body.replace(b'__NANO_BUILD__', self.server.build_id().encode())
                self.respond(200, body, kind)
            except OSError:
                self.error(503, 'App assets are unavailable; run npm run build:web')
        else:
            self.error(404, 'Unknown app path')

    def proxy(self):
        if self.command not in ('GET', 'POST'):
            self.error(405, 'Expected GET or POST')
            return
        if self.headers.get('Transfer-Encoding'):
            self.error(400, 'Chunked requests are unsupported')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = -1
        if length < 0 or length > 4096:
            self.error(413, 'Request body exceeds 4096 bytes')
            return
        if self.command == 'POST' and self.headers.get_content_type() != 'application/json':
            self.error(415, 'Expected application/json')
            return
        if self.command == 'GET' and length:
            self.error(400, 'GET requests do not accept a body')
            return
        body = self.rfile.read(length) if length else None
        connection = http.client.HTTPConnection(self.server.board_host, self.server.board_port, timeout=12)
        try:
            headers = {'Host': self.server.board_authority, 'Origin': f'http://{self.server.board_authority}', 'Accept': 'application/json'}
            if self.command == 'POST':
                headers['Content-Type'] = 'application/json'
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                self.error(502, 'Board response exceeded the bridge limit')
            else:
                self.respond(response.status, data, response.getheader('Content-Type', 'application/json'), api=True)
        except (OSError, http.client.HTTPException) as error:
            print(f'Board connection failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
            self.error(503, 'Board unavailable. Saved app tools remain available; reconnect to retry.')
        finally:
            connection.close()

    do_GET = do_POST = do_HEAD = do_OPTIONS = do_PUT = do_DELETE = dispatch


def main():
    parser = argparse.ArgumentParser(description='Serve Gattelier to a private HTTPS reverse proxy')
    parser.add_argument('--board', default='http://nanoscope.local')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--public-origin', required=True)
    parser.add_argument('--allow-origin', action='append', default=[], help='Exact HTTPS app origin allowed to call the board API; repeat as needed')
    args = parser.parse_args()
    with Bridge(args.port, args.board, args.public_origin, allow_origins=args.allow_origin) as server:
        print(f'Gattelier bridge listening on 127.0.0.1:{server.server_port}', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
