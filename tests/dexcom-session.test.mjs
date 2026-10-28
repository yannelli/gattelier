import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), p = require('../web/dexcom-protocol.js'), { create } = require('../web/dexcom-session.js');
const device = { address: '02:00:00:00:00:07', addressType: 1 }, sample = '4e0064000000070000000a007b0006fb820000';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const listeners = new Set(), states = new Set(), writes = [], stages = [], saved = [];
  let state = { ble: { connected: true, address: device.address, addressType: 1, connectionAttempt: 7 }, security: { bonded: true, encrypted: true }, services: [{ uuid: p.SERVICE, characteristics: [
    { uuid: p.CONTROL, handle: 4, properties: ['write', 'notify'] }, { uuid: p.AUTH, handle: 5, properties: ['write', 'indicate'] },
    { uuid: p.BACKFILL, handle: 6, properties: ['notify'] }, { uuid: p.EXTRA, handle: 8, properties: ['write-no-response', 'notify'] }
  ] }] }, sequence = 0, round = 0, cancelled = false, connectionAttempts = 0;
  const fast = [], advertisements = [];
  const handles = { auth: 5, extra: 8, control: 4, backfill: 6 }, uuids = { auth: p.AUTH, extra: p.EXTRA, control: p.CONTROL, backfill: p.BACKFILL };
  const emit = (channel, value, extra = {}, meta = {}) => {
    const events = channel ? [{ seq: ++sequence, address: device.address, kind: channel === 'auth' ? 'indication' : 'notification', uuid: uuids[channel], handle: handles[channel], hex: typeof value === 'string' ? value : p.hex(value), ...extra }] : [];
    for (const fn of listeners) fn(events, { bootId: 'boot1', cursor: sequence, gaps: 0, ...meta });
  };
  const crypto = {
    randomToken: () => new Uint8Array(8).fill(3), aes8: (_key, data) => Uint8Array.from(data, value => value ^ 0xaa),
    createJpake(pin) { assert.equal(pin, '0042'); return { acceptPeerRound(number, bytes) { stages.push(number); assert.equal(bytes.length, 160); if (options.proofFailure) throw new Error('Peer proof failed.'); }, round1: () => new Uint8Array(160), round2: () => new Uint8Array(160), round3: () => new Uint8Array(160), deriveKey: () => new Uint8Array(16).fill(7), destroy() {} }; },
    certificates: () => [new Uint8Array(40), new Uint8Array(60)], signCertificateChallenge: () => new Uint8Array(64)
  };
  async function action(kind, body = {}) {
    writes.push({ kind, ...body });
    if (kind === 'scan' || kind === 'stop-scan') { state.ble.scanning = state.ble.scanEnabled = kind === 'scan'; return state; }
    if (kind === 'connect') {
      connectionAttempts++;
      if (options.connectFailure && connectionAttempts === 1) throw new Error('Connection timed out.');
      if (options.connectPending) return options.connectPending();
      state.ble = { ...state.ble, ...device, connected: true, scanning: false, connectionAttempt: (state.ble.connectionAttempt || 0) + 1 };
      for (const fn of states) fn(state, true); return state;
    }
    if (kind === 'disconnect') { state.ble.connected = false; state.ble.scanning = Boolean(state.ble.scanEnabled); for (const fn of states) fn(state, true); return state; }
    if (kind === 'cancel-connect') { cancelled = true; return state; }
    if (kind === 'pair') { state.security = { bonded: true, encrypted: true }; for (const fn of states) fn(state, true); }
    if (kind !== 'write') return state;
    const bytes = p.bytes(body.hex);
    if (options.onWrite) return options.onWrite(kind, body, { emit, state, bytes });
    if (body.handle === 5) {
      if (bytes[0] === 0x0a) { round++; for (let i = 0; i < 8; i++) emit('extra', new Uint8Array(20).fill(round)); }
      if (bytes[0] === 2 && !options.timeout) { const hash = crypto.aes8(null, bytes.slice(1, 9)); if (options.badChallenge) hash[0] ^= 1; emit('auth', Uint8Array.of(3, ...hash, ...new Uint8Array(8).fill(4))); }
      if (bytes[0] === 4) emit('auth', Uint8Array.of(5, 1, options.certificates ? 0 : options.bondStatus ?? 1));
      if (bytes[0] === 0x0b) { emit('auth', Uint8Array.of(0x0b, 0, bytes[1], 20, 0, 0, 0)); emit('extra', new Uint8Array(20)); }
      if (bytes[0] === 0x0c) { emit('auth', Uint8Array.of(0x0c, 0, ...new Uint8Array(16))); emit('extra', new Uint8Array(64)); }
      if (bytes[0] === 0x0d) emit('auth', options.bondCompletion || Uint8Array.of(0x0d, 0));
      if (bytes[0] === 6) emit('auth', Uint8Array.of(6, 0x19));
    }
    if (body.handle === 4 && bytes[0] === 0x4e) emit('control', sample);
    if (body.handle === 4 && bytes[0] === 0x4a) emit('control', '4a0020c06d282a34000031313131887766554433');
    if (body.handle === 4 && bytes[0] === 0x59) { emit('backfill', '5a0000007b000600fb'); emit('control', '5900'); }
    return state;
  }
  const lab = { getState: () => state, action, onEvents(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onState(fn) { states.add(fn); fn(state, true); return () => states.delete(fn); }, setFastCapture(enabled) { fast.push(enabled); if (enabled) queueMicrotask(() => emit()); } };
  const connection = { ensure: async () => state, disconnect: async () => { state.ble.connected = false; }, cancel: async () => { cancelled = true; } };
  const client = create(lab, { crypto, connection, chunkDelayMs: 0, timeoutMs: 50, bondTimeoutMs: 50, historyTimeoutMs: 50, loadSession: async () => options.saved === false ? null : { key: '07'.repeat(16) }, saveSession: async (...args) => saved.push(args), ...options.client });
  return { client, emit, writes, stages, saved, listeners, states, state, fast, advertisements, get connectionAttempts() { return connectionAttempts; }, get cancelled() { return cancelled; }, update(next, online = true) { state = next; for (const fn of states) fn(state, online); } };
}

test('saved session authenticates before control subscriptions and current reads', async () => {
  const f = fixture(); await f.client.connect(device, { remember: true, reconnect: false });
  assert.equal(f.client.snapshot().authenticated, true); assert.equal(f.client.snapshot().latest.glucoseMgDl, 123); assert.equal(f.saved.length, 1);
  assert.equal(f.writes.some(item => item.hex === '0a00'), false);
  assert.ok(f.writes.findIndex(item => item.hex?.startsWith('04')) < f.writes.findIndex(item => item.kind === 'subscribe' && item.handle === 4));
  await f.client.readIdentity(); assert.equal(f.client.snapshot().identity.serial, String(0x334455667788));
  await f.client.readHistory({ hours: 1 }); assert.equal(f.client.snapshot().historyReceived, 1);
  await assert.rejects(f.client.readTime(), /no direct time query/); f.client.destroy(); assert.equal(f.listeners.size, 0); assert.equal(f.states.size, 0);
});

test('first pair verifies all proof rounds, exchanges certificates and bonds', async () => {
  const f = fixture({ saved: false, certificates: true }); f.state.security = { bonded: false, encrypted: false };
  await f.client.connect(device, { pin: '0042', remember: true, reconnect: false });
  assert.deepEqual(f.stages, [1, 2, 3]); assert.equal(f.saved.length, 1); assert.equal(f.client.snapshot().authenticated, true);
  assert.equal(f.writes.filter(item => item.kind === 'pair').length, 1); assert.ok(f.writes.some(item => item.hex === '0d0002'));
  assert.equal(f.writes.filter(item => item.kind === 'write' && item.handle === 8).every(item => item.response === false && item.hex.length <= 40), true);
  f.client.destroy();
});

test('saved bonded status2 resumes without certificate transfer', async () => {
  const f = fixture({ bondStatus: 2 }); await f.client.connect(device, { reconnect: false });
  assert.equal(f.client.snapshot().authenticated, true); assert.equal(f.writes.some(item => item.hex?.startsWith('0b')), false); f.client.destroy();
});

test('the documented FF0601 certificate completion permits bonding', async () => {
  const f = fixture({ saved: false, certificates: true, bondCompletion: Uint8Array.of(0xff, 6, 1) });
  f.state.security = { encrypted: false, bonded: false };
  await f.client.connect(device, { pin: '0042', reconnect: false }); assert.equal(f.client.snapshot().authenticated, true); f.client.destroy();
});

test('reading timestamps retain board event time across delayed polling', async () => {
  let clock = 200000;
  const f = fixture({ client: { now: () => clock } }); f.update({ ...f.state, uptime: 200 });
  await f.client.connect(device, { reconnect: false }); clock += 20000;
  f.emit('control', sample, { ms: 205000 });
  assert.equal(f.client.snapshot().latest.receivedAt, 205000); assert.equal(f.client.snapshot().latest.timestamp, 195000); f.client.destroy();
});

test('negative challenge/proof and timeouts stop before current glucose writes', async () => {
  for (const flags of [{ badChallenge: true }, { timeout: true }, { saved: false, proofFailure: true }]) {
    const f = fixture({ ...flags, client: flags.timeout ? { windowMs: 100 } : {} });
    await assert.rejects(f.client.connect(device, { pin: flags.saved === false ? '0042' : undefined, reconnect: false }), /verification|window ended|proof failed/i);
    assert.equal(f.client.snapshot().authenticated, false); assert.equal(f.writes.some(item => item.hex === '4e'), false); f.client.destroy();
  }
});

test('scoped receive rejects wrong UUID, capture gaps, truncated packets and connection epochs', async () => {
  for (const failure of ['uuid', 'gap', 'truncated', 'epoch', 'reboot']) {
    const f = fixture(); await f.client.connect(device, { reconnect: false });
    if (failure === 'uuid') f.emit('control', sample, { uuid: p.BACKFILL });
    if (failure === 'gap') f.emit(null, null, {}, { gaps: 1 });
    if (failure === 'truncated') f.emit('control', sample, { truncated: true });
    if (failure === 'epoch') f.update({ ...f.state, ble: { ...f.state.ble, connectionAttempt: 8 } });
    if (failure === 'reboot') f.emit(null, null, {}, { bootId: 'boot2' });
    assert.equal(f.client.snapshot().authenticated, false, failure); assert.ok(f.client.snapshot().error, failure); f.client.destroy();
  }
});

test('other-device packets and replay cannot satisfy pending authentication; cancellation ends waiters', async () => {
  const f = fixture({ timeout: true, client: { timeoutMs: 500 } });
  const operation = f.client.connect(device, { reconnect: false }); await tick();
  f.emit('auth', '0300000000000000000000000000000000', { address: '02:00:00:00:00:08' });
  f.client.cancel(); await assert.rejects(operation, /cancelled/); assert.equal(f.client.snapshot().authenticated, false); assert.equal(f.client.snapshot().error, ''); f.client.destroy();
});

function wakeFixture(options = {}) {
  let f, sequence = 0;
  const batches = [];
  const fetch = async path => ({ ok: true, json: async () => path.startsWith('state') ? f.state : { bootId: 'scan-one', uptime: 100, cursor: sequence, devices: batches.splice(0) } });
  f = fixture({ ...options, client: { fetch, scanPollMs: 2, windowMs: 1000, ...options.client } });
  f.state.ble.connected = false; f.state.ble.scanning = true; f.state.ble.scanEnabled = true; f.state.uptime = 100;
  return { ...f, advertise(extra = {}) { batches.push({ ...device, seq: ++sequence, ms: 100000 + sequence, connectable: true, ...extra }); }, get attempts() { return f.connectionAttempts; } };
}

test('an initial transient miss retries on a new advertisement within the same window', async () => {
  const f = wakeFixture({ connectFailure: true }); f.advertise();
  const operation = f.client.connect(device, { remember: true }); await tick();
  const deadline = f.client.snapshot().acquisition.deadline;
  assert.equal(f.attempts, 1); assert.equal(f.client.snapshot().authenticated, false);
  f.advertise(); await f.client.pollAcquisition(); await operation;
  assert.equal(f.attempts, 2); assert.equal(f.client.snapshot().acquisition.deadline, deadline);
  assert.equal(f.client.snapshot().authenticated, true); assert.equal(f.saved.length, 1); f.client.destroy();
});

test('hidden navigation does not suppress reconnect and readings survive until the original deadline', async () => {
  const f = wakeFixture({ client: { isActive: () => false } }); f.advertise(); await f.client.connect(device, { reconnect: true });
  const initial = f.client.snapshot(); f.state.ble.connected = false;
  f.emit('control', '', { kind: 'disconnect' }); await tick();
  assert.equal(f.client.snapshot().busy, true); assert.equal(f.client.snapshot().records.length, 1);
  f.advertise(); await f.client.pollAcquisition(); await tick();
  assert.equal(f.client.snapshot().authenticated, true); assert.equal(f.client.snapshot().records.length, 1);
  assert.equal(f.client.snapshot().acquisition.deadline, initial.acquisition.deadline);
  await f.client.cancel(); assert.equal(f.client.snapshot().records.length, 1); assert.equal(f.fast.at(-1), false); f.client.destroy();
});

test('authentication failures terminate acquisition and remain visible without retrying', async () => {
  const f = wakeFixture({ badChallenge: true }); f.advertise();
  await assert.rejects(f.client.connect(device, { reconnect: true }), /verification failed/);
  assert.equal(f.client.snapshot().status, 'error'); assert.match(f.client.snapshot().error, /verification failed/);
  assert.equal(f.client.snapshot().acquisition.active, false); assert.equal(f.attempts, 1); assert.equal(f.fast.at(-1), false);
  f.advertise(); await f.client.pollAcquisition(); assert.equal(f.attempts, 1); f.client.destroy();
});

test('cancellation while waiting clears acquisition and retains the saved session', async () => {
  const f = wakeFixture(); const operation = f.client.connect(device, { remember: true }); await tick();
  const rejected = assert.rejects(operation, /cancelled/); await f.client.cancel(); await rejected;
  assert.equal(f.client.snapshot().busy, false); assert.equal(f.client.snapshot().error, ''); assert.equal(f.attempts, 0);
  f.advertise(); await f.client.connect(device, { reconnect: false }); assert.equal(f.client.snapshot().authenticated, true); f.client.destroy();
});

test('a suspended pending connection is bounded and its late result cannot authenticate', async () => {
  let resolve;
  const f = wakeFixture({ connectPending: () => new Promise(yes => { resolve = yes; }), client: { windowMs: 50 } }); f.advertise();
  const operation = f.client.connect(device); await tick();
  await assert.rejects(operation, /window ended/); assert.equal(f.client.snapshot().busy, false);
  assert.equal(f.client.snapshot().acquisition.active, false); assert.equal(f.fast.at(-1), false);
  f.state.ble.connected = true; resolve(f.state); await tick();
  assert.equal(f.client.snapshot().authenticated, false); assert.equal(f.state.ble.connected, false);
  assert.equal(f.writes.some(item => item.kind === 'subscribe'), false); f.client.destroy();
});

test('stale address types, connection attempts and board timestamps cannot satisfy authentication', async () => {
  const f = fixture({ timeout: true, client: { timeoutMs: 1000 } }); f.state.uptime = 200;
  const operation = f.client.connect(device); await tick();
  const reply = '03' + 'a9'.repeat(8) + '04'.repeat(8);
  f.emit('auth', reply, { addressType: 0 }); f.emit('auth', reply, { connectionAttempt: 6 }); f.emit('auth', reply, { ms: 199000 });
  assert.equal(f.writes.some(item => item.hex?.startsWith('04')), false);
  const rejected = assert.rejects(operation, /cancelled/); await f.client.cancel(); await rejected; f.client.destroy();
});
