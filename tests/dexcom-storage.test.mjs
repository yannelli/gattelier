import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { create } = require('../web/dexcom-storage.js');
const device = { address: '02:00:00:00:00:07', addressType: 1 };
function fixture() {
  const entries = new Map(); let board = 'http://test-board.local';
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  return { entries, storage, store: create({ storage, origin: () => board, now: () => 100 }), board: value => { board = value; } };
}
test('G7 sessions are scoped to board, sensor address, and address type without PIN storage', () => {
  const f = fixture(), key = 'a1'.repeat(16);
  f.store.saveSession(device, { key, pin: '0123' });
  assert.deepEqual(f.store.loadSession(device), { key });
  assert.equal(f.store.loadSession({ ...device, addressType: 0 }), null);
  assert.equal(f.store.loadSession({ ...device, address: '02:00:00:00:00:08' }), null);
  assert.ok(![...f.entries.values()].join().includes('0123'));
  f.board('http://another-board.local'); assert.equal(f.store.loadSession(device), null);
  f.board('http://test-board.local'); f.store.forgetSession(device); assert.equal(f.store.hasSession(device), false);
});
test('G7 storage rejects malformed keys and handles damaged saved data', () => {
  const f = fixture();
  for (const key of ['', 'ab'.repeat(15), 'zz'.repeat(16)]) assert.throws(() => f.store.saveSession(device, { key }), /Invalid/);
  f.store.saveSession(device, { key: '00'.repeat(16) });
  f.entries.set([...f.entries.keys()][0], '{'); assert.equal(f.store.loadSession(device), null);
  f.board(''); assert.throws(() => f.store.saveSession(device, { key: '00'.repeat(16) }), /unavailable/);
});
test('saved readings are bounded and omit authentication and unrelated trace fields', () => {
  const f = fixture(), records = Array.from({ length: 5001 }, (_, clock) => ({ clock, glucoseMgDl: 120, state: 6, stateLabel: 'OK', key: 'secret', hex: 'secret' }));
  f.store.saveReadings(device, { records, sessionKey: 'secret', pin: '0123' });
  const saved = f.store.loadReadings(device); assert.equal(saved.records.length, 5000); assert.equal(saved.records[0].clock, 1);
  assert.ok(![...f.entries.values()].join().includes('secret'));
  f.store.clearReadings(device); assert.equal(f.store.loadReadings(device), null);
});
