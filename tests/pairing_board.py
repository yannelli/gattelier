import json
import mimetypes
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDRESS = '02:00:00:00:00:71'
started = time.monotonic()
security = dict(status='idle', active=False, address=ADDRESS, encrypted=False, authenticated=False, bonded=False, keySize=0, challengeId='', passkey=None, remainingMs=0, error='')
phase = 0
results = []
connected = True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, data, content='application/json'):
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', content)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/state':
            uptime = int(time.monotonic() - started)
            device = dict(id=1, address=ADDRESS, addressType=0, name='Pairing test peripheral', rssi=-44, connectable=True, lastSeen=uptime, services=['0x180f'], manufacturer='', payloadHex='', serviceData=[])
            self.send(200, dict(uptime=uptime, freeHeap=150000, wifi=dict(connected=True, ssid='Local test fixture', ip='127.0.0.1'), ble=dict(connected=connected, address=ADDRESS if connected else '', busy=False, scanning=False, scanEnabled=False, error='', mtu=23), security=security, devices=[device], services=[]))
        elif self.path.startswith('/api/events'):
            self.send(200, dict(bootId='pairing-fixture', events=[], nextSeq=0, dropped=0))
        elif self.path == '/api/network':
            self.send(200, dict(mode='station', connected=True, stationConnected=True, status='connected', ssid='Local fixture', configuredSSID='Local fixture', apSSID='Fixture', ip='127.0.0.1', apIP='192.168.4.1', passwordSet=True))
        else:
            name = 'index.html' if self.path == '/' else self.path.lstrip('/')
            if name not in ['index.html', 'app.bundle.js', 'app.bundle.css', 'vendors.json']:
                return self.send(404, dict(error='Not found'))
            path = ROOT / 'web' / name
            self.send(200, path.read_bytes(), mimetypes.guess_type(name)[0] or 'application/octet-stream')

    def do_POST(self):
        global phase, connected
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        if self.path == '/api/pair':
            phase += 1
            security.update(status=['passkey-input', 'numeric-comparison', 'passkey-display'][(phase-1) % 3], active=True, challengeId=f'{phase:024x}', remainingMs=30000, passkey=None if phase == 1 else '123456', error='')
        elif self.path == '/api/pairing-response':
            assert body['challengeId'] == security['challengeId'] and body['address'] == ADDRESS
            assert body.get('passkey') == '000123' if phase == 1 else body.get('accept') is True
            results.append('passkey-input' if phase == 1 else 'numeric-comparison')
            security.update(status='secured', active=False, encrypted=True, authenticated=True, bonded=True, keySize=16, challengeId='', passkey=None, remainingMs=0)
        elif self.path == '/api/pairing-cancel':
            assert body['challengeId'] == security['challengeId']
            results.append('cancel-display'); connected = False
            security.update(status='cancelled', active=False, encrypted=False, authenticated=False, bonded=False, keySize=0, challengeId='', passkey=None, remainingMs=0)
        elif self.path == '/api/disconnect':
            connected = False
        elif self.path == '/api/connect':
            connected = True
            security.update(status='idle', active=False, encrypted=False, authenticated=False, bonded=False, keySize=0, challengeId='', passkey=None, remainingMs=0)
        else:
            return self.send(404, dict(error='Unsupported test action'))
        (ROOT / 'artifacts/pairing-ui-results.json').write_text(json.dumps(dict(simulated=True, passed=results), indent=2))
        self.send(202, dict(ok=True))


print('Pairing UI fixture: http://127.0.0.1:8361 (simulated BLE)', flush=True)
HTTPServer(('127.0.0.1', 8361), Handler).serve_forever()
