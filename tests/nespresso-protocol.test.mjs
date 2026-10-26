import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), p = require('../web/nespresso-protocol.js');
const device = { name: 'Vertuo_CV6_SYNTHETIC', services: [p.services.basic], manufacturer: '0225000900000000' };
const fields = values => Object.fromEntries(values.map(item => [item.label, item.value]));

test('current Vertuo CV6 advertisement maps to the documented Pop+ model and passive state', () => {
  const result = p.identify(device);
  assert.equal(result.category, 'appliance'); assert.equal(result.family, 'vertuo'); assert.equal(result.confidence, 'Service match');
  const decoded = fields(result.fields);
  assert.equal(decoded['Model candidate'], 'Vertuo Pop+'); assert.equal(decoded['Model code'], 'CV6');
  assert.equal(decoded['Vertuo machine state'], 'Power save'); assert.equal(decoded['Pairing key state'], 'None');
  assert.ok(result.sources.every(source => /^https:\/\/github.com\//.test(source.url))); assert.match(result.limitations.join(' '), /Remote brewing is not implemented/);
});

test('registered and byte-swapped manufacturer IDs are accepted with generation evidence', () => {
  for (const manufacturer of ['0225408200000000', '2502408200000000']) {
    const result = p.identify({ ...device, manufacturer }); assert.equal(fields(result.fields)['Vertuo machine state'], 'Ready'); assert.equal(fields(result.fields)['Pairing key state'], 'Final');
  }
  const unknown = p.identify({ manufacturer: device.manufacturer });
  assert.equal(unknown.family, 'unconfirmed'); assert.equal(unknown.confidence, 'Manufacturer match'); assert.equal(unknown.fields.length, 0);
  assert.equal(p.identify({ manufacturer: '7500000900000000' }), null); assert.equal(p.identify(null), null);
});

test('shared service and OriginalLine names do not become confirmed Vertuo compatibility', () => {
  const shared = p.identify({ services: [p.services.basic] }); assert.equal(shared.family, 'unconfirmed'); assert.equal(shared.fields.length, 0);
  const original = p.identify({ ...device, name: 'Prodigio_SYNTHETIC' }); assert.equal(original.family, 'original'); assert.equal(original.fields.length, 0);
  assert.equal(p.identify({ name: 'Vertuo_CV6_SYNTHETIC' }).confidence, 'Name candidate');
  assert.equal(p.identify({ name: 'A machine with CV6 in a label' }), null);
  for (const input of [{ ...device, name: 'Expert_SYNTHETIC' }, { services: [p.services.basic] }, { name: device.name }, { ...device, name: 'Vertuo_CV9_SYNTHETIC' }]) assert.throws(() => p.buildCommand('water-hardness', { device: input, currentSettings: '07080400', level: 2 }), /documented Vertuo/);
});

test('status bitfields retain unknown states and reject incomplete or oversized values', () => {
  const status = fields(p.decode(p.characteristics.status, '57c400'));
  assert.equal(status['Vertuo machine state'], 'Brewing'); assert.equal(status['Water tank empty'], 'Yes'); assert.equal(status['Cleaning needed'], 'Yes');
  assert.equal(status['Descaling needed'], 'Yes'); assert.equal(status['Error reported'], 'Yes'); assert.equal(status['Brewing unit closed'], 'Yes'); assert.equal(status['Capsule container full'], 'Yes');
  assert.equal(fields(p.decode(p.characteristics.status, '000ff0'))['Vertuo machine state'], 'Unrecognized (255)');
  for (const input of ['', 'zz', '0', '0009', '00'.repeat(9)]) assert.deepEqual(p.decode(p.characteristics.status, input), []);
  assert.deepEqual(p.decode(p.characteristics.status, '000900', { family: 'original' }), []);
  assert.deepEqual(p.decode(p.characteristics.status, '000900', { device: { name: 'Prodigio_SYNTHETIC', services: [p.services.basic] } }), []);
  const truncated = p.identify({ ...device, payloadTruncated: true }); assert.equal(fields(truncated.fields)['Vertuo machine state'], undefined); assert.match(truncated.limitations.join(' '), /truncated/);
});

test('Vertuo versions use big endian decimal encodings and the 16-byte layout', () => {
  const decoded = fields(p.decode(p.characteristics.info, '01c50064012600647c38020000000001'));
  assert.equal(decoded['Hardware version'], '4.53'); assert.equal(decoded['Bootloader version'], '1.0'); assert.equal(decoded['Firmware version'], '2.94');
  assert.equal(decoded['Recipe database version'], '1.0'); assert.equal(decoded['Connectivity firmware'], '3.18.0'); assert.equal(decoded['Device address'], '02:00:00:00:00:01');
  assert.deepEqual(p.decode(p.characteristics.info, '00'.repeat(14)), []); assert.deepEqual(p.decode(p.characteristics.info, '00'.repeat(17)), []);
  assert.equal(fields(p.decode(p.characteristics.profile, '01c50000'))['Profile version'], '4.53');
  assert.equal(fields(p.decode(p.characteristics.pairing, '03'))['Pairing key state'], 'Undefined');
  assert.equal(fields(p.decode(p.characteristics.pairing, 'ff'))['Pairing key state'], 'Unrecognized (255)');
});

test('serial text is UTF-8, bounded and independent of unknown characteristics', () => {
  assert.equal(fields(p.decode(p.characteristics.serial, '53594e5448455449430000'))['Serial number'], 'SYNTHETIC');
  for (const input of ['ff', '610062', '01', '41'.repeat(65)]) assert.deepEqual(p.decode(p.characteristics.serial, input), []);
  assert.deepEqual(p.decode('00002a00-0000-1000-8000-00805f9b34fb', '4142'), []);
});

test('water-hardness encoding changes only its byte in a validated supplied settings record', () => {
  const decoded = fields(p.decode(p.characteristics.settings, '07080419'));
  assert.equal(decoded['Auto power-off time (raw)'], '2055'); assert.equal(decoded['Standby time (raw)'], '25'); assert.equal(decoded['Water hardness level'], '4');
  const command = p.buildCommand('water-hardness', { device, currentSettings: '07 08 04 19', level: '1' });
  assert.deepEqual(command.steps, [{ action: 'write', service: p.services.settings, uuid: p.characteristics.settings, hex: '07080119', response: true }]);
  assert.match(command.warnings.join(' '), /fresh settings/); assert.equal(command.compatibility.family, 'vertuo');
  for (const level of [-1, 5, 1.5, '', null, true, '02', NaN]) assert.throws(() => p.buildCommand('water-hardness', { device, currentSettings: '07080419', level }), /integer/);
  for (const currentSettings of ['', '000000', '0000000000', 'zzzzzzzz']) assert.throws(() => p.buildCommand('water-hardness', { device, currentSettings, level: 0 }));
});

test('CMID command is sensitive, eight bytes long, prefix validated and generation gated', () => {
  const command = p.buildCommand('authenticate', { device, authKey: '8000000000000001' });
  assert.equal(command.sensitive, true); assert.equal(command.steps[0].sensitive, true); assert.equal(command.steps[0].uuid, p.characteristics.auth); assert.equal(command.steps[0].hex, '8000000000000001');
  assert.equal(p.commands.find(item => item.id === 'authenticate').sensitive, true);
  for (const authKey of ['', '8000', '9000000000000000', '800000000000000000']) assert.throws(() => p.buildCommand('authenticate', { device, authKey }));
  assert.throws(() => p.buildCommand('brew', { device }), /Unsupported/);
  assert.ok(p.commands.every(command => command.compatibility.hardwareValidated === false));
});
