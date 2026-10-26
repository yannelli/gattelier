import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.location = new URL('https://app.example/');
const saved = new Map();
globalThis.localStorage = {
  getItem: key => saved.get(key) || null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: key => saved.delete(key),
};
const api = createRequire(import.meta.url)('../web/api.js');

test('hosted apps start without a board endpoint while local boards use same origin', () => {
  assert.equal(api.sameOriginDefault(new URL('https://app.example/')), 'https://app.example');
  assert.equal(api.sameOriginDefault(new URL('http://nanoscope.local/'), true), '');
  assert.equal(api.sameOriginDefault(new URL('http://nanoscope.local/')), 'http://nanoscope.local');
  assert.equal(api.sameOriginDefault(new URL('https://private.example.ts.net:8443/')), 'https://private.example.ts.net:8443');
  assert.equal(api.sameOriginDefault(new URL('http://192.168.4.1/')), 'http://192.168.4.1');
});

test('endpoint validation accepts HTTPS and private HTTP origins', () => {
  assert.equal(api.validateOrigin('https://bridge.example.ts.net:8443'), 'https://bridge.example.ts.net:8443');
  for (const value of ['http://nanoscope.local', 'http://192.168.4.1', 'http://10.0.0.12', 'http://[fd00::1]', 'http://localhost:8766']) assert.equal(api.validateOrigin(value), value);
  for (const value of ['http://bridge.example.ts.net', 'https://user:secret@bridge.example', 'https://bridge.example/api', 'https://bridge.example?board=other', 'ftp://bridge.example']) {
    assert.throws(() => api.validateOrigin(value), Error);
  }
});

test('local HTTP fetch uses local-network permission without browser credentials', async () => {
  api.setOrigin('http://192.168.4.1');
  let captured;
  globalThis.fetch = async (url, options) => { captured = { url, options }; return new Response('{}'); };
  await api.fetch('state');
  assert.equal(captured.url, 'http://192.168.4.1/api/state');
  assert.equal(captured.options.targetAddressSpace, 'local');
  assert.equal(captured.options.credentials, 'omit');
  assert.equal(api.addressSpace('localhost'), 'loopback');
  assert.equal(api.addressSpace('[::1]'), 'loopback');
  assert.equal(api.addressSpace('172.31.1.2'), 'local');
  assert.equal(api.addressSpace('172.32.1.2'), '');
  assert.equal(api.addressSpace('192.168.1.2.example.com'), '');
  assert.equal(api.addressSpace('router.local.example.com'), '');
});

test('API requests use the saved origin without credentials', async () => {
  api.setOrigin('https://bridge.example.ts.net:8443');
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const response = await api.fetch('/api/state');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(request.url, 'https://bridge.example.ts.net:8443/api/state');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(saved.get('nanoscope.apiOrigin'), 'https://bridge.example.ts.net:8443');
});

test('an endpoint change aborts requests from the previous endpoint', async () => {
  api.setOrigin('https://first.example.ts.net');
  let resolveFetch;
  globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
  const pending = api.fetch('/api/state');
  api.setOrigin('https://second.example.ts.net');
  resolveFetch(new Response('{}'));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(api.url('events?after=4'), 'https://second.example.ts.net/api/events?after=4');
});
