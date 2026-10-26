import argparse
import json
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('url')
args = parser.parse_args()
base = args.url.rstrip('/')


def request(path, body=None, expected=200, extra=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Content-Type': 'application/json'} if data else {}
    headers.update(extra or {})
    req = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        result = json.load(response)
        assert response.status == expected, (path, response.status, expected)
        assert 'Cache-Control' in response.headers
        return result


state = request('/api/state')
security = state['security']
assert all(isinstance(security[key], bool) for key in ['active', 'encrypted', 'authenticated', 'bonded'])
assert isinstance(security['remainingMs'], (int, float))
assert security['passkey'] is None or len(security['passkey']) == 6
for route in ['/api/pair', '/api/pairing-response', '/api/pairing-cancel']:
    request(route, {}, 400)
    request(route, {}, 403, {'Origin': 'http://example.invalid'})
    request(route, {}, 415, {'Content-Type': 'text/plain'})
    request(route, {'address': '00:00:00:00:00:00', 'padding': 'x' * 513}, 413)
request('/api/pair', {'address': '00:00:00:00:00:00'}, 409)
request('/api/pairing-response', {'address': '00:00:00:00:00:00', 'challengeId': '0' * 24, 'passkey': '1234'}, 400)
request('/api/pairing-response', {'address': '00:00:00:00:00:00', 'challengeId': '0' * 24, 'passkey': '000000'}, 409)
request('/api/pairing-response', {'address': '00:00:00:00:00:00', 'challengeId': '0' * 24, 'accept': 'yes'}, 400)
request('/api/pairing-cancel', {'address': '00:00:00:00:00:00', 'challengeId': '0' * 24}, 409)
print('PASS: security state, JSON/origin/size guards, six-digit passkey validation and stale request rejection')
