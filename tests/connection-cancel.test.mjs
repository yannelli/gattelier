import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const address = '02:00:00:00:00:01', other = '02:00:00:00:00:02';
const target = { id: 17, address, addressType: 0 };
const pending = { ble: { busy: true, connected: false, operation: 'connecting', address, addressType: 0, connectionAttempt: 42 }, devices: [target] };

function fixture(state, respond) {
  const calls = [], events = [];
  const context = {
    NanoPackets: { createCapture: () => ({}) }, NanoConsole: { update() {} }, console, setTimeout, clearTimeout, AbortController,
    document: { dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    NanoAPI: { async fetch(path, options) {
      calls.push({ path, options });
      const result = await respond(path, options);
      return { ok: result.status < 400, status: result.status, json: async () => result.body };
    } }
  };
  vm.runInNewContext(readFileSync(new URL('../web/lab.js', import.meta.url), 'utf8'), context);
  context.NanoLab.update(state, true);
  return { lab: context.NanoLab, calls, events };
}

test('scoped cancellation bypasses board busy without unlocking other BLE actions', async () => {
  const f = fixture(pending, async path => path === 'cancel-connect' ? { status: 202, body: { ok: true } } : { status: 200, body: { ...pending, ble: { ...pending.ble, operation: 'cancelling' } } });
  await assert.rejects(f.lab.action('write', {}), /Wait/);
  await f.lab.action('cancel-connect', { address, addressType: 0, connectionAttempt: 42 });
  assert.deepEqual(f.calls.map(call => call.path), ['cancel-connect', 'state']);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { address, addressType: 0, connectionAttempt: 42 });
  assert.equal(f.events.filter(event => event.type === 'nanoscope:busy').length, 0);
});

test('stale attempts, another target and another address type cannot cancel the connection', async () => {
  const f = fixture(pending, () => assert.fail('Invalid cancellation sent an HTTP request'));
  for (const body of [
    { address, addressType: 0, connectionAttempt: 41 },
    { address: other, addressType: 0, connectionAttempt: 42 },
    { address, addressType: 1, connectionAttempt: 42 },
    { address, addressType: 0 }
  ]) await assert.rejects(f.lab.action('cancel-connect', body), /no longer active/);
  assert.equal(f.calls.length, 0);
});

test('cancel during connect submission waits for its accepted scope and preserves the original busy lock', async () => {
  let accept, cancelled = false;
  const stopped = { ble: { busy: false, connected: false, operation: 'idle', error: 'Connection cancelled.' }, devices: [target] };
  const f = fixture({ ble: { busy: false }, devices: [target] }, async path => {
    if (path === 'connect') return await new Promise(resolve => { accept = resolve; });
    if (path === 'cancel-connect') { cancelled = true; return { status: 202, body: { ok: true } }; }
    return { status: 200, body: cancelled ? stopped : pending };
  });
  const connecting = f.lab.action('connect', { id: target.id });
  const cancellation = f.lab.action('cancel-connect', { address, addressType: 0 });
  assert.deepEqual(f.calls.map(call => call.path), ['connect']);
  accept({ status: 202, body: { ok: true, address, addressType: 0, connectionAttempt: 42 } });
  await cancellation;
  assert.equal(f.lab.isActing(), true);
  await assert.rejects(f.lab.action('connect', { id: 18 }), /Wait/);
  await assert.rejects(connecting, /Connection cancelled/);
  assert.equal(f.lab.isActing(), false);
  const posted = f.calls.find(call => call.path === 'cancel-connect');
  assert.deepEqual(JSON.parse(posted.options.body), { address, addressType: 0, connectionAttempt: 42 });
});

test('connect submission failure rejects its waiting cancellation without issuing a cancel request', async () => {
  let fail;
  const f = fixture({ ble: {}, devices: [target] }, () => new Promise(resolve => { fail = resolve; }));
  const connecting = f.lab.action('connect', { id: target.id });
  const cancellation = f.lab.action('cancel-connect', { address, addressType: 0 });
  fail({ status: 409, body: { error: 'Radio unavailable' } });
  await assert.rejects(connecting, /Radio unavailable/);
  await assert.rejects(cancellation, /Radio unavailable/);
  assert.deepEqual(f.calls.map(call => call.path), ['connect']);
});
