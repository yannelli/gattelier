import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/notify-client.js', import.meta.url), 'utf8');
const device = { address: 'aa:bb:cc:dd:ee:01', addressType: 0 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ ensure, action } = {}) {
  let state = { ble: { ...device, connected: true, connectionAttempt: 1, mtu: 23 } };
  const listeners = new Map(), stateListeners = new Set(), actions = [], resets = [];
  const context = vm.createContext({ setTimeout, clearTimeout,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); }
  });
  const factory = vm.runInContext(source + '\nNanoNotifyClient', context);
  const lab = {
    getState: () => state, isActing: () => false,
    onState(listener) { stateListeners.add(listener); listener(state, true); return () => stateListeners.delete(listener); },
    onEvents: () => () => {}, setFastCapture() {},
    async action(path, body) { actions.push({ path, ...body }); await action?.(api); return state; }
  };
  const link = factory.create(lab, { handles: () => ({ write: { handle: 4 } }), hex: bytes => Buffer.from(bytes).toString('hex'), Assembler: class {} }, {
    name: 'Fixture', text: { changed: 'Connection changed.', moved: 'Connection changed during transfer.', select: 'Select a device.', poisoned: 'Reconnect first.' },
    connection: { ensure: selected => ensure ? ensure(selected, api) : Promise.resolve(state) },
    timeout: 1000, chunk: 2, check() {}, writeResponse: () => false, reset: scope => resets.push(scope), onFrame() {}
  });
  const api = {
    link, actions, resets, listeners, state: () => state,
    setState(next, online = true) { state = next; for (const listener of stateListeners) listener(state, online); },
    changeApi() { listeners.get('nanoscope:api-change')?.(); },
    read(selected = device) { return link.run(selected, () => link.request('read', 'Response', () => new Uint8Array([1, 2, 3, 4]))); }
  };
  return api;
}

test('connection setup rejects the same MAC with a different address type before any action', async () => {
  const f = fixture();
  f.setState({ ble: { ...f.state().ble, addressType: 1 } });
  await assert.rejects(f.read(), /Connection changed/);
  assert.deepEqual(f.actions, []); f.link.close('Closed.');
});

test('replacement connection stops remaining write chunks and leaves the new connection usable', async () => {
  for (const change of [{ addressType: 1 }, { connectionAttempt: 2 }]) {
    const f = fixture({ action: api => api.setState({ ble: { ...api.state().ble, ...change } }) });
    await assert.rejects(f.read(), /Connection changed/);
    assert.equal(f.actions.length, 1);
    assert.equal(await f.link.run({ ...device, ...change }, () => 'new connection'), 'new connection');
    f.link.close('Closed.');
  }
});

test('replacement connection rejects an outstanding response without waiting for its timeout', async () => {
  for (const change of [{ addressType: 1 }, { connectionAttempt: 2 }]) {
    const started = deferred(), f = fixture({ action: () => started.resolve() });
    const operation = f.read();
    await started.promise; await new Promise(resolve => setImmediate(resolve));
    f.setState({ ble: { ...f.state().ble, ...change } });
    await assert.rejects(operation, /Connection changed during transfer/);
    assert.equal(f.link.busy(), false); f.link.close('Closed.');
  }
});

test('same-MAC reconnects reset protocol state while case-only updates retain it', async () => {
  const f = fixture(), before = f.resets.length;
  f.setState({ ble: { ...f.state().ble, address: device.address.toUpperCase() } });
  assert.equal(f.resets.length, before);
  f.setState({ ble: { ...f.state().ble, connectionAttempt: 2 } });
  assert.equal(f.resets.length, before + 1); assert.equal(f.resets.at(-1), 'address');
  f.setState({ ble: { ...f.state().ble, addressType: 1 } });
  assert.equal(f.resets.length, before + 2); f.link.close('Closed.');
});

test('board changes cancel delayed setup even when a matching connection appears afterwards', async () => {
  const pending = deferred(), f = fixture({ ensure: () => pending.promise });
  const operation = f.read(), old = f.state();
  f.changeApi(); f.setState({ ble: { ...old.ble } }); pending.resolve(old);
  await assert.rejects(operation, /Connection changed during transfer/);
  assert.deepEqual(f.actions, []); assert.equal(f.link.busy(), false); f.link.close('Closed.');
});

test('board changes cancel an outstanding response and reset an idle protocol session', async () => {
  const started = deferred(), f = fixture({ action: () => started.resolve() });
  const operation = f.read();
  await started.promise; await new Promise(resolve => setImmediate(resolve));
  f.changeApi(); f.setState({ ble: { ...f.state().ble } });
  await assert.rejects(operation, /Connection changed during transfer/);
  assert.equal(await f.link.run(device, () => 'new board'), 'new board');
  const before = f.resets.length;
  f.changeApi(); f.setState({ ble: { ...f.state().ble } });
  assert.ok(f.resets.length > before);
  f.link.close('Closed.'); assert.equal(f.listeners.size, 0);
});
