import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { select } = require('../web/scan-query.js');
const devices = [
  { key: 'b/0', address: 'bb:00:00:00:00:01', name: 'Recorder', label: 'Office', rssi: -60, lastSeenMs: 95000, firstSeenMs: 1000, observations: 8,
    liveId: 12, connectable: true, favorite: true, services: ['0x1910'], serviceData: [{ uuid: '0x1234', hex: '01' }] },
  { key: 'a/0', address: 'aa:00:00:00:00:01', name: 'Beacon', rssi: -60, lastSeenMs: 80000, firstSeenMs: 3000, observations: 20,
    liveId: null, connectable: false, favorite: false, services: ['0x180f'] },
  { key: 'c/1', address: 'cc:00:00:00:00:01', name: 'Alpha', rssi: -30, lastSeenMs: 99000, firstSeenMs: 2000, observations: 2,
    liveId: 22, connectable: true, favorite: false, services: [] },
];
const keys = result => result.map(item => item.key);
const context = { now: 100000, identifyVendor: item => item.key === 'a/0' ? { manufacturer: 'Acme', search: 'Acme Radio' } : '',
  profile: item => ({ category: item.key === 'b/0' ? 'recorder' : 'other' }) };

test('search matches names, labels, addresses, vendors and advertised service UUIDs', () => {
  for (const query of ['recorder', 'OFFICE', ' BB:00 ', '1910', '1234']) assert.deepEqual(keys(select(devices, { query }, context)), ['b/0']);
  assert.deepEqual(keys(select(devices, { query: 'Acme' }, context)), ['a/0']);
  assert.deepEqual(keys(select(devices, { query: 'Unknown' }, context)), []);
  assert.deepEqual(keys(select(devices, { query: 'Dexcom' }, { ...context, profile: item => ({ title: item.key === 'c/1' ? 'Dexcom metadata' : '' }) })), ['c/1']);
});
test('filters combine signal, age, category, availability and favorites', () => {
  assert.deepEqual(keys(select(devices, { signal: -50 }, context)), ['c/1']);
  assert.deepEqual(keys(select(devices, { signal: '-60', lastSeen: '5', source: 'live' }, context)), ['c/1', 'b/0']);
  assert.deepEqual(keys(select(devices, { kind: 'recorder', connectable: true, favorites: true }, context)), ['b/0']);
  assert.deepEqual(keys(select(devices, { connectable: 'no' }, context)), ['a/0']);
  assert.deepEqual(keys(select(devices, { source: 'history' }, context)), ['a/0']);
  assert.deepEqual(keys(select(devices, { lastSeen: 1 }, { now: () => 100000 })), ['c/1']);
  assert.equal(select(devices, { signal: 'all', lastSeen: 'all', kind: 'all', source: 'all', connectable: 'all', favorites: false }).length, 3);
});
test('sort orders use deterministic identity ties without mutating input', () => {
  const before = JSON.stringify(devices);
  assert.deepEqual(keys(select(devices, { sort: 'strength' })), ['c/1', 'a/0', 'b/0']);
  assert.deepEqual(keys(select(devices, { sort: 'recent' })), ['c/1', 'b/0', 'a/0']);
  assert.deepEqual(keys(select(devices, { sort: 'name' })), ['c/1', 'a/0', 'b/0']);
  assert.deepEqual(keys(select(devices, { sort: 'first' })), ['b/0', 'c/1', 'a/0']);
  assert.deepEqual(keys(select(devices, { sort: 'observations' })), ['a/0', 'b/0', 'c/1']);
  const ties = devices.map(item => ({ ...item, rssi: -50, lastSeenMs: 1, firstSeenMs: 1, observations: 1, name: 'same', label: '' }));
  for (const sort of ['strength', 'recent', 'name', 'first', 'observations']) assert.deepEqual(keys(select(ties, { sort })), ['a/0', 'b/0', 'c/1']);
  assert.equal(JSON.stringify(devices), before);
});
test('missing live IDs cannot become live matches and absent optional metadata is searchable', () => {
  const historical = { key: 'old/1', address: 'dd:00:00:00:00:01', name: 'Old recorder' };
  assert.deepEqual(select([historical], { source: 'live' }), []);
  assert.deepEqual(select([historical], { query: 'old' }), [historical]);
  assert.deepEqual(select([historical], { signal: -90 }), []);
  assert.deepEqual(select([historical], { lastSeen: 60 }, context), []);
});

test('streamed discoveries remain visible after their board cache IDs are evicted', () => {
  const streamed = { ...devices[1], liveId: null, streamLive: true };
  assert.deepEqual(select([streamed], { source: 'live' }), [streamed]);
  assert.deepEqual(select([streamed], { source: 'history' }), []);
  assert.deepEqual(select([{ ...streamed, streamLive: false }], { source: 'live' }), []);
});

test('remembered GATT names remain searchable behind labels and advertisements and participate in name sorting', () => {
  const items = [
    { key: 'a/0', label: 'Zulu', name: 'Alpha', gattName: 'Kitchen sensor' },
    { key: 'b/0', name: 'Bravo', gattName: 'Zulu' },
    { key: 'c/0', name: '', gattName: 'Alpha' },
  ];
  assert.deepEqual(keys(select(items, { query: 'KITCHEN' })), ['a/0']);
  assert.deepEqual(keys(select(items, { sort: 'name' })), ['c/0', 'b/0', 'a/0']);
});
