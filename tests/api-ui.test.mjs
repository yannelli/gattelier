import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const apiTools = createRequire(import.meta.url)('../web/api.js');
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/api-ui.js', import.meta.url), 'utf8');

function fixture() {
  const controls = new Map(), handlers = new Map(), calls = [], requests = [];
  let reply = async () => ({ ok: true, json: async () => ({ ble: {}, wifi: {} }) });
  function get(selector) {
    if (!controls.has(selector)) controls.set(selector, {
      value: '', checked: false, disabled: false, hidden: false, textContent: '', listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, callback) { this.listeners[type] = callback; },
    });
    return controls.get(selector);
  }
  const radios = ['serial', 'http'].map(value => ({ ...get(value), value }));
  const panel = { classList: { add() {} }, querySelector: get, querySelectorAll: () => radios };
  const document = { activeElement: null };
  const status = { supported: true, secure: true, state: 'disconnected', connected: false, wifiSuspended: false, error: '' };
  let origin = 'https://board.example', transport = 'http', wifiError = '';
  const emit = type => handlers.get(type)?.();
  const api = {
    validateOrigin: value => apiTools.validateOrigin(value, new URL('https://app.example')), addressSpace: apiTools.addressSpace,
    origin: () => origin, transport: () => transport, serialStatus: () => status,
    configured: () => transport === 'serial' ? status.connected : Boolean(origin),
    setOrigin(value) {
      const parsed = new URL(value.trim());
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('The board endpoint must use HTTP or HTTPS.');
      origin = parsed.origin; emit('nanoscope:api-change');
    },
    clearOrigin() { origin = ''; emit('nanoscope:api-change'); },
    selectTransport(value) { transport = value; emit('nanoscope:api-change'); },
    async fetch(path) { calls.push(path); return { ok: true, json: async () => ({ ble: {}, wifi: {} }) }; },
    async setSerialWifiOff(value) {
      calls.push(value);
      if (wifiError) throw new Error(wifiError);
      status.wifiSuspended = value;
    },
  };
  const context = vm.createContext({ document, NanoAPI: api, NanoAccessUI: { mount() {} },
    URL, AbortController, setTimeout, clearTimeout, fetch: (url, options) => { calls.push(url); requests.push({ url, options }); return reply(url, options); }, addEventListener: (type, callback) => handlers.set(type, callback) });
  vm.runInContext(source, context);
  context.NanoAPIUI.mount(panel);
  const input = get('[data-api-origin]');
  return { get, input, document, status, calls, requests, api, emit, respond: callback => { reply = callback; },
    draft(value) { input.value = value; input.listeners.input(); },
    failWifi(message) { wifiError = message; },
  };
}

test('blurred board address drafts survive serial and transport status renders', () => {
  const f = fixture();
  f.document.activeElement = f.input;
  f.draft('https://draft.example');
  f.document.activeElement = f.get('[data-api-check]');
  f.emit('nanoscope:serial');
  assert.equal(f.input.value, 'https://draft.example');
  assert.equal(f.document.activeElement, f.get('[data-api-check]'));
  f.api.selectTransport('serial');
  f.api.selectTransport('http');
  assert.equal(f.input.value, 'https://draft.example');
  assert.equal(f.api.origin(), 'https://board.example');
});

test('failed board address validation preserves a blurred draft for correction', () => {
  const f = fixture();
  f.draft('ftp://draft.example');
  f.document.activeElement = f.get('[data-api-form]');
  f.get('[data-api-form]').listeners.submit({ preventDefault() {} });
  assert.equal(f.input.value, 'ftp://draft.example');
  assert.equal(f.api.origin(), 'https://board.example');
  assert.equal(f.get('[data-api-message]').textContent, 'The board endpoint must use HTTP or HTTPS.');
  assert.deepEqual(f.calls, []);
  f.emit('nanoscope:serial');
  assert.equal(f.input.value, 'ftp://draft.example');
});

test('saving a focused draft displays the normalized origin and clears its dirty state', async () => {
  const f = fixture();
  f.draft(' https://saved.example/ ');
  f.document.activeElement = f.input;
  f.get('[data-api-form]').listeners.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(f.input.value, 'https://saved.example');
  assert.equal(f.api.origin(), 'https://saved.example');
  assert.equal(f.document.activeElement, f.input);
  assert.deepEqual(f.calls, ['https://saved.example/api/state']);
  f.document.activeElement = null;
  f.api.setOrigin('https://changed.example');
  assert.equal(f.input.value, 'https://changed.example');
});

test('clearing a focused draft replaces it and resumes saved-origin updates', () => {
  const f = fixture();
  f.draft('https://draft.example');
  f.document.activeElement = f.input;
  f.get('[data-api-clear]').listeners.click();
  assert.equal(f.input.value, '');
  assert.equal(f.api.origin(), '');
  assert.equal(f.get('[data-api-message]').textContent, 'Address cleared.');
  f.document.activeElement = null;
  f.api.setOrigin('https://changed.example');
  assert.equal(f.input.value, 'https://changed.example');
});

test('a rejected USB Wi-Fi toggle keeps its error after re-enabling the switch', async () => {
  const f = fixture();
  Object.assign(f.status, { connected: true, state: 'connected', wifiSuspended: true });
  f.api.selectTransport('serial');
  f.failWifi('The board rejected the Wi-Fi change.');
  const toggle = f.get('[data-api-wifi-off]');
  toggle.checked = false;
  await toggle.listeners.change();
  assert.deepEqual(f.calls, [false]);
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, true);
  assert.equal(f.get('[data-api-message]').textContent, 'The board rejected the Wi-Fi change.');
});

test('an accepted USB Wi-Fi toggle shows the resulting board status', async () => {
  const f = fixture();
  Object.assign(f.status, { connected: true, state: 'connected', wifiSuspended: true });
  f.api.selectTransport('serial');
  const toggle = f.get('[data-api-wifi-off]');
  toggle.checked = false;
  await toggle.listeners.change();
  assert.deepEqual(f.calls, [false]);
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, false);
  assert.equal(f.get('[data-api-message]').textContent, 'Wi-Fi is on.');
});

test('Test probes the draft address without saving it or changing the active endpoint', async () => {
  const f = fixture(); f.draft(' https://draft.example/ ');
  await f.get('[data-api-check]').listeners.click();
  assert.deepEqual(f.calls, ['https://draft.example/api/state']);
  assert.equal(f.api.origin(), 'https://board.example');
  assert.equal(f.input.value, ' https://draft.example/ ');
  assert.equal(f.get('[data-api-state]').textContent, 'Test passed');
  assert.match(f.get('[data-api-message]').textContent, /draft.example/);
  assert.match(f.get('[data-api-message]').textContent, /Save/);
});

test('an unsaved first address can be tested with a read-only local-network request', async () => {
  const f = fixture(); f.api.clearOrigin(); f.draft('http://192.168.1.88');
  await f.get('[data-api-check]').listeners.click();
  assert.equal(f.api.origin(), '');
  assert.equal(f.requests[0].url, 'http://192.168.1.88/api/state');
  assert.equal(f.requests[0].options.method, 'GET');
  assert.equal(f.requests[0].options.targetAddressSpace, 'local');
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].options.cache, 'no-store');
});

test('invalid draft addresses fail validation without contacting the saved endpoint', async () => {
  const f = fixture(); f.draft('ftp://draft.example');
  await f.get('[data-api-check]').listeners.click();
  assert.deepEqual(f.calls, []); assert.equal(f.api.origin(), 'https://board.example');
  assert.match(f.get('[data-api-message]').textContent, /HTTP or HTTPS/);
});

test('editing a draft aborts its pending test and suppresses a late result', async () => {
  const f = fixture(); let resolve;
  f.respond(() => new Promise(done => { resolve = done; }));
  f.draft('https://first.example'); const pending = f.get('[data-api-check]').listeners.click();
  f.draft('https://second.example');
  assert.equal(f.requests[0].options.signal.aborted, true);
  resolve({ ok: true, json: async () => ({ ble: {}, wifi: {} }) }); await pending;
  assert.equal(f.input.value, 'https://second.example');
  assert.equal(f.get('[data-api-state]').textContent, 'Not saved');
  assert.equal(f.get('[data-api-message]').textContent, '');
});

test('a transport change aborts the draft probe and rejects its late error', async () => {
  const f = fixture(); let reject;
  f.respond(() => new Promise((_resolve, fail) => { reject = fail; }));
  f.draft('https://draft.example'); const pending = f.get('[data-api-check]').listeners.click();
  f.api.selectTransport('serial');
  assert.equal(f.requests[0].options.signal.aborted, true);
  reject(new Error('Old request failed')); await pending;
  assert.doesNotMatch(f.get('[data-api-message]').textContent, /Old request/);
  assert.equal(f.api.transport(), 'serial');
});

test('non-JSON and empty error replies report the endpoint failure clearly', async () => {
  for (const [ok, status, empty] of [[true, 200, false], [false, 404, false], [false, 503, true]]) {
    const f = fixture(); f.draft('https://wrong.example');
    f.respond(async () => ({ ok, status, json: async () => { if (empty) return null; throw new SyntaxError('Unexpected token <'); } }));
    await f.get('[data-api-check]').listeners.click();
    assert.equal(f.get('[data-api-message]').textContent, ok ? 'The endpoint did not return Gattelier board status.' : `Connection failed (${status}).`);
    assert.equal(f.api.origin(), 'https://board.example');
  }
});

test('an aborted response body keeps the connection timeout explanation', async () => {
  const f = fixture(); f.draft('https://draft.example');
  f.respond(async () => ({ ok: true, json: async () => { throw Object.assign(new Error('Aborted'), { name: 'AbortError' }); } }));
  await f.get('[data-api-check]').listeners.click();
  assert.match(f.get('[data-api-message]').textContent, /timed out/);
});
