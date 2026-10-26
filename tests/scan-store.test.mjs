import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { create } = require('../web/scan-store.js');
const copy = value => JSON.parse(JSON.stringify(value));
const address = 'AA:BB:CC:DD:EE:01';
const key = 'aa:bb:cc:dd:ee:01/0';
const device = (extra = {}) => ({ id: 12, address, addressType: 0, name: 'Recorder', rssi: -55, connectable: true,
  lastSeen: 90, services: ['0x1910'], manufacturer: 'abcd', payloadHex: '02ffab', serviceData: [{ uuid: '1234', hex: '00' }], ...extra });
const board = (devices = [device()], uptime = 100) => ({ devices, uptime, services: [{ valueHex: 'secret' }], credentials: 'secret' });
function memoryStorage(initial = null) {
  return { value: initial, writes: 0, async load() { return copy(this.value); }, async save(value) { this.writes++; this.value = copy(value); } };
}

test('persistence allowlists advertisements and statistics without live IDs or session material', async () => {
  const storage = memoryStorage(), store = create({ storage, now: () => 1000000 }); await store.init();
  store.ingest(board([device({ credentials: 'secret', privateKeyPem: 'secret', valueHex: 'secret', session: { key: 'secret' },
    serviceData: [{ uuid: '1234', hex: '00', secret: 'secret' }] })]), 1000000);
  store.annotate(key, { label: 'My recorder', favorite: true, credentials: 'secret' });
  await store.flush();
  const persisted = storage.value.records[0];
  assert.equal(persisted.key, key); assert.equal(persisted.firstSeenMs, 990000);
  assert.equal(persisted.lastSeenMs, 990000); assert.equal(persisted.label, 'My recorder');
  assert.equal(persisted.favorite, true); assert.equal(persisted.observations, 1);
  assert.equal('liveId' in persisted, false); assert.equal('id' in persisted, false);
  assert.equal(JSON.stringify(storage.value).includes('secret'), false);
  assert.equal(JSON.stringify(store.exportData()).includes('liveId'), false);
  const restored = create({ storage }); await restored.init();
  assert.equal(restored.devices()[0].liveId, null); assert.equal(restored.devices()[0].label, 'My recorder');
  restored.ingest(board([device()], 110), 1010000);
  assert.equal(restored.devices()[0].observations, 1); assert.equal(restored.devices()[0].lastSeenMs, 990000);
  await restored.flush();
});
test('repeated and older board observations do not rejuvenate cached records', async () => {
  const store = create({ storage: null }); await store.init();
  store.ingest(board(), 1000000);
  store.ingest(board([device()], 120), 1020000);
  store.ingest(board([device({ lastSeen: 89, name: 'Older name', rssi: -99 })], 121), 1021000);
  const unchanged = store.devices()[0];
  assert.equal(unchanged.observations, 1); assert.equal(unchanged.lastSeenMs, 990000);
  assert.equal(unchanged.name, 'Recorder'); assert.equal(unchanged.rssi, -55); assert.equal(unchanged.history.length, 1);
  store.ingest(board([device({ lastSeen: 121, rssi: -45 })], 122), 1022000);
  assert.equal(store.devices()[0].observations, 2); assert.equal(store.devices()[0].lastSeenMs, 1021000);
});
test('reboots, missing devices and offline state clear live IDs while retaining annotations', async () => {
  const store = create({ storage: null }); await store.init();
  store.ingest(board([device(), device({ id: 13, address: 'AA:BB:CC:DD:EE:02' })]), 1000000);
  store.annotate(key, { label: 'Desk', favorite: true });
  store.ingest(board([device({ id: 1, lastSeen: 3 })], 4), 1020000);
  const record = store.devices().find(item => item.key === key);
  assert.equal(record.liveId, 1); assert.equal(record.firstSeenMs, 990000); assert.equal(record.lastSeenMs, 1019000);
  assert.equal(record.observations, 2); assert.equal(record.label, 'Desk'); assert.equal(record.favorite, true);
  assert.equal(store.devices().find(item => item.key !== key).liveId, null);
  store.setOffline(); assert.ok(store.devices().every(item => item.liveId === null));
  store.ingest(null); assert.equal(store.devices().length, 2);
  assert.equal(store.devices()[0].lastSeenMs, 1019000);
});
test('address and address type form identity and observations keep 60 unique samples', async () => {
  const store = create({ storage: null }); await store.init();
  for (let i = 0; i < 65; i++) store.ingest(board([device({ lastSeen: i })], i), 1000000 + i * 1000);
  store.ingest(board([device({ address: address.toLowerCase(), lastSeen: 64 }), device({ addressType: 1, lastSeen: 64 })], 65), 1065000);
  const records = store.devices(), publicRecord = records.find(item => item.key === key);
  assert.equal(records.length, 2); assert.equal(publicRecord.observations, 65); assert.equal(publicRecord.history.length, 60);
  assert.equal(new Set(publicRecord.history.map(item => item.at)).size, 60);
  records[0].history[0].rssi = 999; records[0].services.push('mutated');
  assert.equal(store.devices()[0].history[0].rssi, -55); assert.equal(store.devices()[0].services.includes('mutated'), false);
});
test('persistence controls keep memory usable and preference writes reject unknown keys', async () => {
  const storage = memoryStorage(), store = create({ storage }); await store.init();
  assert.equal(store.getPreference('backgroundScan'), false);
  assert.equal(store.setPreference('credentials', 'secret'), false);
  assert.equal(store.setPreference('view', 'table'), true); assert.equal(store.getPreference('view'), 'table');
  assert.equal(store.getPreference('missing', 'fallback'), 'fallback');
  store.ingest(board(), 1000000); await store.flush();
  await store.setPersistence(false); assert.equal(storage.value.records.length, 0);
  assert.equal(store.devices().length, 1); assert.equal(store.status().persistent, false);
  await store.setPersistence(true); assert.equal(storage.value.records.length, 1);
  await store.clearHistory(); assert.equal(store.devices().length, 0); assert.equal(storage.value.records.length, 0);
});
test('a save that overlaps new observations flushes the latest snapshot', async () => {
  const storage = memoryStorage(), store = create({ storage }); await store.init(); await store.flush();
  let release, started;
  const saving = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  storage.save = async function (value) {
    if (first) { first = false; started(); await gate; }
    this.value = copy(value);
  };
  store.ingest(board(), 1000000); const flushing = store.flush(); await saving;
  store.ingest(board([device({ lastSeen: 110 })], 110), 1010000); release();
  await flushing;
  assert.equal(storage.value.records[0].observations, 2); assert.equal(storage.value.records[0].lastSeenMs, 1010000);
});
test('quota and unavailable database errors leave all current records in memory', async () => {
  const storage = memoryStorage(), store = create({ storage }); await store.init();
  storage.save = async () => { throw new Error('Quota exceeded'); };
  store.ingest(board(), 1000000); assert.equal(await store.flush(), false);
  store.ingest(board([device({ lastSeen: 101 })], 101), 1001000);
  assert.equal(store.devices()[0].observations, 2);
  assert.deepEqual(store.status(), { persistent: false, available: false, error: 'Scan history is kept in memory: Quota exceeded', count: 1, evicted: 0 });
  const unavailable = create({ storage: null }); await unavailable.init(); unavailable.ingest(board(), 1000000);
  assert.equal(unavailable.status().available, false); assert.match(unavailable.status().error, /memory/);
  assert.equal(unavailable.devices().length, 1);
});
test('only historical entries count toward the 10000-record retention limit', async () => {
  const store = create({ storage: null }); await store.init();
  const devices = Array.from({ length: 10002 }, (_, index) => device({ id: index + 1,
    address: `02:00:00:${index.toString(16).padStart(6, '0').match(/../g).join(':')}` }));
  store.ingest(board(devices), 1000000);
  assert.equal(store.status().count, 10002); assert.equal(store.status().evicted, 0);
  store.ingest(board([devices[0]], 101), 1001000);
  assert.equal(store.status().count, 10001); assert.equal(store.status().evicted, 1);
  assert.equal(store.devices().find(item => item.address === devices[0].address).liveId, 1);
  store.setOffline(); assert.equal(store.status().count, 10000); assert.equal(store.status().evicted, 2);
});
const importedRecord = (extra = {}) => ({ ...device(), firstSeenMs: 900000, lastSeenMs: 950000, observations: 5,
  history: [{ at: 900000, rssi: -65 }, { at: 950000, rssi: -55 }], label: 'Imported label', favorite: true, ...extra });
test('import validates the entire file before changing existing records', async () => {
  const store = create({ storage: null, now: () => 1000000 }); await store.init(); store.ingest(board(), 1000000);
  const before = store.exportData();
  const invalid = [null, [], { schemaVersion: 2, records: [] }, { schemaVersion: 1, records: {} },
    { schemaVersion: 1, records: Array(10001).fill(importedRecord()) }];
  for (const record of [null, [], importedRecord({ address: 'invalid' }), importedRecord({ name: 42 }),
    importedRecord({ addressType: 8 }), importedRecord({ history: [{ at: 1, rssi: 'bad' }] }),
    importedRecord({ firstSeenMs: NaN }), importedRecord({ favorite: 'yes' }), importedRecord({ payloadHex: '00'.repeat(1651) }),
    importedRecord({ manufacturer: 'zz' }), importedRecord({ serviceData: [{ uuid: '1234', hex: '00'.repeat(513) }] }),
    Object.assign(Object.create({ inherited: true }), importedRecord())]) {
    invalid.push({ schemaVersion: 1, records: [importedRecord({ name: 'Would replace' }), record] });
  }
  for (const snapshot of invalid) { assert.throws(() => store.importData(snapshot)); assert.deepEqual(store.exportData(), before); }
});
test('import strips connection IDs, secrets and prototype fields before persistence', async () => {
  const storage = memoryStorage(), store = create({ storage, now: () => 1000000 }); await store.init();
  const record = JSON.parse(JSON.stringify(importedRecord({ liveId: 999, id: 999, credentials: 'secret', privateKeyPem: 'secret',
    gatt: [{ valueHex: 'secret' }], sessionKey: 'secret', serviceData: [{ uuid: '1234', hex: '00', password: 'secret' }] })));
  Object.defineProperty(record, '__proto__', { value: { polluted: true }, enumerable: true });
  assert.deepEqual(store.importData({ schemaVersion: 1, records: [record] }), { imported: 1, count: 1 });
  assert.equal(store.devices()[0].liveId, null); await store.flush();
  const saved = JSON.stringify(storage.value);
  for (const value of ['liveId', 'secret', '__proto__', 'polluted', 'sessionKey']) assert.equal(saved.includes(value), false);
  assert.equal({}.polluted, undefined);
});
test('import merges annotations and unique samples without replacing live advertisement metadata', async () => {
  const store = create({ storage: null, now: () => 1000000 }); await store.init(); store.ingest(board(), 1000000);
  store.annotate(key, { label: 'Current label' });
  const snapshot = { schemaVersion: 1, records: [importedRecord({ name: 'Old recorder', rssi: -90, liveId: 999,
    lastSeenMs: 999000, observations: 10, history: [{ at: 990000, rssi: -99 }, { at: 999000, rssi: -90 }] })] };
  store.importData(snapshot);
  const merged = store.devices()[0];
  assert.equal(merged.liveId, 12); assert.equal(merged.name, 'Recorder'); assert.equal(merged.rssi, -55);
  assert.equal(merged.label, 'Current label'); assert.equal(merged.favorite, true); assert.equal(merged.observations, 10);
  assert.equal(merged.history.filter(item => item.at === 990000).length, 1); assert.equal(merged.history.find(item => item.at === 990000).rssi, -55);
  const before = store.exportData(); store.importData(snapshot); assert.deepEqual(store.exportData(), before);
  assert.equal(merged.firstSeenMs, 900000); assert.equal(merged.lastSeenMs, 999000);
});
test('historical imports use newest metadata, clamp future times and remain idempotent after history trimming', async () => {
  const store = create({ storage: null, now: () => 1000000 }); await store.init();
  const first = { schemaVersion: 1, records: [importedRecord({ name: 'Earlier', history: Array.from({ length: 60 }, (_, i) => ({ at: 900000 + i, rssi: -50 })) })] };
  const newer = { schemaVersion: 1, records: [importedRecord({ name: 'Later', firstSeenMs: 2000000, lastSeenMs: 1500000,
    boardStartedMs: 2000000, history: Array.from({ length: 60 }, (_, i) => ({ at: 999950 + i, rssi: -40 })) })] };
  store.importData(first); store.importData(newer);
  const record = store.devices()[0];
  assert.equal(record.name, 'Later'); assert.equal(record.firstSeenMs, 900000); assert.equal(record.lastSeenMs, 1000000);
  assert.equal(record.boardStartedMs, 1000000); assert.equal(record.liveId, null); assert.equal(record.history.length, 60);
  assert.ok(record.history.every(sample => sample.at <= 1000000)); assert.ok(record.firstSeenMs <= record.lastSeenMs);
  const before = store.exportData(); store.importData(first); store.importData(newer);
  assert.deepEqual(store.exportData(), before);
});

const streamBatch = (devices, extra = {}) => ({ bootId: 'board-boot-1', uptime: 100, oldestSeq: 1,
  cursor: Math.max(0, ...devices.map(item => item.seq)), dropped: 0, cacheIds: [], capacity: 96, devices, ...extra });
const streamed = (seq, extra = {}) => device({ seq, ms: 90000 + seq, ...extra });
test('advertisement deltas preserve previous devices and clear only evicted board IDs', async () => {
  const store = create({ storage: null }); await store.init();
  store.ingestAdvertisements(streamBatch([streamed(1)], { cacheIds: [12] }), 1000000);
  store.ingestAdvertisements(streamBatch([streamed(2, { id: 13, address: '02:00:00:00:00:02' })], { cacheIds: [13] }), 1000100);
  const first = store.devices().find(item => item.key === key);
  assert.equal(first.liveId, null); assert.equal(first.streamLive, true); assert.equal(first.addressType, 0);
  assert.equal(store.devices().find(item => item.liveId === 13).streamLive, true);
  store.ingest(board([], 101), 1001000); assert.ok(store.devices().every(item => item.streamLive));
  assert.equal(store.status().stream.received, 2);
});
test('stream sequences count same-second observations once and preserve precise receive time', async () => {
  const storage = memoryStorage(), store = create({ storage }); await store.init();
  const batch = streamBatch([streamed(1), streamed(2, { rssi: -40 })]);
  store.ingestAdvertisements(batch, 1000000); store.ingestAdvertisements(batch, 1005000);
  const record = store.devices()[0]; assert.equal(record.observations, 2); assert.equal(record.firstSeenMs, 990001); assert.equal(record.lastSeenMs, 990002);
  assert.equal(record.history.length, 2); assert.equal(record.rssi, -40); assert.equal(store.status().stream.received, 2);
  await store.flush(); const saved = JSON.stringify(storage.value);
  for (const field of ['streamLive', 'seq', 'liveId']) assert.equal(saved.includes(`"${field}"`), false);
  const restored = create({ storage }); await restored.init(); assert.equal(restored.devices()[0].streamLive, undefined);
});
test('stream reports overwritten advertisements and reboots without deleting browser history', async () => {
  const store = create({ storage: null }); await store.init();
  store.ingestAdvertisements(streamBatch([streamed(4)], { oldestSeq: 4, dropped: 3, cacheIds: [12], cacheBytes: 2048, journalBytes: 12000, truncatedTotal: 2 }), 1000000);
  assert.equal(store.status().stream.gaps, 3); assert.equal(store.status().stream.truncatedTotal, 2);
  store.ingestAdvertisements(streamBatch([streamed(4)], { oldestSeq: 4, dropped: 3 }), 1000500); assert.equal(store.status().stream.gaps, 3);
  store.ingestAdvertisements(streamBatch([streamed(1, { id: 1, address: '02:00:00:00:00:02', ms: 500, lastSeen: 0 })], { bootId: 'board-boot-2', uptime: 1, cacheIds: [1] }), 1001000);
  assert.equal(store.status().stream.reboots, 1); assert.equal(store.devices().length, 2);
  assert.equal(store.devices().find(item => item.key === key).streamLive, false); assert.equal(store.devices().find(item => item.liveId === 1).streamLive, true);
  store.resetStream(); assert.ok(store.devices().every(item => !item.streamLive && item.liveId === null));
});
test('malformed stream records leave the cursor and history unchanged', async () => {
  const store = create({ storage: null }); await store.init(); store.ingestAdvertisements(streamBatch([streamed(1)]), 1000000);
  const before = store.exportData();
  assert.throws(() => store.ingestAdvertisements(streamBatch([streamed(2, { address: 'bad' })])), /Invalid/);
  assert.equal(store.status().stream.cursor, 1); assert.deepEqual(store.exportData(), before);
});
test('continuous 500ms stream batches do not postpone browser persistence', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = memoryStorage(), store = create({ storage }); await store.init(); await store.flush();
  const before = storage.writes;
  store.ingestAdvertisements(streamBatch([streamed(1)]), 1000000);
  context.mock.timers.tick(500); store.ingestAdvertisements(streamBatch([streamed(2)]), 1000500);
  context.mock.timers.tick(200); await Promise.resolve(); await Promise.resolve();
  assert.equal(storage.writes, before + 1); assert.equal(storage.value.records[0].observations, 2);
});
