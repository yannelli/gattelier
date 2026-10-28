import test from 'node:test';
import assert from 'node:assert/strict';
import acquisition from '../web/dexcom-acquisition.js';

const device = { address: '02:00:00:00:00:07', addressType: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 100000, state = { uptime: 100, ble: { scanning: false, scanEnabled: false }, devices: [] }, seq = 0;
  const states = new Set(), events = new Set(), batches = [], calls = [], fast = [], expired = [], requests = [];
  const update = next => { state = next; for (const callback of states) callback(state, true); };
  const lab = {
    getState: () => state, update,
    onState(callback) { states.add(callback); callback(state, true); return () => states.delete(callback); },
    onEvents(callback) { events.add(callback); return () => events.delete(callback); },
    setFastCapture(enabled) { fast.push(enabled); },
    async action(kind) { calls.push(kind); update({ ...state, ble: { ...state.ble, scanning: kind === 'scan', scanEnabled: kind === 'scan' } }); return state; }
  };
  const fetch = async (path, init) => {
    requests.push({ path, ...init });
    if (options.fetch) return options.fetch(path, init);
    return { ok: true, json: async () => path.startsWith('state') ? state : batches.shift() || { bootId: 'one', cursor: seq, uptime: clock / 1000, devices: [] } };
  };
  const client = acquisition.create(lab, { now: () => clock, fetch, onExpire: error => expired.push(error), ...options.client });
  t.after(() => client.destroy());
  function batch(records, changes = {}) {
    batches.push({ bootId: 'one', uptime: clock / 1000, devices: records.map(record => ({ ...device, seq: ++seq, ms: clock, connectable: true, ...record })), cursor: seq, ...changes });
  }
  async function advance(ms) { clock += ms; state.uptime = clock / 1000; t.mock.timers.tick(ms); await tick(); }
  const emit = (records = [], meta = {}) => { for (const callback of events) callback(records, { bootId: 'events-one', cursor: Math.max(0, ...records.map(record => record.seq)), gaps: 0, ...meta }); };
  return { client, batch, advance, calls, fast, expired, requests, update, emit, states, events, get state() { return state; } };
}

test('acquisition waits for a fresh connectable advertisement matching address and type', async t => {
  const f = fixture(t); f.client.open(device);
  f.batch([{ addressType: 0 }, { address: '02:00:00:00:00:08' }, { ms: 95000 }, { ms: 105000 }, { connectable: false }]);
  let found = false; const pending = f.client.next().then(value => { found = true; return value; });
  await tick(); assert.equal(found, false); assert.deepEqual(f.calls, ['scan']);
  await f.advance(200); f.batch([{ address: device.address.toUpperCase() }]); await f.advance(200);
  assert.equal((await pending).addressType, 1); assert.equal(found, true); assert.ok(f.client.snapshot().lastSeenAt);
  assert.equal(f.client.snapshot().deadline, 700000); assert.equal(f.client.snapshot().remainingMs, 599600);
});

test('the ten-minute deadline stops scanning and capture without extending on attempts', async t => {
  const f = fixture(t); f.client.open(device);
  const pending = assert.rejects(f.client.next(), /ten-minute.*ended/); await tick();
  f.client.attempted(); await f.advance(300000); f.client.attempted(); await f.advance(300000); await pending;
  assert.equal(f.client.snapshot().active, false); assert.equal(f.client.snapshot().attempts, 2);
  assert.equal(f.expired.length, 1); assert.equal(f.fast.at(-1), false); assert.equal(f.calls.at(-1), 'stop-scan');
  const count = f.requests.length; await f.advance(600000); assert.equal(f.requests.length, count);
});

test('cancellation aborts in-flight requests and ignores late frames', async t => {
  let resolve;
  const f = fixture(t, { fetch: () => new Promise(yes => { resolve = yes; }) });
  f.client.open(device); const pending = assert.rejects(f.client.next(), /cancelled/); await tick();
  await f.client.close(); await pending;
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.fast.at(-1), false);
  resolve({ ok: true, json: async () => ({ uptime: 100, ble: { scanning: true } }) }); await tick();
  assert.deepEqual(f.calls, []); assert.equal(f.client.snapshot().lastSeenAt, null);
});

test('another device and another address type cannot be acquired or switched implicitly', t => {
  const f = fixture(t);
  for (const ble of [{ ...device, address: '02:00:00:00:00:08' }, { ...device, addressType: 0 }]) {
    f.update({ ...f.state, ble: { ...ble, connected: true } });
    assert.throws(() => f.client.open(device), /Another device/);
  }
  assert.deepEqual(f.calls, []);
});

test('an unrelated connection stops a pending window and leaves that connection alone', async t => {
  const f = fixture(t); f.client.open(device); const pending = assert.rejects(f.client.next(), /Another device/); await tick();
  f.update({ ...f.state, ble: { address: '02:00:00:00:00:08', addressType: 1, connected: true } }); await pending;
  assert.equal(f.client.snapshot().active, false); assert.deepEqual(f.calls, ['scan']); assert.equal(f.expired.length, 1);
});

test('replayed advertisements cannot satisfy the next attempt', async t => {
  const f = fixture(t); f.client.open(device); f.batch([{}]); await f.client.next(); await tick();
  let resolved = false; const pending = f.client.next().then(() => { resolved = true; });
  await tick(); f.batch([{ seq: 1 }]); await f.advance(200); assert.equal(resolved, false);
  f.batch([{}]); await f.advance(200); await pending; assert.equal(resolved, true);
});

test('board reboot closes the window before another advertisement can trigger a connection', async t => {
  const f = fixture(t); f.client.open(device); await f.client.poll();
  const pending = assert.rejects(f.client.next(), /restarted/); await tick();
  f.batch([{}], { bootId: 'two' }); await f.advance(200); await pending;
  assert.equal(f.client.snapshot().active, false); assert.equal(f.client.snapshot().attempts, 0);
});

test('capture counts scoped fresh packets and uses existing authentication redaction', async t => {
  const f = fixture(t); f.update({ ...f.state, ble: { ...device, connected: true } }); f.client.open(device);
  const event = { ...device, seq: 1, kind: 'write', uuid: 'f8083535-849e-531c-c594-30f1f86a4ea5', hex: '04010203' };
  f.emit([event]); assert.equal(f.client.snapshot().packetCount, 0);
  f.emit([{ ...event, seq: 2 }, { ...event, seq: 3, addressType: 0 }]);
  const captured = f.client.captureSnapshot(); assert.equal(captured.events.length, 1);
  assert.equal(captured.events[0].redacted, true); assert.equal(captured.events[0].hex, ''); assert.equal(captured.stats.gaps, 0);
  await f.client.close(); f.emit([{ ...event, seq: 4 }]); assert.equal(f.client.snapshot().packetCount, 1);
});

test('a pre-existing scan remains enabled after acquisition is cancelled', async t => {
  const f = fixture(t); f.update({ ...f.state, ble: { scanning: true, scanEnabled: true } }); f.client.open(device);
  const pending = assert.rejects(f.client.next(), /cancelled/); await tick(); await f.client.close(); await pending;
  assert.deepEqual(f.calls, []); f.client.destroy(); assert.equal(f.events.size, 0); assert.equal(f.states.size, 0);
});

test('transient classification preserves authentication, certificate and capture errors', () => {
  for (const message of ['G7 session challenge verification failed.', 'G7 rejected application authentication.', 'Peer proof failed.', 'Dexcom capture has a gap.', 'Dexcom BLE bonding timed out. Check Security for a pairing prompt.']) assert.equal(acquisition.transient(new Error(message)), false, message);
  for (const message of ['Connection timed out.', "Connection failed (BLE code 13). Retry using this device's known address.", 'Dexcom disconnected.', 'Dexcom auth response timed out.']) assert.equal(acquisition.transient(new Error(message)), true, message);
});

test('closing an idle reader leaves another capture owner unchanged', t => {
  const f = fixture(t); f.client.close(); f.client.destroy(); assert.deepEqual(f.fast, []);
});
