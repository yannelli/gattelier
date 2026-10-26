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
  assert.equal(connection.describe(target, context({ connected: true, address: target.address })).label, 'Disconnect');
  assert.equal(connection.describe(target, context({ connected: true, address: other.address })).label, 'Switch and connect');
});
function harness(initial, options = {}) {
  let state = initial, selected = target;
  const calls = [];
  connection.init({ state: () => state, selected: () => selected, online: () => true, pending: () => false,
    devices: () => [target, other], refresh: async () => {}, changed() {}, notice() {}, select: value => { selected = value; },
    action: async (action, body) => {
      calls.push({ action, body });
      if (options.fail) throw new Error('Radio timeout');
      state = { ...state, ble: { connected: action === 'connect', address: action === 'connect' ? target.address : '' } };
      return state;
    }, ...options.hooks });
  return { calls };
}
test('global controller disconnects another device then connects the selected live id', async () => {
  const { calls } = harness({ ble: { connected: true, address: other.address }, devices: [{ ...target, id: 19 }] });
  assert.equal(connection.connectedDevice().name, 'Smart bed');
  const result = await connection.ensure(target);
  assert.deepEqual(calls, [{ action: 'disconnect', body: undefined }, { action: 'connect', body: { id: 19 } }]);
  assert.equal(result.ble.address, target.address);
  assert.equal(connection.connectedDevice().name, 'RadiaCode');
});
test('saved addresses connect without a current firmware scan id', async () => {
  const { calls } = harness({ ble: {}, devices: [] });
  await connection.ensure(target);
  assert.deepEqual(calls, [{ action: 'connect', body: { address: target.address, addressType: 0 } }]);
});
test('already connected is reused without reconnecting and failures clear pending', async () => {
  const { calls } = harness({ ble: { connected: true, address: target.address }, devices: [] });
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
