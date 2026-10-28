import test from 'node:test';
import assert from 'node:assert/strict';
import schlage from '../web/schlage-protocol.js';

const device = { address: '02:00:00:00:00:01', addressType: 0, name: 'SCHLAGE0012287A' };
const identity = (uuid, text) => ({ uuid, valueHex: Buffer.from(text).toString('hex'), properties: ['read'] });
const state = { ble: { ...device, connected: true }, services: [
  { uuid: '180a', characteristics: [identity('2a24', 'BE489WB'), identity('2a29', 'Schlage'), identity('2a28', 'Software Revision'), identity('2a27', '')] },
  { uuid: schlage.transport, characteristics: [{ uuid: schlage.rx }, { uuid: schlage.tx }] }
] };

test('Schlage identifies Encode from device identity and omits placeholder revisions', () => {
  assert.equal(schlage.identify(device, state).title, 'Schlage Encode');
  assert.equal(schlage.identify(device, state).modelConfirmed, true);
  assert.deepEqual(schlage.identity(device, state), { model: 'BE489WB', manufacturer: 'Schlage' });
  assert.equal(schlage.identify(device).modelConfirmed, false);
});

test('Schlage matching does not turn chip vendors or another address type into lock identity', () => {
  assert.equal(schlage.identify({ manufacturer: '0d000000', name: 'TI sensor' }), null);
  assert.equal(schlage.identify({ name: 'NotSchlage0012287A' }), null);
  assert.equal(schlage.identify({ ...device, name: '', addressType: 1 }, state), null);
  assert.equal(schlage.identify({ ...device, name: '', address: '02:00:00:00:00:02' }, state), null);
  assert.equal(schlage.identify({ services: [schlage.transport.toUpperCase()] }).evidence, 'Schlage service');
});

test('uWeave mappings and decoders are scoped to the transport service', () => {
  assert.equal(schlage.lookup(schlage.rx, schlage.transport).name, 'uWeave commands');
  assert.equal(schlage.lookup(schlage.tx, schlage.transport).name, 'uWeave responses');
  assert.equal(schlage.lookup(schlage.rx, '180a'), null);
  assert.deepEqual(schlage.decode(schlage.tx, '0c112233', { serviceUuid: '180a' }), []);
  const fields = schlage.decode(schlage.tx, '2c112233', { serviceUuid: schlage.transport });
  assert.equal(fields.find(item => item.label === 'Fragment').value, 'Complete message');
  assert.equal(fields.find(item => item.label === 'Sequence').value, '2');
  assert.equal(fields.find(item => item.label === 'Payload length').value, '3 bytes');
  assert.equal(schlage.decode('e604e95d-a759-4817-87d3-aa005083a0d1', '0201', { serviceUuid: schlage.transport })[0].value, '258');
  for (const hex of ['', '1', 'zz', '00'.repeat(513)]) assert.deepEqual(schlage.decode(schlage.rx, hex, { serviceUuid: schlage.transport }), []);
});
