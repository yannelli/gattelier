import test from 'node:test';
import assert from 'node:assert/strict';
import modules from '../web/modules.js';
test('app matches use advertised protocol evidence', () => {
  assert.deepEqual(modules.matches({ name: 'PLAUD' }), []);
  assert.deepEqual(modules.matches({ name: 'PKT01_GREY_25a1052a', services: ['0x5536'] }), ['pocket']);
  assert.deepEqual(modules.matches({ name: 'PKT01_GREY_25a1052a', services: [] }), []);
  assert.deepEqual(modules.matches({ services: ['0xfebc'] }), ['medical']);
  assert.deepEqual(modules.matches(null), []);
});
test('PLAUD manufacturer protocol matches independently of name', () => {
  const data = Buffer.alloc(22); data[2] = 2; data.writeUInt16LE(881, 3); data[5] = 4; data[10] = 8; data.writeUInt16LE(20, 20);
  assert.deepEqual(modules.matches({ manufacturer: data.toString('hex') }), ['plaud']);
});
test('device apps match known services and route Schlage names to its inventory app', () => {
  assert.deepEqual(modules.matches({ services: ['e63215e5-7003-49d8-96b0-b024798fb901'] }), ['radiacode']);
  assert.deepEqual(modules.matches({ services: ['0x1809'] }), ['thermometer', 'standard']);
  assert.deepEqual(modules.matches({ services: ['0xfd56'], name: 'ResMed842680' }), ['resmed']);
  assert.deepEqual(modules.matches({ name: 'Schlage 000D5F4E' }), ['schlage']);
});

test('app matching excludes unsupported lock names and scopes discovered services', () => {
  assert.deepEqual(modules.matches({ name: 'Yale headphones' }), []);
  assert.deepEqual(modules.matches({ name: 'ResMed sensor' }).filter(id => id === 'medical'), []);
  assert.deepEqual(modules.matches({ name: 'SCHLAGE0012287A' }), ['schlage']);
  const device = { address: '02:00:00:00:00:01', addressType: 0 };
  const state = { ble: { ...device, addressType: 1, connected: true }, services: [{ uuid: '180d' }] };
  assert.deepEqual(modules.matches(device, state), []);
  state.ble.addressType = 0;
  assert.deepEqual(modules.matches(device, state), ['standard']);
});
