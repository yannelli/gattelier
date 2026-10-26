import json
import os
import time
import urllib.error
import urllib.request
import serial

BASE = os.environ.get('NANOSCOPE_BOARD_URL', 'http://nanoscope.local')


def request(path='/api/network', body=None, expected=200, origin=None):
    headers = {'Content-Type': 'application/json'}
    if origin:
        headers['Origin'] = origin
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        response = urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        value = json.load(response)
        assert response.status == expected, (response.status, value.get('error'))
        return value


def status(port):
    port.write(b'network status\n')
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        line = port.readline().decode(errors='replace').strip()
        if line.startswith('NETWORK '):
            return json.loads(line[8:])
    raise TimeoutError('USB network status')


def wait_mode(port, mode, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = status(port)
        if state['mode'] == mode and state['connected'] and not state['pending']:
            return state
        time.sleep(.3)
    raise TimeoutError('Network did not reach ' + mode)


original = request()
assert original['stationConnected'] and original['mode'] == 'station'
assert 'password' not in original and 'apPassword' not in original
for body in [{'mode': 'bad'}, {'ssid': ''}, {'ssid': 'a' * 33}, {'password': 'short'},
             {'apPassword': ''}, {'apSsid': 'a' * 33}, {'mode': 7}, {'keepPassword': 'yes'}]:
    request(body=body, expected=400)
request(body={'mode': 'hotspot'}, expected=403, origin='https://example.invalid')
print('PASS: network validation and origin guards; status excludes passwords', flush=True)
key = request('/api/network/hotspot-password', {}, 200)['apPassword']
assert len(key) >= 8
try:
    request(body={'apSsid': 'NanoScope-verification', 'apPassword': 'NanoScope-verify-2468'}, expected=202)
    updated = request()
    assert updated['apSSID'] == 'NanoScope-verification' and updated['stationConnected']
    assert request('/api/network/hotspot-password', {}, 200)['apPassword'] == 'NanoScope-verify-2468'
finally:
    request(body={'apSsid': original['apSSID'], 'apPassword': key}, expected=202)
print('PASS: hotspot name/password update and restoration without dropping station Wi-Fi', flush=True)
port = serial.Serial()
port.port = '/dev/cu.usbmodem1101'
port.baudrate = 115200
port.timeout = .25
port.dtr = False
port.rts = False
port.open()
try:
    state = wait_mode(port, 'station')
    assert state['stationConnected']
    request(body={'mode': 'hotspot'}, expected=202)
    state = wait_mode(port, 'hotspot')
    assert state['apActive'] and not state['stationConnected'] and state['ip'] == '192.168.4.1' and state['led'] == 'amber'
    print('PASS: API switch starts exclusive hotspot at 192.168.4.1; LED state amber', flush=True)
finally:
    port.write(b'network station\n')
    state = wait_mode(port, 'station')
    assert state['stationConnected'] and not state['apActive'] and state['led'] == 'blue'
    port.close()
    print('PASS: USB restores station Wi-Fi; LED state blue', flush=True)
deadline = time.monotonic() + 10
while True:
    try:
        state = request()
        assert state['stationConnected'] and state['apSSID'] == original['apSSID']
        break
    except (urllib.error.URLError, TimeoutError):
        if time.monotonic() > deadline:
            raise
        time.sleep(.5)
print('PASS: HTTP UI reachable after both mode transitions', flush=True)
