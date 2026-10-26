import test from 'node:test';
import assert from 'node:assert/strict';
import matcher from '../web/catalog-match.js';
import { catalogs } from './catalog-fixtures.mjs';

const entries = catalogs[3].entries;
const base = { id: 'fixture', title: 'Fixture', category: 'sensor', confidence: 'Advertisement match', description: 'Fixture', limitations: [], sources: [] };
const matches = (device, discovered) => matcher.match(entries, device, discovered);
test('every published alternative matches its documented fields and has evidence', () => {
  for (const entry of entries) for (const rule of entry.rules) {
    const device = { services: [], serviceData: [] };
    for (const condition of rule) {
      if (condition.kind === 'service') device.services.push(condition.uuid);
      if (condition.kind === 'name' || condition.kind === 'name-prefix') device.name = condition.value;
      if (condition.kind === 'company') device.manufacturer = Buffer.from([condition.id & 255, condition.id >> 8]).toString('hex');
      if (condition.kind === 'manufacturer-prefix') device.manufacturer = condition.hex.padEnd(Math.max(condition.minBytes || 0, condition.hex.length / 2) * 2, '0');
      if (condition.kind === 'service-data') device.serviceData.push({ uuid: condition.uuid, hex: (condition.prefix || '').padEnd(Math.max(condition.minBytes || 0, (condition.prefix || '').length / 2) * 2, '0') });
    }
    const result = matcher.match([entry], device);
    assert.equal(result.length, 1, `${entry.id}: ${JSON.stringify(rule)}`);
    assert.ok(result[0].evidence.length);
    assert.ok(result[0].external);
  }
});
test('custom services match in advertisements and discovered GATT with distinct evidence', () => {
  const meshtastic = entries.find(entry => /meshtastic/i.test(entry.id));
  const uuid = meshtastic.rules[0][0].uuid;
  assert.equal(matches({ services: [uuid.toUpperCase()] })[0].id, meshtastic.id);
  const gatt = matches({}, [{ uuid }]).find(item => item.id === meshtastic.id);
  assert.match(gatt.evidence[0], /^Discovered GATT/);
  assert.equal(matches({ services: [uuid.slice(0, -1) + '0'] }).some(item => item.id === meshtastic.id), false);
  assert.deepEqual(matches({ name: 'Unknown', services: ['fff0', 'ffe0', 'fee7'], manufacturer: '4c00' }), []);
});
test('conditions are AND within a rule and OR between rules', () => {
  const entry = { ...base, rules: [[{ kind: 'name-prefix', value: 'Sensor' }, { kind: 'service', uuid: '180d' }], [{ kind: 'name', value: 'Exact' }]] };
  assert.equal(matcher.match([entry], { name: 'SENSOR 4', services: ['0000180D-0000-1000-8000-00805F9B34FB'] }).length, 1);
  assert.deepEqual(matcher.match([entry], { name: 'Sensor 4', services: ['180f'] }), []);
  assert.equal(matcher.match([entry], { name: 'Exact' })[0].confidence, 'Name candidate');
  assert.deepEqual(matcher.match([entry], { name: 'Exact extra' }), []);
});
test('manufacturer byte order, lengths and malformed bytes do not create false matches', () => {
  const entry = { ...base, rules: [[{ kind: 'company', id: 0x1234 }, { kind: 'manufacturer-prefix', hex: '3412aa', minBytes: 4, maxBytes: 4 }]] };
  assert.equal(matcher.match([entry], { manufacturer: '3412AA00' }).length, 1);
  for (const manufacturer of ['1234aa00', '3412aa', '3412aa0000', '3412aa0g', '3412aa0']) assert.deepEqual(matcher.match([entry], { manufacturer }), []);
  const service = { ...base, rules: [[{ kind: 'service-data', uuid: 'fcd2', prefix: '40', minBytes: 2, maxBytes: 3 }]] };
  assert.equal(matcher.match([service], { serviceData: [{ uuid: '0xFCD2', hex: '4001' }] }).length, 1);
  for (const hex of ['40', '40010000', '400g', '4101']) assert.deepEqual(matcher.match([service], { serviceData: [{ uuid: 'fcd2', hex }] }), []);
});
test('catalog confidence caps observed evidence and retains provenance and truncation', () => {
  const entry = { ...base, confidence: 'Name candidate', library: 'test-library', revision: 'v1', rules: [[{ kind: 'manufacturer-prefix', hex: '3412' }, { kind: 'name-prefix', value: 'Example' }]] };
  const result = matcher.match([entry], { name: 'Example 2', manufacturer: '341200', payloadTruncated: true })[0];
  assert.equal(result.confidence, 'Name candidate'); assert.equal(result.revision, 'v1');
  assert.ok(result.limitations.some(text => text.includes('truncated')));
  assert.equal(result.library, 'test-library');
  assert.deepEqual(matches(null), []);
});
test('company-only prefixes and service-data presence receive limited confidence', () => {
  const company = { ...base, rules: [[{ kind: 'manufacturer-prefix', hex: '4c00' }]] };
  assert.equal(matcher.match([company], { manufacturer: '4c000215' })[0].confidence, 'Manufacturer match');
  const service = { ...base, rules: [[{ kind: 'service-data', uuid: '180d' }]] };
  assert.equal(matcher.match([service], { serviceData: [{ uuid: '180d', hex: '' }] })[0].confidence, 'Service match');
});
