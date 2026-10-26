import argparse
import base64
import json
import os
from pathlib import Path
import struct
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

ROOT = Path(__file__).resolve().parents[1]
ADDRESS = '02:88:10:00:00:01'
SERIAL = '8810000000000001'
FILE_ID = 1730000000
COMMAND, RESPONSE = 12, 15


def command(code, payload=b''):
    return struct.pack('<BH', 1, code) + payload


class Board:
    def __init__(self):
        self.started = time.monotonic()
        self.boot_id = os.urandom(8).hex()
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.signature = os.urandom(256)
        self.credentials = {
            'serial': SERIAL, 'userId': 'nanoscope-test',
            'privateKeyPem': self.key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(),
            'publicKeyPem': self.key.public_key().public_bytes(serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
            'signature': base64.b64encode(self.signature).decode(),
        }
        self.events = []
        self.connected = False
        self.subscription = 'off'
        self.scanning = True
        self.capture_address = ''
        self.parts = {}
        self.total = None
        self.session = None
        self.tx_sequence = self.rx_sequence = 1
        self.authenticated = False
        content_key, nonce = os.urandom(32), os.urandom(12)
        self.ogg = (ROOT / 'tests/fixtures/plaud-test.ogg').read_bytes()
        header = bytearray(512)
        header[:8] = b'PLAUD.AI'
        struct.pack_into('<HH', header, 8, 1, 512)
        struct.pack_into('<I', header, 128, 1)
        header[132:144] = nonce
        header[256:512] = self.key.public_key().encrypt(content_key, padding.PKCS1v15())
        cipher = Cipher(algorithms.ChaCha20(content_key, struct.pack('<I', 1) + nonce), mode=None).encryptor()
        self.recording = bytes(header) + cipher.update(self.ogg) + cipher.finalize()

    def save_credentials(self):
        path = ROOT / '.tools/plaud-test-credentials.json'
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(self.credentials, output)
        return path

    def milliseconds(self):
        return int((time.monotonic() - self.started) * 1000)

    def trace(self, kind, payload=b'', handle=0, message='', redacted=False):
        self.events.append({
            'seq': len(self.events) + 1, 'ms': self.milliseconds(), 'kind': kind,
            'address': ADDRESS, 'uuid': '0x2bb1' if handle == COMMAND else '0x2bb0' if handle == RESPONSE else '',
            'handle': handle, 'hex': '' if redacted else payload.hex(), 'length': len(payload),
            'success': True, 'truncated': False, 'redacted': redacted, 'message': message,
        })

    def notify(self, payload, encrypted=True):
        if self.subscription != 'notify':
            raise ValueError('Subscribe to PLAUD responses before sending commands')
        if encrypted:
            self.tx_sequence += 1
            payload = self.session.encrypt(self.nonce, struct.pack('<I', self.tx_sequence) + payload, self.aad)
        self.trace('notification', payload, RESPONSE)

    def state(self):
        manufacturer = bytearray(22)
        manufacturer[2], manufacturer[5], manufacturer[10] = 2, 4, 8
        struct.pack_into('<H', manufacturer, 3, 883)
        manufacturer[11:19] = bytes.fromhex(SERIAL)
        struct.pack_into('<H', manufacturer, 20, 20)
        characteristics = [
            {'uuid': '0x2bb1', 'handle': COMMAND, 'properties': ['write', 'write-no-response'], 'subscription': 'off', 'descriptors': []},
            {'uuid': '0x2bb0', 'handle': RESPONSE, 'properties': ['notify'], 'subscription': self.subscription,
             'descriptors': [{'uuid': '0x2902', 'handle': RESPONSE + 1}]},
        ]
        for item in characteristics:
            item.update(valueHex=None, valueText=None, readError='')
        return {
            'wifi': {'connected': True, 'ssid': 'PLAUD browser test', 'ip': '127.0.0.1'},
            'uptime': self.milliseconds() // 1000, 'freeHeap': 200000, 'scanCompleted': True,
            'ble': {'busy': False, 'connected': self.connected, 'scanning': self.scanning,
                    'scanEnabled': self.scanning, 'operation': 'Connected' if self.connected else 'Scanning',
                    'discoveryScope': 'All services', 'address': ADDRESS if self.connected else '',
                    'error': '', 'captureAddress': self.capture_address, 'mtu': 247},
            'devices': [{'id': 1, 'address': ADDRESS, 'name': 'PLAUD browser fixture', 'addressType': 0,
                         'rssi': -35, 'connectable': True, 'lastSeen': self.milliseconds(),
                         'manufacturer': manufacturer.hex(), 'payloadHex': (bytes([23, 255]) + manufacturer).hex(),
                         'advType': 0, 'txPower': None, 'services': ['0x1910'], 'serviceData': []}],
            'services': [{'uuid': '0x1910', 'characteristics': characteristics}] if self.connected else [],
        }

    def get(self, path, query):
        if path == '/api/state':
            return self.state()
        if path == '/api/events':
            after = int(parse_qs(query).get('after', ['0'])[0])
            if after < 0:
                raise ValueError('Invalid event cursor')
            return {'bootId': self.boot_id, 'oldestSeq': 1, 'nextSeq': len(self.events),
                    'events': [event for event in self.events if event['seq'] > after], 'dropped': 0}
        raise ValueError('Unknown API endpoint')

    def write(self, packet):
        if not self.connected:
            raise ValueError('Connect before writing')
        if packet[:2] == b'\x10\xfe':
            if not 5 <= len(packet) <= 104 or packet[2] != 3 or packet[3] >= 3:
                raise ValueError('Invalid signature chunk')
            total, index = packet[2:4]
            if self.total is not None and self.total != total:
                raise ValueError('Conflicting signature chunk total')
            if index in self.parts and self.parts[index] != packet[4:]:
                raise ValueError('Conflicting signature duplicate')
            self.total = total
            self.parts[index] = packet[4:]
            self.trace('write', packet, COMMAND, 'PLAUD authentication signature sent (redacted)', True)
            if len(self.parts) == total:
                if b''.join(self.parts[i] for i in range(total)) != self.signature:
                    raise ValueError('Signature does not match mock credentials')
                secret, self.nonce, self.aad = os.urandom(32), os.urandom(12), os.urandom(12)
                self.session = ChaCha20Poly1305(secret)
                wrapped = self.key.public_key().encrypt(secret + self.nonce + self.aad +
                    self.session.encrypt(self.nonce, b'PLAUD.AI', self.aad), padding.PKCS1v15())
                self.tx_sequence = self.rx_sequence = 1
                self.authenticated = False
                self.parts, self.total = {}, None
                for i in range(3):
                    self.notify(struct.pack('<HBB', 0xfe12, 3, i) + wrapped[i * 100:(i + 1) * 100], False)
            return
        if self.session is None:
            raise ValueError('Authenticate the mock signature first')
        plain = self.session.decrypt(self.nonce, packet, self.aad)
        if len(plain) < 7 or plain[4] != 1:
            raise ValueError('Invalid encrypted command')
        sequence, = struct.unpack_from('<I', plain)
        if sequence != self.rx_sequence + 1:
            raise ValueError('Unexpected encrypted command sequence')
        self.rx_sequence = sequence
        self.trace('write', packet, COMMAND)
        code, = struct.unpack_from('<H', plain, 5)
        body = plain[7:]
        if code == 1:
            expected = b'\x02\x00\x00' + self.credentials['userId'].encode().ljust(32, b'0')
            if body != expected:
                raise ValueError('Invalid encrypted handshake')
            self.authenticated = True
            self.notify(command(1, b'\x00' + struct.pack('<H', 20)))
        elif not self.authenticated:
            raise ValueError('Complete the encrypted handshake first')
        elif code == 26:
            if len(body) != 9 or body[4:] != b'\0' * 5:
                raise ValueError('Invalid recording-list request')
            self.notify(command(26, body[:4] + struct.pack('<HHIIBB', 1, 0, FILE_ID, len(self.recording), 0, 0)))
        elif code == 28:
            if len(body) != 12 or struct.unpack('<III', body) != (FILE_ID, 0, len(self.recording)):
                raise ValueError('Invalid recording download range')
            self.notify(command(28, struct.pack('<IB', FILE_ID, 0)))
            for offset in range(0, len(self.recording), 180):
                chunk = self.recording[offset:offset + 180]
                self.notify(struct.pack('<BIIB', 2, FILE_ID, offset, len(chunk)) + chunk)
            self.notify(struct.pack('<BIIB', 2, FILE_ID, 0xffffffff, 1))
            self.notify(command(29, struct.pack('<IH', FILE_ID, 0xffff)))
        elif code == 29:
            self.notify(command(30, b'\x00'))
        else:
            raise ValueError('Unsupported mock command')

    def post(self, path, body):
        if path == '/api/connect':
            if body.get('id') != 1:
                raise ValueError('Unknown mock device')
            self.connected = True
            self.trace('connect', message='Mock recorder connected')
        elif path == '/api/disconnect':
            self.connected, self.authenticated, self.subscription, self.session = False, False, 'off', None
            self.parts, self.total = {}, None
            self.trace('disconnect', message='Mock recorder disconnected')
        elif path == '/api/subscribe':
            if not self.connected or body.get('handle') != RESPONSE or body.get('mode') not in ('notify', 'off'):
                raise ValueError('Invalid mock subscription')
            self.subscription = body['mode']
            self.trace('subscribe', handle=RESPONSE, message=self.subscription)
        elif path == '/api/write':
            if body.get('handle') != COMMAND or not isinstance(body.get('response'), bool):
                raise ValueError('Invalid write arguments')
            self.write(bytes.fromhex(body['hex']))
        elif path in ('/api/scan', '/api/stop-scan'):
            self.scanning = path == '/api/scan'
        elif path == '/api/capture':
            self.capture_address = body['address']
        else:
            raise ValueError('Unknown API endpoint')
        return {'ok': True}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'web'), **kwargs)

    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        url = urlsplit(self.path)
        if not url.path.startswith('/api/'):
            return super().do_GET()
        try:
            self.send_json(200, self.server.board.get(url.path, url.query))
        except (ValueError, KeyError) as error:
            self.send_json(400, {'error': str(error)})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            self.send_json(202, self.server.board.post(urlsplit(self.path).path, body))
        except Exception as error:
            self.send_json(400, {'error': str(error) or type(error).__name__})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Local PLAUD browser integration fixture')
    parser.add_argument('--port', type=int, default=8290)
    options = parser.parse_args()
    board = Board()
    credentials_path = board.save_credentials()
    server = HTTPServer(('127.0.0.1', options.port), Handler)
    server.board = board
    print(f'Mock PLAUD board: http://127.0.0.1:{options.port}', flush=True)
    print(f'Test credentials: {credentials_path}', flush=True)
    server.serve_forever()
