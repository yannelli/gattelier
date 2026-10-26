import test from 'node:test';
import assert from 'node:assert/strict';
import history from '../web/sensor-history.js';
const device = (at, extra = {}) => ({ address: '02:00:00:00:00:01', addressType: 0, name: 'Fixture', lastSeenMs: at, rssi: -60, ...extra });
const profile = (value, extra = {}) => ({ fields: [{ label: 'Temperature', value: `${value} °C`, numericValue: value, unit: '°C' }], ...extra });
const storage = () => ({ value: null, async load() { return this.value; }, async save(value) { this.value = structuredClone(value); } });

test('history records changed values, samples repeats, and ignores old observations', () => {
  const store = history.create({ now: () => 1e7, storage: null });
  assert.equal(store.ingest(device(1000), profile(20)), true);
  assert.equal(store.ingest(device(1000), profile(30)), false);
  assert.equal(store.ingest(device(1100), profile(20)), false);
  assert.equal(store.ingest(device(6000), profile(20)), true);
  assert.equal(store.ingest(device(6100), profile(21)), true);
  const series = store.series(device(0), 'Temperature');
  assert.deepEqual(series.map(point => point.value), [20, 20, 21]);
  assert.equal(store.summary(series).average, 61 / 3);
  assert.equal(store.summary([]), null);
});
test('retention is bounded by sensor and sample count', () => {
  const store = history.create({ now: () => 1e7, storage: null });
  for (let n = 1; n <= 700; n++) store.ingest(device(n * 6000), profile(n));
  assert.equal(store.samples(device(0)).length, 600); assert.equal(store.samples(device(0))[0].fields[0].value, 101);
  for (let n = 1; n <= 40; n++) store.ingest(device(5e6 + n, { address: `02:00:00:00:01:${n.toString(16).padStart(2, '0')}` }), profile(n));
  assert.equal(store.status().devices, 32); assert.equal(store.samples(device(0)).length, 0);
});
test('unencrypted history persists while authenticated readings require explicit export', async () => {
  const adapter = storage(), store = history.create({ storage: adapter, now: () => 1e7 }); await store.init();
  store.ingest(device(1000), profile(20)); store.ingest(device(2000), profile(123.456, { authenticated: true, key: 'never-saved' })); await store.flush();
  assert.equal(store.exportDevice(device(0)).samples.length, 2); assert.equal(adapter.value.devices[0].samples.length, 1);
  assert.equal(JSON.stringify(adapter.value).includes('123.456'), false); assert.equal(JSON.stringify(store.exportDevice(device(0))).includes('never-saved'), false);
  const restored = history.create({ storage: adapter, now: () => 1e7 }); await restored.init();
  assert.equal(restored.samples(device(0)).length, 1); assert.equal(restored.samples(device(0))[0].fields[0].value, 20);
  await store.clear(device(0)); assert.deepEqual(adapter.value.devices, []);
});
test('history does not mix units and CSV retains timestamps and numbers', () => {
  const store = history.create({ storage: null, now: () => 1e7 }); store.ingest(device(1000), profile(20));
  store.ingest(device(2000), { fields: [{ label: 'Temperature', numericValue: 68, value: '68 °F', unit: '°F' }] });
  assert.deepEqual(store.series(device(0), 'Temperature').map(point => point.value), [68]);
  assert.match(store.csv(device(0)), /1970-01-01T00:00:01.000Z/); assert.match(store.csv(device(0)), /"Temperature","68","°F"/);
});
test('storage failure preserves readings and loading merges observations captured during startup', async () => {
  let resolve; const adapter = { load: () => new Promise(done => { resolve = done; }), save: async () => { throw new Error('Quota exceeded'); } };
  const store = history.create({ storage: adapter, now: () => 1e7 }), init = store.init(); store.ingest(device(3000), profile(21));
  resolve({ version: 1, devices: [{ device: device(0), samples: [{ at: 1000, fields: [{ label: 'Temperature', value: 20, unit: '°C' }] }] }] }); await init;
  assert.equal(store.samples(device(0)).length, 2); assert.equal(await store.flush(), false); assert.match(store.status().error, /Quota/);
  assert.equal(store.samples(device(0)).length, 2);
});
test('clearing a sensor during startup prevents delayed saved history from returning', async () => {
  let resolve, saved;
  const adapter = { load: () => new Promise(done => { resolve = done; }), save: async value => { saved = value; } };
  const store = history.create({ storage: adapter, now: () => 1e7 }), initialized = store.init();
  await store.clear(device(0));
  resolve({ version: 1, devices: [{ device: device(0), samples: [{ at: 1000, fields: [{ label: 'Temperature', value: 20, unit: '°C' }] }] }] });
  await initialized; await store.flush(); assert.deepEqual(store.samples(device(0)), []); assert.deepEqual(saved.devices, []);
});
