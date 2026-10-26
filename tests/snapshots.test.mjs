import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const model = require('../web/snapshot-model.js');
const device = () => ({ address: '02:00:00:00:00:03', addressType: 1, name: 'Recorder', manufacturer: '0102', payloadHex: '03030918',
  services: ['0x1809'], serviceData: [{ uuid: '1809', hex: '0100' }], firstSeen: 10, lastSeen: 20, rssi: -61 });
const characteristic = (handle = 3, uuid = '2a1c') => ({ uuid, handle, properties: ['read', 'notify'], valueHex: '1234', valueText: 'private text', descriptors: [{ uuid: '2902', handle: handle + 1 }] });
const state = () => ({ ble: { connected: true, address: device().address }, services: [{ uuid: '1809', characteristics: [characteristic()] }] });
const clone = value => JSON.parse(JSON.stringify(value));

test('capture defaults to metadata, omits values and freezes an independent clone', () => {
  const source = state(), advertisement = device(), saved = model.capture(advertisement, source);
  const entry = saved.gatt[0].characteristics[0];
  assert.equal(saved.includeValues, false);
  assert.equal('valueHex' in entry, false);
  assert.equal('valueText' in entry, false);
  assert.ok(Object.isFrozen(entry.descriptors[0]));
  source.services[0].characteristics[0].handle = 50; advertisement.serviceData[0].hex = 'ffff';
  assert.equal(entry.handle, 3); assert.equal(saved.device.serviceData[0].hex, '0100');
});

test('GATT requires the selected device to be the connected device', () => {
  const other = state(); other.ble.address = 'AA:BB:CC:DD:EE:FF';
  assert.equal(model.capture(device(), other).gatt, null);
  other.ble.connected = false; other.ble.address = device().address;
  assert.equal(model.capture(device(), other).gatt, null);
});

test('diff reports handles, properties, descriptor handles and advertisement bytes', () => {
  const before = model.capture(device(), state()), source = state(), advertisement = device();
  source.services[0].characteristics[0].handle = 8;
  source.services[0].characteristics[0].descriptors[0].handle = 9;
  source.services[0].characteristics[0].properties.push('write');
  advertisement.manufacturer = '0203'; advertisement.payloadHex = '040506';
  const changes = model.diff(before, model.capture(advertisement, source));
  assert.equal(changes.length, 5); assert.ok(changes.every(change => change.type === 'changed'));
  assert.ok(changes.some(change => change.path.endsWith('.handle') && change.before === 3 && change.after === 8));
  assert.ok(changes.some(change => change.path.endsWith('.properties')));
  assert.ok(changes.some(change => change.path === 'device.payloadHex'));
});

test('normalized UUID instance keys preserve duplicate services and characteristics', () => {
  const source = state();
  source.services[0].characteristics.push(characteristic(8, model.uuid('2a1c')));
  source.services.push({ uuid: model.uuid('1809'), characteristics: [characteristic(12)] });
  const before = model.capture(device(), source);
  assert.match(before.gatt[1].key, /#2$/);
  assert.match(before.gatt[0].characteristics[1].key, /#2$/);
  source.services[0].characteristics[1].handle = 10;
  const changes = model.diff(before, model.capture(device(), source));
  assert.equal(changes.length, 1); assert.match(changes[0].path, /#1.characteristics.*#2.handle$/);
});

test('diff ignores volatile metadata and ordering of distinct UUIDs and properties', () => {
  const before = model.capture(device(), state()), changed = clone(before);
  changed.label = 'Later'; changed.capturedAt = '2026-10-26T01:00:00Z'; changed.rssi = -90; changed.firstSeen = 1; changed.lastSeen = 99;
  changed.gatt[0].characteristics[0].properties.reverse();
  assert.deepEqual(model.diff(before, changed), []);
  const source = state(); source.services.push({ uuid: '180a', characteristics: [characteristic(9, '2a29')] });
  const original = model.capture(device(), source); source.services.reverse();
  assert.deepEqual(model.diff(original, model.capture(device(), source)), []);
});

test('explicit readable values are compared; write-only and recorder session values are omitted', () => {
  const source = state(), before = model.capture(device(), source, { includeValues: true });
  assert.equal(before.gatt[0].characteristics[0].valueHex, '1234');
  source.services[0].characteristics[0].valueHex = '5678';
  assert.ok(model.diff(before, model.capture(device(), source, { includeValues: true })).some(change => change.path.endsWith('.valueHex')));
  source.services = [
    { uuid: '1910', characteristics: [characteristic(3, '2bb0')] },
    { uuid: '001120a0-2233-4455-6677-889912345678', characteristics: [characteristic(5, '001120a3-2233-4455-6677-889912345678')] },
    { uuid: '1809', characteristics: [{ ...characteristic(), valueHex: '41505026534b2661626364' }, { ...characteristic(9), properties: ['write'] }] }
  ];
  for (const service of model.capture(device(), source, { includeValues: true }).gatt) {
    for (const entry of service.characteristics) assert.equal('valueHex' in entry, false);
  }
});

test('validation allowlists fields and preserves serialization round trips', () => {
  const original = model.capture(device(), state(), { includeValues: true, label: 'Baseline' });
  const imported = clone(original); imported.privateKeyPem = 'secret'; imported.device.password = 'secret';
  imported.gatt[0].characteristics[0].sessionKey = 'secret'; imported.gatt[0].characteristics[0].valueText = 'secret';
  assert.deepEqual(model.validate(JSON.stringify(imported)), original);
  assert.deepEqual(model.validate(JSON.stringify(original)), original);
});

test('validation rejects malformed JSON, oversized UTF-8 input and invalid fields', () => {
  assert.throws(() => model.validate('{bad'), /JSON/);
  assert.throws(() => model.validate(JSON.stringify({ extra: 'é'.repeat(270000) })), /512 KB/);
  for (const update of [value => { value.version = 2; }, value => { value.device.address = 'bad'; },
    value => { value.device.payloadHex = '0x0'; }, value => { value.device.serviceUUIDs = ['bad uuid']; },
    value => { value.gatt[0].characteristics[0].handle = -1; }, value => { value.capturedAt = 'not a date'; },
    value => { value.includeValues = 'yes'; }, value => { value.gatt = {}; }]) {
    const saved = clone(model.capture(device(), state())); update(saved); assert.throws(() => model.validate(saved));
  }
});

test('validation rejects service and total characteristic limits', () => {
  const saved = clone(model.capture(device(), state()));
  saved.gatt = Array.from({ length: 101 }, () => ({ uuid: '1809', characteristics: [] }));
  assert.throws(() => model.validate(saved), /entries/);
  saved.gatt = Array.from({ length: 3 }, () => ({ uuid: '1809', characteristics: Array.from({ length: 700 }, () => ({ uuid: '2a1c', handle: 1, properties: [], descriptors: [] })) }));
  assert.throws(() => model.validate(saved), /2,000/);
});

test('diff supports additions, removals and comparisons across device addresses', () => {
  const before = model.capture(device(), state()), after = clone(before);
  after.device.address = 'AA:BB:CC:DD:EE:FF'; after.gatt[0].characteristics = [];
  let changes = model.diff(before, after);
  assert.ok(changes.some(change => change.path === 'device.address' && change.type === 'changed'));
  assert.ok(changes.some(change => change.type === 'removed'));
  changes = model.diff(after, before); assert.ok(changes.some(change => change.type === 'added'));
});
