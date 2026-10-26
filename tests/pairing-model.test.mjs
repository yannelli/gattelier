import test from 'node:test';
import assert from 'node:assert/strict';
import pairing from '../web/pairing-model.js';
const device = { address: 'aa:bb:cc:dd:ee:ff' };
const state = { ble: { connected: true, address: device.address }, security: { address: device.address, active: true, challengeId: 7, status: 'passkey-input' } };
test('passkey responses preserve six digits and bind the challenge', () => {
  assert.deepEqual(pairing.response(state, device, 7, '000123'), { address: device.address, challengeId: 7, passkey: '000123' });
  for (const pin of ['1234', '1234567', '12a456', 123456]) assert.throws(() => pairing.response(state, device, 7, pin), /six digits/);
});
test('stale and other-device challenges cannot receive passkeys', () => {
  assert.throws(() => pairing.response(state, device, 6, '000123'), /changed/);
  assert.throws(() => pairing.response(state, { address: '00:00:00:00:00:00' }, 7, '000123'), /changed/);
  assert.throws(() => pairing.response({ ...state, ble: {} }, device, 7, '000123'), /changed/);
});
test('numeric comparison requires an explicit boolean response', () => {
  const comparison = { ...state, security: { ...state.security, status: 'numeric-comparison' } };
  assert.equal(pairing.response(comparison, device, 7, false).accept, false);
  assert.throws(() => pairing.response(comparison, device, 7, '000123'), /does not accept/);
});
