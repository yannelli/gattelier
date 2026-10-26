import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { decode, batch } = require('../web/advertisement.js');
const field = (type, hex) => (hex.length / 2 + 1).toString(16).padStart(2, '0') + type.toString(16).padStart(2, '0') + hex;

test('browser decodes all service UUID sizes and service-data envelopes in wire order', () => {
  const little = '7856341299887766554433221100ffee';
  const value = decode({ payloadHex: field(3, '0f180a18') + field(5, '78563412') + field(7, little) +
    field(0x16, 'e0ff0102') + field(0x20, '785634120304') + field(0x21, little + '0506') });
  assert.deepEqual(value.services, ['0x180f', '0x180a', '0x12345678', 'eeff0011-2233-4455-6677-889912345678']);
  assert.deepEqual(value.serviceData, [{ uuid: '0xffe0', hex: '0102' }, { uuid: '0x12345678', hex: '0304' }, { uuid: 'eeff0011-2233-4455-6677-889912345678', hex: '0506' }]);
});
test('manufacturer data, UTF-8 complete names and signed power survive browser offload', () => {
  const name = Buffer.from('Test café').toString('hex');
  const record = { address: '02:00:00:00:00:01', addressType: 1, connectable: false, rssi: -60, name: 'Old', txPower: null,
    payloadHex: field(0xff, '75000102') + field(8, '54657374') + field(9, name) + field(0x0a, 'f6') };
  const value = decode(record);
  assert.equal(value.manufacturer, '75000102'); assert.equal(value.name, 'Test café'); assert.equal(value.txPower, -10);
  assert.equal(value.connectable, false); assert.equal(value.addressType, 1); assert.equal(record.name, 'Old');
});
test('truncated AD fields retain complete fields without inventing missing bytes', () => {
  const value = decode({ payloadHex: field(3, '0f18') + '05ff7500', payloadTruncated: true, name: 'Remembered' });
  assert.deepEqual(value.services, ['0x180f']); assert.equal(value.manufacturer, ''); assert.equal(value.payloadTruncated, true);
  assert.equal(value.name, 'Remembered');
  assert.deepEqual(decode({ payloadHex: field(3, '0f18ff') + '00' + field(3, '0a18') }).services, ['0x180f']);
});
test('raw format is explicit and malformed batches do not partially decode', () => {
  const legacy = { devices: [{ manufacturer: '7500' }] }; assert.equal(batch(legacy), legacy);
  for (const payloadHex of [undefined, '1', 'zz', 'ff'.repeat(1651)]) assert.throws(() => decode({ payloadHex }), /Invalid raw/);
  const raw = { format: 'raw-v1', devices: [{ payloadHex: '03030f18' }, { payloadHex: 'x' }] };
  assert.throws(() => batch(raw), /Invalid raw/); assert.equal(raw.devices[0].services, undefined);
  assert.throws(() => batch({ format: 'raw-v1', devices: Array(4097) }), /Invalid raw/);
});
test('compact rows restore advertisement metadata and browser-decode their payload', () => {
  const row = [7, 9, 1234, '02:00:00:00:00:01', 1, -61, 4, 3, null, 129, 'Saved name', '03030f1803ff7500'];
  const value = batch({ format: 'raw-v2', browserOffload: true, devices: [row] });
  assert.deepEqual(value.devices[0], { seq: 7, id: 9, ms: 1234, address: row[3], addressType: 1, rssi: -61, advType: 4,
    connectable: true, payloadTruncated: true, txPower: null, payloadBytes: 129, name: 'Saved name', payloadHex: row[11], manufacturer: '7500', services: ['0x180f'], serviceData: [] });
  assert.equal(value.browserOffload, true); assert.equal(row.length, 12);
  assert.equal(batch({ format: 'raw-v2', devices: [[...row.slice(0, 7), 0, -10, ...row.slice(9)]] }).devices[0].txPower, -10);
  for (const invalid of [row.slice(1), [...row, 1], { payloadHex: '' }, row.map((value, index) => index === 7 ? 4 : value), row.map((value, index) => index === 5 ? 'bad' : value), row.map((value, index) => index === 11 ? 'odd' : value)]) {
    assert.throws(() => batch({ format: 'raw-v2', devices: [invalid] }), /Invalid/);
  }
});
