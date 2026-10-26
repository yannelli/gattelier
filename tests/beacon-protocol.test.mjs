import test from 'node:test';
import assert from 'node:assert/strict';
import beacon from '../web/beacon-protocol.js';
const characteristic = n => `a3c875${n.toString(16).padStart(2, '0')}-8ed3-4bdf-8a39-a01bebede295`;
const fields = values => Object.fromEntries(values.map(value => [value.label, value.value]));
const device = { services: ['feaa'] };
test('beacon detection recognizes supported envelopes and rejects unrelated data', () => {
  assert.equal(beacon.identify(device).category, 'beacon');
  assert.equal(beacon.identify({ services: [beacon.configurationService] }).title, 'Eddystone configuration service');
  assert.equal(beacon.identify({ services: ['feed'] }).category, 'tracker');
  assert.equal(beacon.identify({ manufacturer: '4c001219' + '00'.repeat(25) }).category, 'tracker');
  assert.equal(beacon.identify({ manufacturer: '7500' }), null);
  assert.equal(beacon.identify({ services: 'feaa', serviceData: 'feaa' }), null);
  assert.equal(beacon.canPrepare({ services: ['feed'] }), false);
});
test('configuration capabilities use big-endian frame mask and signed power values', () => {
  const result = fields(beacon.decode(characteristic(1), '00050303000ff8ec04'));
  assert.equal(result['Total slots'], '5'); assert.equal(result['EID slots'], '3');
  assert.equal(result['Supported frame types'], 'UID, URL, TLM, EID');
  assert.equal(result['Supported radio powers'], '-8 dBm, -20 dBm, 4 dBm');
  assert.equal(result['Per-slot interval'], 'Supported');
  assert.throws(() => beacon.decode(characteristic(1), '00050303000f'), /7 bytes/);
});
test('configuration values validate sizes and distinguish capabilities from current state', () => {
  assert.equal(fields(beacon.decode(characteristic(3), '03e8'))['Advertising interval'], '1000 ms');
  assert.equal(fields(beacon.decode(characteristic(4), 'ec'))['Radio TX power'], '-20 dBm');
  assert.equal(fields(beacon.decode(characteristic(6), '02'))['Lock state'], 'Unlocked; automatic relocking disabled');
  assert.equal(fields(beacon.decode(characteristic(12), '01'))['Can become non-connectable'], 'Yes');
  assert.throws(() => beacon.decode(characteristic(3), '03'), /2 bytes/);
  assert.throws(() => beacon.decode(characteristic(7), '00'), /16 bytes/);
  assert.deepEqual(beacon.decode('2a19', '64'), []);
});
test('EID slot data exposes the captured clock without resolving identity', () => {
  const result = fields(beacon.decode(characteristic(10), '300a000001000011223344556677'));
  assert.equal(result['Rotation exponent'], '10'); assert.equal(result['Beacon clock'], '256 seconds');
  assert.equal(result['Ephemeral identifier'], '0011223344556677');
  assert.throws(() => beacon.decode(characteristic(10), '300a00000100'), /14 bytes/);
  assert.equal(fields(beacon.decode(characteristic(10), '00'))['Slot state'], 'Not broadcasting');
});
test('saved telemetry decodes with the existing broadcast layout', () => {
  const result = fields(beacon.decodeService('0xfeaa', '20000bb8198000000064000003e8'));
  assert.equal(result['Battery voltage'], '3000 mV'); assert.equal(result['Beacon temperature'], '25.5 °C');
  assert.deepEqual(beacon.decodeService('feed', '00'), []);
  assert.throws(() => beacon.decodeService('feaa', 'odd'), /HEX/);
});
test('interval and signed power previews preserve slot order without executable steps', () => {
  const plan = beacon.buildCommand('interval', { device, slot: '2', milliseconds: '1000' });
  assert.deepEqual(plan.writes.map(write => write.hex), ['02', '03e8']);
  assert.equal(plan.writes[0].characteristic, characteristic(2)); assert.equal(plan.writes[1].characteristic, characteristic(3));
  assert.equal(plan.offlineOnly, true); assert.equal(plan.steps, undefined);
  assert.equal(beacon.buildCommand('radio-power', { device, slot: 0, power: -20 }).writes[1].hex, 'ec');
  assert.throws(() => beacon.buildCommand('interval', { device, slot: 0, milliseconds: 65536 }), /65535/);
  assert.throws(() => beacon.buildCommand('lock', { device: { services: ['feed'] } }), /Eddystone/);
});
test('UID configuration omits broadcast TX power and validates complete identity', () => {
  const plan = beacon.buildCommand('uid', { device, slot: 0, namespace: '11'.repeat(10), instance: '22'.repeat(6) });
  assert.equal(plan.writes[1].hex, '00' + '11'.repeat(10) + '22'.repeat(6));
  assert.throws(() => beacon.buildCommand('uid', { device, slot: 0, namespace: 'aa', instance: '22'.repeat(6) }), /namespace/);
});
test('slot clearing and lock previews describe destructive effects without executing', () => {
  const clear = beacon.buildCommand('clear-slot', { device, slot: 1 });
  assert.equal(clear.writes[1].hex, '00'); assert.match(clear.warnings[0], /destroys any EID/);
  assert.deepEqual(beacon.buildCommand('telemetry', { device, slot: 0 }).writes.map(write => write.hex), ['00', '20']);
  assert.equal(beacon.buildCommand('lock', { device }).writes[0].characteristic, characteristic(6));
  assert.equal(beacon.buildCommand('remain-connectable', { device, enabled: '1' }).writes[0].hex, '01');
});
