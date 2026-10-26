import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const profiles = require('../web/profiles.js');
const fields = result => Object.fromEntries(result.fields.map(field => [field.label, field.value]));

test('Find My envelope is recognized without inferring an AirTag model', () => {
  const result = profiles.identify({ manufacturer: '4c001219' + '00'.repeat(25) });
  assert.equal(result.category, 'tracker');
  assert.equal(result.title, 'Find My-compatible broadcast');
  for (const manufacturer of ['4c00', '4c001219']) assert.equal(profiles.identify({ manufacturer }).category, 'vendor');
  assert.equal(profiles.identify({ manufacturer: '5900' + '00'.repeat(27) }).category, 'other');
});
test('iBeacon decodes UUID, big-endian identifiers, and signed calibrated power', () => {
  const result = profiles.identify({ manufacturer: '4c00021500112233445566778899aabbccddeeff00010002c5' });
  assert.equal(result.category, 'beacon');
  assert.deepEqual(fields(result), { 'Beacon UUID': '00112233-4455-6677-8899-aabbccddeeff', Major: 1, Minor: 2, 'Calibrated TX at 1 m': '-59 dBm' });
  const incomplete = profiles.identify({ manufacturer: '4c00021500' });
  assert.equal(incomplete.category, 'vendor'); assert.equal(incomplete.confidence, 'Partial advertisement');
});
test('Eddystone parses UID, URL and telemetry with unsupported and malformed frames retained as evidence', () => {
  const frame = hex => profiles.identify({ serviceData: [{ uuid: '0xfeaa', hex }] });
  assert.equal(frame('00c5' + '01'.repeat(10) + '02'.repeat(6) + '0000').title, 'Eddystone UID');
  assert.equal(fields(frame('10c5036578616d706c6507'))['Broadcast URL'], 'https://example.com');
  assert.equal(frame('10c503ff').title, 'Eddystone service');
  const telemetry = fields(frame('20000bb8198000000064000003e8'));
  assert.equal(telemetry['Battery voltage'], '3000 mV');
  assert.equal(telemetry['Beacon temperature'], '25.5 °C');
  assert.equal(telemetry['Beacon uptime'], '100 seconds');
  assert.equal(profiles.identify({ services: ['feaa'] }).confidence, 'Service match');
});
test('Dexcom distinguishes exact service evidence from a candidate name', () => {
  assert.equal(profiles.identify({ services: ['0000febc-0000-1000-8000-00805f9b34fb'] }).confidence, 'Service match');
  assert.equal(profiles.identify({ name: 'DXCM12' }).confidence, 'Name candidate');
  assert.equal(profiles.identify({ name: 'DX02ab' }).category, 'medical');
  assert.equal(profiles.identify({ name: 'DXCM unrelated' }).category, 'other');
  assert.equal(profiles.identify({ manufacturer: '5900' }).category, 'other');
});
test('Sleep Number matches documented services and avoids name-only claims', () => {
  assert.equal(profiles.identify({ services: ['09d23fae-90e6-44c2-95b6-0b3d0f1abf25'] }).title, 'Sleep Number Fuzion');
  assert.equal(profiles.identify({ services: ['ffffd1fd-388d-938b-344a-939d1f6efee0'] }).title, 'Sleep Number MCR');
  assert.equal(profiles.identify({ name: 'Sleep Number bed' }).category, 'other');
});
test('Samsung advertisements show company evidence without inventing a device type', () => {
  const result = profiles.identify({ manufacturer: '750042040000' });
  assert.equal(result.title, 'Samsung device'); assert.equal(result.category, 'vendor'); assert.equal(result.confidence, 'Manufacturer match');
  assert.equal(fields(result)['Assigned company'], 'Samsung Electronics'); assert.match(result.limitations[0], /does not establish a TV/);
  assert.equal(profiles.identify({ services: ['fd5a'] }).title, 'Samsung device');
  assert.equal(profiles.identify({ name: 'Samsung synthetic speaker' }).confidence, 'Name candidate');
  assert.equal(profiles.identify({ manufacturer: '0075' }).category, 'other');
  assert.equal(profiles.identify({ manufacturer: '7500zz' }).category, 'other');
  assert.equal(profiles.identify({ manufacturer: '750000', services: ['febc'] }).category, 'medical');
});
test('advertisement metadata rejects incomplete structures and decodes signed TX', () => {
  const result = profiles.advertisement('020106020ac503034c500409616263');
  assert.equal(fields(result)['Advertised TX power'], '-59 dBm');
  assert.equal(fields(result)['16-bit service UUIDs'], '0x504c');
  assert.equal(fields(result)['Complete local name'], 'abc');
  assert.match(profiles.advertisement('07090102').errors[0], /Truncated/);
  assert.match(profiles.advertisement('xyz').errors[0], /Invalid/);
});

test('Eddystone EID exposes rotating bytes and power without resolving identity', () => {
  const frame = hex => profiles.identify({ serviceData: [{ uuid: 'feaa', hex }] });
  const result = frame('30c50011223344556677');
  assert.equal(result.title, 'Eddystone EID');
  assert.equal(fields(result)['Calibrated TX power'], '-59 dBm');
  assert.equal(fields(result)['Ephemeral identifier'], '0011223344556677');
  assert.match(result.limitations[0], /authorized resolver/);
  assert.equal(frame('30c50011').title, 'Eddystone service');
});
