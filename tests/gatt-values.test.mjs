import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const values = require('../web/gatt-values.js');
const value = (uuid, hex) => values.decode(uuid, hex)[0]?.value;

test('standard short and Bluetooth base UUIDs decode without matching custom prefixes', () => {
  for (const uuid of ['2a19', '0x2A19', '00002A19-0000-1000-8000-00805F9B34FB']) assert.equal(value(uuid, '64'), '100%');
  for (const uuid of ['2a19-vendor', '00002a19-1234-1000-8000-00805f9b34fb', 'a2a19', null, 0x2a19]) assert.deepEqual(values.decode(uuid, '64'), []);
});

test('battery levels distinguish reserved values and reject malformed byte lengths', () => {
  assert.equal(value('2a19', '00'), '0%');
  assert.equal(value('2a19', '32'), '50%');
  assert.equal(value('2a19', 'FF'), 'Unknown / reserved (0xFF)');
  for (const hex of ['65', 'fe', '6400', '', '6', 'zz', '64\n', '64 '.repeat(513), null]) assert.deepEqual(values.decode('2a19', hex), []);
});

test('device-information values use validated UTF-8 and preserve the supplied text', () => {
  const encoded = Buffer.from('M5 Nano • café').toString('hex');
  for (const uuid of ['2a29', '2a24', '2a25', '2a26', '2a27', '2a28']) assert.equal(value(uuid, encoded), 'M5 Nano • café');
  assert.equal(values.decode('2a26', '312e32')[0].label, 'Firmware revision');
  for (const hex of ['ff', 'c0af', 'e282', '410042', '410a42', '41'.repeat(513)]) assert.deepEqual(values.decode('2a29', hex), []);
  assert.equal(value('2a25', '41'.repeat(512)), 'A'.repeat(512));
});

test('appearance preserves the numeric subtype and uses the assigned category', () => {
  assert.deepEqual(values.decode('2a01', 'c103'), [
    { label: 'Appearance', value: '0x03C1' }, { label: 'Appearance category', value: 'Human Interface Device' }, { label: 'Appearance subcategory', value: '1' }
  ]);
  assert.equal(value('2a01', '0000'), '0x0000');
  assert.match(values.decode('2a01', 'ffff')[1].value, /^Unassigned category/);
  assert.deepEqual(values.decode('2a01', 'c1'), []);
});

test('temperature and humidity respect little-endian units, prohibited ranges and unknown sentinels', () => {
  assert.equal(value('2a6e', '2909'), '23.45 °C');
  assert.equal(value('2a6e', '85ff'), '-1.23 °C');
  assert.equal(value('2a6e', '4d95'), '-273.15 °C');
  assert.equal(value('2a6e', 'ff7f'), '327.67 °C');
  assert.equal(value('2a6e', '0080'), 'Unknown');
  assert.deepEqual(values.decode('2a6e', '4c95'), []);
  assert.equal(value('2a6f', '8813'), '50.00%');
  assert.equal(value('2a6f', '1027'), '100.00%');
  assert.equal(value('2a6f', 'ffff'), 'Unknown');
  for (const hex of ['1127', '000000', '00']) assert.deepEqual(values.decode('2a6f', hex), []);
});

test('transmit power is a signed byte within the characteristic range', () => {
  assert.equal(value('2a07', 'ee'), '-18 dBm');
  assert.equal(value('2a07', '14'), '20 dBm');
  assert.equal(value('2a07', '9c'), '-100 dBm');
  for (const hex of ['9b', '15', '80', '0000']) assert.deepEqual(values.decode('2a07', hex), []);
});

test('heart-rate flags determine width, energy and ordered RR intervals', () => {
  assert.deepEqual(values.decode('2a37', '0048'), [{ label: 'Heart rate measurement', value: '72 bpm' }, { label: 'Sensor contact', value: 'Not supported' }]);
  assert.equal(value('2a37', '012c01'), '300 bpm');
  assert.equal(values.decode('2a37', '0648')[1].value, 'Detected');
  assert.equal(values.decode('2a37', '0448')[1].value, 'Not detected');
  assert.equal(values.decode('2a37', '0248')[1].value, 'Not supported');
  assert.deepEqual(values.decode('2a37', '1f2c01341200040002').slice(2), [
    { label: 'Energy expended', value: '4660 kJ' }, { label: 'RR interval 1', value: '1000 ms' }, { label: 'RR interval 2', value: '500 ms' }
  ]);
  assert.equal(values.decode('2a37', '10480100').at(-1).value, '0.976563 ms');
});

test('heart-rate parser rejects reserved flags, omitted fields and unexplained trailing bytes', () => {
  for (const hex of ['', '00', '2048', '0148', '084801', '1048', '104801', '004800', '0848010000', '1f2c013412000400']) assert.deepEqual(values.decode('2a37', hex), []);
});

test('presentation descriptor decodes signed exponent and little-endian UUID and description', () => {
  assert.deepEqual(values.decode('2904', '0efE2f27013412'), [
    { label: 'Value format', value: 'sint16' }, { label: 'Decimal exponent (raw)', value: '-2' }, { label: 'Unit UUID', value: '0x272F' },
    { label: 'Namespace', value: 'Bluetooth SIG' }, { label: 'Description code', value: '0x1234' }
  ]);
  assert.deepEqual(values.decode('2904', '0efe2f2701'), []);
  assert.deepEqual(values.decode('1234', '0efe2f27013412'), []);
  const sources = values.sources(); sources[0].title = 'changed';
  assert.notEqual(values.sources()[0].title, 'changed');
});
