import test from 'node:test';
import assert from 'node:assert/strict';
import connection from '../web/connection.js';

const target = { address: '02:00:00:00:00:01', addressType: 0, name: 'RadiaCode', connectable: true };
const other = { address: '02:00:00:00:00:02', addressType: 0, name: 'Smart bed', connectable: true };
const context = (ble = {}, devices = [target]) => ({ state: { ble, devices }, selected: target, online: true, pending: false });

test('connect stays enabled for scanned and saved connectable addresses', () => {
  assert.equal(connection.describe(target, context()).enabled, true);
  const saved = connection.describe(target, context({}, []));
  assert.equal(saved.enabled, true);
  assert.equal(saved.label, 'Try known address');
  assert.match(saved.reason, /Not in the current scan/);
});
test('connection states explain unavailable actions and offer explicit switching', () => {
  for (const [change, reason] of [[{ online: false }, /Reconnect/], [{ pending: true }, /progress/]]) {
    const status = connection.describe(target, { ...context(), ...change });
    assert.equal(status.enabled, false); assert.match(status.reason, reason);
  }
  const broadcast = connection.describe({ ...target, connectable: false }, context({}, []));
  assert.equal(broadcast.enabled, false); assert.equal(broadcast.status, 'Broadcast only');
  assert.equal(connection.describe(target, context({ connected: true, addressType: 0, address: target.address })).label, 'Disconnect');
  assert.equal(connection.describe(target, context({ connected: true, addressType: 0, address: other.address })).label, 'Switch and connect');
});
function harness(initial, options = {}) {
  let state = initial, selected = target;
  const calls = [];
  connection.init({ state: () => state, selected: () => selected, online: () => true, pending: () => false,
    devices: () => [target, other], refresh: async () => {}, changed() {}, notice() {}, select: value => { selected = value; },
    action: async (action, body) => {
      calls.push({ action, body });
      if (options.fail) throw new Error('Radio timeout');
      state = { ...state, ble: { connected: action === 'connect', addressType: 0, address: action === 'connect' ? target.address : '' } };
      return state;
    }, ...options.hooks });
  return { calls };
}
test('global controller disconnects another device then connects its exact address', async () => {
  const { calls } = harness({ ble: { connected: true, addressType: 0, address: other.address }, devices: [{ ...target, id: 19 }] });
  assert.equal(connection.connectedDevice().name, 'Smart bed');
  const result = await connection.ensure(target);
  assert.deepEqual(calls, [{ action: 'disconnect', body: undefined }, { action: 'connect', body: { address: target.address, addressType: target.addressType } }]);
  assert.equal(result.ble.address, target.address);
  assert.equal(connection.connectedDevice().name, 'RadiaCode');
});
test('saved addresses connect without a current firmware scan id', async () => {
  const { calls } = harness({ ble: {}, devices: [] });
  await connection.ensure(target);
  assert.deepEqual(calls, [{ action: 'connect', body: { address: target.address, addressType: 0 } }]);
});
test('the Connect button asks for identity reads; app connections do not', async () => {
  const { calls } = harness({ ble: {}, devices: [] });
  await connection.perform(target);
  assert.deepEqual(calls, [{ action: 'connect', body: { address: target.address, addressType: 0, identify: true } }]);
});
test('already connected is reused without reconnecting and failures clear pending', async () => {
  const { calls } = harness({ ble: { connected: true, addressType: 0, address: target.address }, devices: [] });
  await connection.ensure(target); assert.equal(calls.length, 0);
  harness({ ble: {}, devices: [] }, { fail: true });
  await assert.rejects(connection.ensure(target), /Radio timeout/);
  assert.equal(connection.snapshot().pending, false);
});
test('concurrent requests cannot race through the status refresh', async () => {
  let release;
  harness({ ble: {}, devices: [] }, { hooks: { refresh: () => new Promise(resolve => { release = resolve; }) } });
  const first = connection.ensure(target);
  await assert.rejects(connection.ensure(target), /already running/);
  release(); await first;
});

test('queued local connection can be cancelled before refresh completes without sending BLE commands', async () => {
  let release;
  const { calls } = harness({ ble: {}, devices: [] }, { hooks: { refresh: () => new Promise(resolve => { release = resolve; }) } });
  const operation = connection.ensure(target);
  assert.equal(connection.describe(target).label, 'Cancel connection');
  assert.equal(connection.describe(target).enabled, true);
  assert.equal(connection.describe(other).enabled, false);
  assert.equal(connection.pendingDevice(), target);
  await connection.cancel(target);
  release(); await assert.rejects(operation, /cancelled/);
  assert.equal(calls.length, 0); assert.equal(connection.snapshot().pending, false);
});

test('connecting and discovering cancellation is scoped to the target, type and attempt', async () => {
  for (const operation of ['connecting', 'discovering']) {
    const initial = { ble: { busy: true, connected: operation === 'discovering', operation, address: target.address, addressType: 0, connectionAttempt: 19 }, devices: [target] };
    const { calls } = harness(initial);
    const status = connection.describe(target);
    assert.equal(status.label, 'Cancel connection'); assert.equal(status.enabled, true);
    assert.equal(connection.describe(other).enabled, false);
    assert.equal(connection.describe({ ...target, addressType: 1 }).enabled, false);
    await assert.rejects(connection.cancel(other), /progress/);
    await connection.cancel(target);
    assert.deepEqual(calls, [{ action: 'cancel-connect', body: { address: target.address, addressType: 0, connectionAttempt: 19 } }]);
  }
});

test('cancelling a switch during disconnect prevents the next connection', async () => {
  let release;
  const calls = [];
  harness({ ble: { connected: true, addressType: 0, address: other.address }, devices: [target] }, { hooks: { action: async action => { calls.push(action); await new Promise(resolve => { release = resolve; }); return { ble: { connected: false }, devices: [target] }; } } });
  const operation = connection.ensure(target);
  await Promise.resolve();
  await connection.cancel(target); release();
  await assert.rejects(operation, /cancelled/); assert.deepEqual(calls, ['disconnect']);
});

test('active connection cancellation bypasses inFlight while unrelated actions remain blocked', async () => {
  let release; const calls = [];
  harness({ ble: {}, devices: [] }, { hooks: { action: async (action, body) => {
    calls.push({ action, body });
    if (action === 'connect') { await new Promise(resolve => { release = resolve; }); throw new Error('Connection cancelled.'); }
    return { ble: { busy: true, operation: 'cancelling' } };
  } } });
  const operation = connection.ensure(target); await Promise.resolve();
  await assert.rejects(connection.ensure(other), /already running/);
  await connection.cancel(target); release(); await assert.rejects(operation, /cancelled/);
  assert.equal(calls[1].action, 'cancel-connect'); assert.equal(calls[1].body.address, target.address);
});

test('streamed devices remain connectable after the transient board cache evicts them', async () => {
  const streamed = { ...target, streamLive: true, liveId: null };
  assert.equal(connection.describe(streamed, context({}, [])).label, 'Connect');
  const { calls } = harness({ ble: {}, devices: [] });
  await connection.ensure(streamed);
  assert.deepEqual(calls, [{ action: 'connect', body: { address: target.address, addressType: 0 } }]);
});

test('same address with another address type is a different connection', () => {
  const status = connection.describe(target, context({ connected: true, address: target.address, addressType: 1 }));
  assert.equal(status.connected, false);
  assert.equal(status.label, 'Switch and connect');
});

test('discovery reports the service count supplied by state without inventing an identity phase', () => {
  const current = context({ ...target, connected: true, busy: true, operation: 'discovering', connectionAttempt: 2 });
  current.state.services = [{ uuid: '1800' }, { uuid: '1801' }];
  assert.equal(connection.describe(target, current).status, 'Discovering services · 2 found');
  current.state.services = [];
  assert.equal(connection.describe(target, current).status, 'Discovering services · 0 found');
  delete current.state.services;
  assert.equal(connection.describe(target, current).status, 'Discovering services');
  current.state.ble.operation = 'connecting';
  assert.equal(connection.describe(target, current).status, 'Connecting');
});

test('connected details use reported MTU and security for the connected peer', () => {
  const current = context({ ...target, connected: true, mtu: 247 });
  current.state.security = { address: target.address, encrypted: true };
  assert.equal(connection.describe(target, current).details, 'MTU 247 · Encrypted');
  current.state.security.encrypted = false;
  assert.equal(connection.describe(target, current).details, 'MTU 247 · Unencrypted');
  current.state.security.addressType = 1;
  assert.equal(connection.describe(target, current).details, 'MTU 247');
  current.state.security = { address: other.address, encrypted: true };
  assert.equal(connection.describe(target, current).details, 'MTU 247');
  delete current.state.ble.mtu;
  assert.equal(connection.describe(target, current).details, '');
  current.state.ble.connected = false;
  assert.equal(connection.describe(target, current).details, '');
});

test('switching uses the shared display name when available', () => {
  harness({ ble: {}, devices: [] });
  globalThis.deviceDisplayName = device => `Named ${device.address}`;
  try {
    assert.match(connection.describe(target, context({ ...other, connected: true })).reason, /Disconnects Named 02:00:00:00:00:02/);
  } finally { delete globalThis.deviceDisplayName; }
});

test('connection controls announce status and available link details politely', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ children: [], attributes: {}, dataset: {}, append(...nodes) { this.children.push(...nodes); }, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener() {} }) };
  harness({ ble: { ...target, connected: true, mtu: 185 }, security: { address: target.address, encrypted: true }, devices: [target] });
  try {
    const root = connection.controls(target), info = root.children[0];
    assert.equal(info.attributes.role, 'status'); assert.equal(info.attributes['aria-live'], 'polite');
    assert.equal(info.children[0].textContent, 'Connected');
    assert.equal(info.children.at(-1).textContent, 'MTU 185 · Encrypted');
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('discovery shows identity feedback only after discovered values are present', () => {
  const current = context({ ...target, connected: true, busy: true, operation: 'discovering', connectionAttempt: 2 });
  const item = { valueHex: null, descriptors: [{ valueHex: null }] };
  current.state.services = [{ characteristics: [item] }];
  assert.equal(connection.describe(target, current).status, 'Discovering services · 1 found');
  item.valueHex = '';
  assert.equal(connection.describe(target, current).status, 'Identifying device · 1 found');
  item.valueHex = null; item.descriptors[0].valueHex = '01';
  assert.equal(connection.describe(target, current).status, 'Identifying device · 1 found');
  current.state.ble.busy = false;
  assert.equal(connection.describe(target, current).status, 'Connected');
});
