import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), p = require('../web/dexcom-protocol.js'), { createClient } = require('../web/dexcom.js');
const device = { address: '02:00:00:00:00:07', addressType: 1 };
const receivedAt = Date.UTC(2026, 9, 25, 12);
const glucoseHex = '4e0064000000070000000a007b0006fb820000';
const historyHex = '5a0000007b000600fb';
const identityHex = '4a0020c06d282a34000031313131887766554433';

test('G7 control layout decodes native glucose, state, age and estimated timestamps', () => {
  const reading = p.decode(p.CONTROL, glucoseHex, { receivedAt });
  assert.equal(reading.glucoseMgDl, 123); assert.equal(reading.glucoseRaw, 123);
  assert.equal(reading.clock, 100); assert.equal(reading.ageSeconds, 10); assert.equal(reading.sequence, 7);
  assert.equal(reading.trendMgDlMinute, -0.5); assert.equal(reading.predictedRaw, 130);
  assert.equal(reading.stateLabel, 'OK'); assert.equal(reading.timestamp, receivedAt - 10000);
  assert.equal(reading.estimatedStart, receivedAt - 100000);
  assert.equal(p.decode(p.CONTROL, glucoseHex).timestamp, null);
  assert.equal(p.decode(p.CONTROL, glucoseHex).estimatedStart, null);
});

test('state codes and reserved values retain raw bytes without a glucose measurement', () => {
  const bytes = p.bytes(glucoseHex); bytes[14] = 0x19;
  assert.equal(p.decode(p.CONTROL, bytes).stateLabel, 'Sensor failed 7');
  assert.equal(p.decode(p.CONTROL, bytes).glucoseMgDl, null);
  bytes[14] = 6; bytes[13] = 0x10;
  assert.equal(p.decode(p.CONTROL, bytes).displayOnly, true);
  assert.equal(p.decode(p.CONTROL, bytes).glucoseMgDl, null);
  bytes[13] = 0; bytes[12] = 13; bytes[15] = 127;
  assert.equal(p.decode(p.CONTROL, bytes).glucoseMgDl, null);
  assert.equal(p.decode(p.CONTROL, bytes).trendMgDlMinute, null);
  assert.equal(p.stateLabel(0xe0), 'Unknown state 0xe0');
  assert.equal(p.stateLabel(0xc2), 'Sensor stopped');
});

test('G7 identity reads all six serial bytes without 32-bit truncation', () => {
  const identity = p.decode(p.CONTROL, identityHex);
  assert.equal(identity.serial, String(0x334455667788));
  assert.equal(identity.firmware, '32.192.109.40'); assert.equal(identity.build, 13354);
  assert.equal(identity.versionCode, 0x31313131);
});

test('G7 native backfill accepts multiple nine-byte records on its own characteristic', () => {
  const result = p.decode(p.BACKFILL, historyHex + historyHex);
  assert.equal(result.records.length, 2); assert.equal(result.records[0].clock, 90);
  assert.equal(result.records[0].glucoseMgDl, 123); assert.equal(result.records[0].trendMgDlMinute, -0.5);
  assert.equal(result.records[0].extra, 0); assert.equal(result.records[0].source, 'backfill');
  assert.throws(() => p.decode(p.CONTROL, historyHex), /Unsupported/);
  assert.throws(() => p.decode('f8083535-849e-531c-c594-30f1f86a4ea5', glucoseHex), /characteristic/);
});

test('packet validation rejects partial bytes, truncated frames and impossible reading ages', () => {
  for (const value of ['', 'zz', '0', '12-34']) assert.throws(() => p.bytes(value), /byte pairs/);
  assert.throws(() => p.decode(p.CONTROL, glucoseHex.slice(0, -2)), /19 bytes/);
  assert.throws(() => p.decode(p.CONTROL, identityHex.slice(0, -2)), /20 bytes/);
  assert.throws(() => p.decode(p.BACKFILL, historyHex.slice(0, -2)), /9-byte/);
  const bytes = p.bytes(glucoseHex); bytes[10] = 101;
  assert.throws(() => p.decode(p.CONTROL, bytes), /age exceeds/);
  assert.throws(() => p.decode(p.BACKFILL, '00'.repeat(513)), /512/);
});

test('history timestamps require an original receive-time anchor and deduplicate sensor seconds', () => {
  const store = p.createStore(device); store.add(p.BACKFILL, historyHex);
  assert.equal(store.snapshot().records[0].timestamp, null);
  store.add(p.CONTROL, glucoseHex, { receivedAt });
  assert.equal(store.snapshot().records.length, 1);
  assert.equal(store.snapshot().records[0].timestamp, receivedAt - 10000);
  store.add(p.BACKFILL, historyHex);
  assert.equal(store.snapshot().records.length, 1);
  assert.equal(store.snapshot().records[0].timestamp, receivedAt - 10000);
  assert.deepEqual(store.snapshot().scope, device);
});

function fixture() {
  let state = { uptime: 200, ble: { connected: true, address: device.address }, services: [{ uuid: p.SERVICE, characteristics: [{ uuid: p.CONTROL, handle: 4 }, { uuid: p.BACKFILL, handle: 6 }] }] };
  const eventListeners = new Set(), stateListeners = new Set(), actions = [];
  const lab = { getState: () => state,
    onState(callback) { stateListeners.add(callback); callback(state, true); return () => stateListeners.delete(callback); },
    onEvents(callback) { eventListeners.add(callback); return () => eventListeners.delete(callback); },
    action(...args) { actions.push(args); throw new Error('Capture must not perform board actions.'); }
  };
  const client = createClient(lab, { now: () => receivedAt });
  const emit = (events = [], meta = {}) => { for (const callback of eventListeners) callback(events, { bootId: 'boot-1', gaps: 0, ...meta }); };
  const event = (extra = {}) => ({ seq: 2, address: device.address, kind: 'notification', handle: 4, uuid: p.CONTROL, hex: glucoseHex, ms: 199000, ...extra });
  const setState = (next, online = true) => { state = next; for (const callback of stateListeners) callback(state, online); };
  const start = () => { client.listen(device); emit([], { cursor: 1 }); };
  return { client, emit, event, setState, start, state, actions, eventListeners, stateListeners };
}

test('capture requires the connected Dexcom service and ignores replay and other device traffic', () => {
  const f = fixture(); f.start();
  f.emit([f.event({ seq: 1 }), f.event({ address: '02:00:00:00:00:08' }), f.event({ seq: 3, handle: 9 }), f.event({ seq: 4, uuid: p.BACKFILL }), f.event({ seq: 5 })]);
  assert.equal(f.client.snapshot().packets, 1);
  assert.equal(f.client.snapshot().latest.timestamp, receivedAt - 11000);
  assert.deepEqual(f.actions, []); f.client.destroy();
  assert.equal(f.eventListeners.size, 0); assert.equal(f.stateListeners.size, 0);
});

test('capture stops on missing data, restarts, incomplete payloads and connection changes', () => {
  for (const failure of ['gap', 'restart', 'truncated', 'length', 'offline', 'address']) {
    const f = fixture(); f.start();
    if (failure === 'gap') f.emit([], { gaps: 1 });
    if (failure === 'restart') f.emit([], { bootId: 'boot-2' });
    if (failure === 'truncated') f.emit([f.event({ truncated: true })]);
    if (failure === 'length') f.emit([f.event({ length: 20 })]);
    if (failure === 'offline') f.setState(f.state, false);
    if (failure === 'address') f.setState({ ...f.state, ble: { connected: true, address: '02:00:00:00:00:08' } });
    assert.equal(f.client.snapshot().listening, false, failure); assert.ok(f.client.snapshot().error, failure);
    assert.equal(f.client.snapshot().packets, 0, failure); f.client.destroy();
  }
});

test('selection changes clear previous health data and import requires an explicit device scope', () => {
  const f = fixture(); assert.throws(() => f.client.importPacket(null, p.CONTROL, glucoseHex), /Select/);
  f.client.importPacket(device, p.CONTROL, glucoseHex); assert.equal(f.client.snapshot().packets, 1);
  f.client.select({ ...device, addressType: 0 }); assert.equal(f.client.snapshot().packets, 0);
  f.start(); assert.throws(() => f.client.importPacket(device, p.CONTROL, glucoseHex), /Stop capture/);
  f.client.select(null); assert.equal(f.client.snapshot().listening, false); assert.equal(f.client.snapshot().records.length, 0);
  f.client.destroy();
});
