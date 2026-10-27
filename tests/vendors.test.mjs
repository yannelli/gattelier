import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { companyId, addressLabel, addressVendor, expand, identify } = require('../web/vendors.js');
const { visibleDevices } = require('../web/app.js');
const database = {
  oui: { '000000': 'Zero prefix', AABBCC: 'MA-L vendor', AABBCCD: 'MA-M vendor', AABBCCDDE: 'MA-S vendor' },
  company: { '0': 'Company zero', '76': 'Apple, Inc.', '4660': 'Test company' }
};

test('company identifiers are little-endian and retain zero', () => {
  assert.equal(companyId('4c000215'), 76);
  assert.equal(companyId('3412'), 4660);
  assert.equal(companyId('00 00 12'), 0);
  assert.equal(identify({ manufacturer: '0000', addressType: 1 }, database).manufacturer, 'Company zero');
});

test('malformed and incomplete manufacturer data do not produce identifiers', () => {
  for (const value of [undefined, null, '', '00', '000', '4c0z', '4c000', 'xx4c00', 76]) assert.equal(companyId(value), null);
});

test('public addresses use the longest matching registry prefix', () => {
  assert.equal(addressVendor('aa:bb:cc:dd:ee:ff', 0, database), 'MA-S vendor');
  assert.equal(addressVendor('AA:BB:CC:D1:22:33', 2, database), 'MA-M vendor');
  assert.equal(addressVendor('AA-BB-CC-11-22-33', 0, database), 'MA-L vendor');
  assert.equal(addressVendor('000000123456', 0, database), 'Zero prefix');
});

test('grouped vendor prefixes expand to a prefix lookup', () => {
  const expanded = expand({ updated: 'today', vendors: { 'MA-L vendor': 'AABBCC', 'MA-S vendor': '000000 AABBCCDDE' }, company: {} });
  assert.deepEqual(expanded.oui, { AABBCC: 'MA-L vendor', '000000': 'MA-S vendor', AABBCCDDE: 'MA-S vendor' });
  assert.equal(expanded.vendors, undefined);
  assert.equal(addressVendor('aa:bb:cc:dd:ee:ff', 0, expanded), 'MA-S vendor');
  assert.equal(expand(database), database);
});

test('random and unknown address types do not perform vendor lookup', () => {
  for (const type of [1, 3, 4, undefined, '0']) assert.equal(addressVendor('AA:BB:CC:DD:EE:FF', type, database), '');
  for (const type of [1, 3]) {
    const result = identify({ address: 'AA:BB:CC:DD:EE:FF', addressType: type, manufacturer: '4c00' }, database);
    assert.equal(result.addressNote, `${addressLabel('AA:BB:CC:DD:EE:FF', type)}; no IEEE OUI attribution`);
    assert.equal(result.manufacturer, 'Apple, Inc.');
    assert.equal(result.addressVendor, '');
  }
});

test('BLE address labels distinguish static addresses from private address subtypes', () => {
  const cases = [
    ['c2:00:00:00:00:03', 1, 'Static BLE address'],
    ['e1:00:00:00:00:01', 1, 'Static BLE address'],
    ['4a:00:00:00:00:01', 1, 'Resolvable private address'],
    ['1a:00:00:00:00:01', 1, 'Non-resolvable private address'],
    ['8a:00:00:00:00:01', 1, 'Reserved BLE address'],
    ['c2:00:00:00:00:03', 3, 'Static BLE identity address'],
    ['c2:00:00:00:00:03', 0, 'Public'],
    ['c2:00:00:00:00:03', 2, 'Public identity'],
    ['invalid', 1, 'Unclassified random BLE address']
  ];
  for (const [address, type, label] of cases) assert.equal(addressLabel(address, type), label);
  const result = identify({ address: 'c2:00:00:00:00:03', addressType: 1 }, database);
  assert.equal(result.hint, 'Static BLE address');
  assert.equal(result.addressNote, 'Static BLE address; no IEEE OUI attribution');
  assert.equal(result.addressExplanation, 'Device reports a static random BLE address; this does not mean it rotates.');
  assert.equal(result.addressVendor, '');
});

test('malformed addresses and absent databases return no match', () => {
  for (const address of ['', null, 'AA:BB:CC', 'AA:BB:CC:DD:EE:ZZ', 'AA:BB-CC:DD:EE:FF', 'AABBCCDDEEFF00']) assert.equal(addressVendor(address, 0, database), '');
  assert.equal(addressVendor('AA:BB:CC:DD:EE:FF', 0, null), '');
});

test('vendor search matches both attribution sources while excluding random OUI matches', () => {
  const devices = [
    { id: 1, address: 'AA:BB:CC:DD:EE:FF', addressType: 0, manufacturer: '3412', rssi: -50 },
    { id: 2, address: 'AA:BB:CC:DD:EE:00', addressType: 1, manufacturer: '4c00', rssi: -60 }
  ];
  assert.deepEqual(visibleDevices(devices, 'ma-s', database).map(item => item.id), [1]);
  assert.deepEqual(visibleDevices(devices, 'TEST COMPANY', database).map(item => item.id), [1]);
  assert.deepEqual(visibleDevices(devices, 'apple', database).map(item => item.id), [2]);
});
