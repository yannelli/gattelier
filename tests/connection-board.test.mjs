import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/connection.js', import.meta.url), 'utf8');
const target = { address: '02:00:00:00:00:01', addressType: 0, connectable: true };
const other = { ...target, address: '02:00:00:00:00:02' };
const disconnected = () => ({ ble: {}, devices: [] });
const connected = device => ({ ble: { ...device, connected: true, connectionAttempt: 1 }, devices: [] });
const connecting = () => ({ ble: { ...target, busy: true, operation: 'connecting', connectionAttempt: 3 }, devices: [] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture({ initial = disconnected(), refresh, action } = {}) {
  let state = initial, endpoint = 'board-a', selected = target, notice = '';
  const calls = [], listeners = new Set();
  const context = vm.createContext({ module: { exports: {} }, addEventListener: (name, callback) => {
    assert.equal(name, 'nanoscope:api-change'); listeners.add(callback);
  } });
  vm.runInContext(source, context);
  const connection = context.module.exports;
  const hooks = { state: () => state, selected: () => selected, online: () => true, pending: () => false,
    devices: () => [target, other], changed() {}, notice: value => { notice = value; }, select: value => { selected = value; },
    refresh: () => refresh?.(api),
    async action(kind, body) {
      const origin = endpoint; calls.push({ endpoint, kind, body });
      const result = action ? await action(kind, body, api) : kind === 'connect' ? connected(body) : disconnected();
      if (endpoint === origin) state = result;
      return result;
    }
  };
  const api = { connection, calls, listeners, hooks,
    change(endpointName = 'board-b', next = disconnected()) { endpoint = endpointName; state = next; for (const listener of listeners) listener(); },
    setNotice(value) { notice = value; }, get notice() { return notice; }
  };
  connection.init(hooks); return api;
}

test('board changes cancel a connection queued behind refresh before sending commands', async () => {
  for (const endpoints of [['board-b'], ['board-b', 'board-a'], ['usb'], ['board-a']]) {
    const pending = deferred(), f = fixture({ refresh: () => pending.promise });
    const operation = f.connection.ensure(target);
    assert.equal(f.connection.snapshot().pending, true);
    for (const endpoint of endpoints) f.change(endpoint);
    assert.equal(f.connection.snapshot().pending, false);
    pending.resolve(); await assert.rejects(operation, /board connection changed/);
    assert.deepEqual(f.calls, []);
  }
});

test('board changes cancel a queued disconnect before touching the new board', async () => {
  const pending = deferred(), f = fixture({ initial: connected(target), refresh: () => pending.promise });
  const operation = f.connection.disconnect();
  f.change('board-b', connected(other)); pending.resolve();
  await assert.rejects(operation, /board connection changed/); assert.deepEqual(f.calls, []);
});

test('switching boards during disconnect prevents the subsequent connect', async () => {
  const pending = deferred(), started = deferred();
  const f = fixture({ initial: connected(other), action: () => { started.resolve(); return pending.promise; } });
  const operation = f.connection.ensure(target); await started.promise;
  f.change(); pending.resolve(disconnected());
  await assert.rejects(operation, /board connection changed/);
  assert.deepEqual(f.calls.map(call => [call.endpoint, call.kind]), [['board-a', 'disconnect']]);
});

test('late connect and disconnect completions cannot release a new board operation', async () => {
  for (const kind of ['connect', 'disconnect']) {
    const old = deferred(), next = deferred(), started = [deferred(), deferred()]; let count = 0;
    const f = fixture({ initial: kind === 'disconnect' ? connected(target) : disconnected(), action: () => {
      const index = count++; started[index].resolve(); return index === 0 ? old.promise : next.promise;
    } });
    const operation = kind === 'connect' ? f.connection.ensure(target) : f.connection.disconnect();
    await started[0].promise; f.change();
    const current = f.connection.ensure(target); await started[1].promise;
    old.resolve(kind === 'connect' ? connected(target) : disconnected());
    await assert.rejects(operation, /board connection changed/);
    assert.equal(f.connection.snapshot().pending, true);
    await assert.rejects(f.connection.ensure(other), /already running/);
    next.resolve(connected(target)); await current;
    assert.equal(f.connection.snapshot().pending, false);
    assert.deepEqual(f.calls.map(call => [call.endpoint, call.kind]), [['board-a', kind], ['board-b', 'connect']]);
  }
});

test('late cancellation completion cannot clear cancellation on the new board', async () => {
  const old = deferred(), next = deferred(), started = [deferred(), deferred()]; let count = 0;
  const f = fixture({ initial: connecting(), action: () => {
    const index = count++; started[index].resolve(); return index === 0 ? old.promise : next.promise;
  } });
  const operation = f.connection.cancel(target); await started[0].promise;
  f.change('board-b', connecting());
  const current = f.connection.cancel(target); await started[1].promise;
  old.resolve(disconnected()); await assert.rejects(operation, /board connection changed/);
  assert.equal(f.connection.describe(target).label, 'Cancelling...');
  assert.equal(f.connection.describe(target).enabled, false);
  next.resolve(disconnected()); await current;
  assert.equal(f.connection.describe(target).label, 'Try known address');
});

test('old connection errors cannot replace a notice from the selected board', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), f = fixture({ refresh: () => pending.promise });
    const operation = f.connection.perform(target); f.change(); f.setNotice('Current board notice.');
    if (fail) pending.reject(new Error('Old radio error.')); else pending.resolve();
    await operation;
    assert.equal(f.notice, 'Current board notice.'); assert.deepEqual(f.calls, []);
  }
});

test('reinitializing controller hooks retains one API change listener', async () => {
  const f = fixture(); f.connection.init(f.hooks); assert.equal(f.listeners.size, 1);
  await f.connection.ensure(target);
  assert.deepEqual(f.calls.map(call => [call.endpoint, call.kind]), [['board-a', 'connect']]);
});
