import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
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
  assert.equal(result.title, 'Samsung BLE broadcast'); assert.equal(result.category, 'vendor'); assert.equal(result.confidence, 'Manufacturer match');
  assert.equal(fields(result)['Company identifier'], '0x0075'); assert.match(result.limitations[0], /without assigning a model/);
  assert.equal(profiles.identify({ services: ['fd5a'] }).title, 'Samsung Offline Finding');
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


test('standard advertised services reuse matcher titles and exclude battery from sensor fields', () => {
  const standard = require('../web/standard-app.js');
  for (const uuid of ['180d', '0000180d-0000-1000-8000-00805f9b34fb']) {
    const device = { name: 'Polar', services: [uuid, '180f'] };
    const result = profiles.identify(device);
    assert.equal(result.category, 'sensor');
    assert.equal(result.title, standard.matches(device)[0].title);
    assert.equal(result.confidence, 'Service match');
    assert.equal(result.modelConfirmed, false);
    assert.deepEqual(fields(result), { 'Heart rate': '0x180d' });
    assert.match(result.sources[0].url, /GATT_Specification_Supplement/);
    assert.doesNotMatch(result.title, /Polar|Battery/);
  }
  const result = profiles.identify({ services: ['180d', '1816'] });
  assert.equal(result.title, 'Heart rate · Cycling speed and cadence');
  assert.equal(profiles.identify({ serviceData: [{ uuid: '180d', hex: '' }] }).category, 'sensor');
  assert.equal(profiles.catalog().find(item => item.category === 'sensor').title, 'Sensors');
});

test('standard discovered services require the connected address and address type', () => {
  const device = { address: 'aa:bb:cc:dd:ee:01', addressType: 0 };
  const state = { ble: { connected: true, address: device.address.toUpperCase(), addressType: 0 }, services: [{ uuid: '180d', characteristics: [] }] };
  assert.equal(profiles.identify(device, state).title, 'Heart rate');
  for (const ble of [{ addressType: 1 }, { address: 'aa:bb:cc:dd:ee:02' }, { connected: false }]) {
    assert.equal(profiles.identify(device, { ...state, ble: { ...state.ble, ...ble } }).category, 'other');
  }
  assert.equal(profiles.identify(device).category, 'other');
});

test('battery alone and sensor names do not classify a standard sensor', () => {
  for (const device of [{ services: ['180f'] }, { name: 'Polar Heart rate' }, { services: ['180d-vendor'] }]) {
    assert.equal(profiles.identify(device).category, 'other');
  }
  const device = { address: 'aa:bb:cc:dd:ee:01', addressType: 0 };
  assert.equal(profiles.identify(device, { ble: { ...device, connected: true }, services: [{ uuid: '180f' }] }).category, 'other');
});

test('standard fallback preserves existing vendor, medical, and recorder classifications', () => {
  for (const device of [
    { manufacturer: '750042040000' },
    { services: ['febc'] },
    { name: 'PKT01_fixture', services: ['5536'] }
  ]) {
    const original = profiles.identify(device);
    assert.notEqual(original.category, 'other');
    const result = profiles.identify({ ...device, services: [...(device.services || []), '180d'] });
    assert.equal(result.category, original.category);
    assert.equal(result.title, original.title);
  }
});

test('browser fallback tolerates an absent standard app and uses its matcher when present', () => {
  const context = vm.createContext({ NanoCatalogs: require('../web/catalogs.js') });
  vm.runInContext(readFileSync(new URL('../web/profiles.js', import.meta.url), 'utf8'), context);
  const identify = vm.runInContext('NanoProfiles.identify', context);
  assert.equal(identify({ services: ['180d'] }).category, 'other');
  context.NanoStandardApp = require('../web/standard-app.js');
  assert.equal(identify({ services: ['180d'] }).title, 'Heart rate');
});

test('Schlage profiles expose only identity values from the matching connected device', () => {
  const context = vm.createContext({ NanoCatalogs: require('../web/catalogs.js'), NanoSchlage: require('../web/schlage-protocol.js') });
  vm.runInContext(readFileSync(new URL('../web/profiles.js', import.meta.url), 'utf8'), context);
  const browser = vm.runInContext('NanoProfiles', context);
  const device = { address: 'aa:bb:cc:dd:ee:01', addressType: 0, name: 'Schlage Test' };
  const state = { ble: { ...device, connected: true }, services: [{ uuid: '180a', characteristics: [
    { uuid: '2a29', valueHex: Buffer.from('Schlage').toString('hex') }, { uuid: '2a24', valueHex: Buffer.from('BE489WB').toString('hex') }
  ] }] };
  const result = browser.identify(device, state);
  assert.equal(result.category, 'lock'); assert.equal(result.title, 'Schlage Encode');
  assert.deepEqual(fields(result), { Manufacturer: 'Schlage', Model: 'BE489WB' });
  assert.equal(browser.identify({ ...device, addressType: 1 }, state).fields.length, 0);
  assert.equal(browser.catalog().find(item => item.category === 'lock').title, 'Locks');
});
