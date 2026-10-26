import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get('NANOSCOPE_BOARD_URL', 'http://nanoscope.local')
APP = 'https://gattelier.ryanyannelli.com'


def request(path, origin, method='GET', body=None, extra=None):
    headers = {'Origin': origin, **(extra or {})}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, headers=headers, method=method, data=data)
    try:
        response = urllib.request.urlopen(req, timeout=8)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers), response.read()


for path in ['/api/state', '/api/events?after=0', '/api/network', '/api/usb-mode', '/api/collection', '/api/access']:
    status, headers, _ = request(path, APP)
    assert status == 200, (path, status)
    assert headers.get('Access-Control-Allow-Origin') == APP, path
    assert request(path, 'https://untrusted.example')[0] == 403, path
    assert request(path, 'null')[0] == 403, path

for path in ['/api/write', '/api/pair', '/api/network', '/api/collection/clear', '/api/usb-mode']:
    status, headers, _ = request(path, APP, 'OPTIONS', extra={'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'})
    assert status == 204, (path, status)
    assert headers.get('Access-Control-Allow-Origin') == APP
    assert request(path, 'https://untrusted.example', 'OPTIONS', extra={'Access-Control-Request-Method': 'POST'})[0] == 403

assert request('/api/access', APP, 'POST', {'origin': 'https://untrusted.example'})[0] == 403
assert request('/api/write', APP, 'OPTIONS', extra={'Access-Control-Request-Method': 'DELETE'})[0] == 403
assert request('/api/write', APP, 'OPTIONS', extra={'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-custom'})[0] == 403
print('PASS: exact-origin reads and preflights; untrusted origins and hosted access changes rejected')
