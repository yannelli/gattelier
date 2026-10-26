import test from 'node:test';
import assert from 'node:assert/strict';
import apple from '../web/apple-continuity.js';

function advert(status = 0x20, battery = 0x78, charge = 0x37, model = [0x0e, 0x20]) {
  return { manufacturer: Buffer.from([0x4c, 0, 7, 25, 1, ...model, status, battery, charge, 8, 0, 0, ...Array(16).fill(0)]).toString('hex') };
}
const values = device => Object.fromEntries(apple.identify(device).fields.map(field => [field.label, field.value]));
test('AirPods proximity exposes approximate batteries, charges and model', () => {
  const result = values(advert());
  assert.equal(result.Model, 'AirPods Pro');
  assert.equal(result['Left battery'], 'About 80%'); assert.equal(result['Right battery'], 'About 70%');
  assert.equal(result['Case battery'], 'About 70%'); assert.equal(result['Left charging'], 'Yes');
  assert.equal(result['Case charging'], 'No');
});
test('broadcast orientation swaps both pod battery and charging assignments', () => {
  const result = values(advert(0, 0x78, 0x17));
  assert.equal(result['Left battery'], 'About 70%'); assert.equal(result['Right battery'], 'About 80%');
  assert.equal(result['Left charging'], 'No'); assert.equal(result['Right charging'], 'Yes');
});
test('battery nibbles A through E saturate at 100 percent and F means unavailable', () => {
  const result = values(advert(0x20, 0xfa, 0x0b));
  assert.equal(result['Left battery'], 'About 100%'); assert.equal(result['Right battery'], 'Unavailable');
  assert.equal(result['Case battery'], 'About 100%');
});
test('AirPods Max uses a single headphone battery without a fictional charging case', () => {
  const result = values(advert(1, 7, 0x80, [0x1f, 0x20]));
  assert.equal(result.Model, 'AirPods Max (USB-C)'); assert.equal(result['Headphone battery'], 'About 70%');
  assert.equal(result['Case battery'], undefined);
});
test('unknown models, pairing format and truncated packets remain explicit', () => {
  assert.equal(values(advert(0, 0, 0, [0xff, 0xff])).Model, 'Apple-compatible headphones');
  const pairing = apple.identify({ manufacturer: '4c000703000e20' });
  assert.ok(pairing.limitations.some(text => text.includes('paired 25-byte')));
  assert.equal(apple.parse('4c000719010e20').frames.length, 0);
  assert.ok(apple.identify({ manufacturer: '4c000719010e20' }).limitations.length);
  for (const data of ['7500071901', '4c000', 'xyz', '', null]) assert.equal(apple.identify({ manufacturer: data }), null);
});
test('multiple TLVs preserve boundaries and decode AirPlay IPv4 plus nearby activity', () => {
  const result = values({ manufacturer: '4c0009081304c00002011b581005071d000000' });
  assert.equal(result['AirPlay advertised IPv4'], '192.0.2.1');
  assert.equal(result['Reported activity code'], 'Screen active (0x07)');
  assert.equal(result['AirPlay receiver'], '8 bytes');
  assert.equal(apple.parse('4c00ff000100').frames.length, 2);
  assert.ok(apple.parse('4c0010').errors.length);
});
test('AACP command builder returns bytes for an external Classic host without BLE steps', () => {
  const packet = apple.buildCommand('ear-detection', { device: advert(), enabled: 'false' });
  assert.equal(packet.hex, '0400040009000a02000000'); assert.equal(packet.steps, undefined);
  assert.match(packet.transport, /Classic/);
  assert.throws(() => apple.buildCommand('ear-detection', { device: { manufacturer: '4c001005071d000000' }, enabled: true }), /identified AirPods/);
  assert.throws(() => apple.buildCommand('ear-detection', { device: advert(), enabled: '1' }), /Choose/);
});
