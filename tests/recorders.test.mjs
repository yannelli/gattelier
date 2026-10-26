import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { identify, decode } = require('../web/recorders.js');
const hex = data => Buffer.from(data).toString('hex');
const text = value => Buffer.from(value, 'utf8').toString('hex');
function advertisement(project = 881, version = 20, serial = '01020304AABBCCDD') {
  const data = Buffer.alloc(22);
  data.writeUInt16LE(0x1234, 0); data[2] = 2; data.writeUInt16LE(project, 3);
  data[5] = 4; data[10] = 8; Buffer.from(serial, 'hex').copy(data, 11); data.writeUInt16LE(version, 20);
  return data;
}

test('Note Pro identity uses exact advertisement serial and little-endian project/version', () => {
  assert.deepEqual(identify({ manufacturer: hex(advertisement()) }), {
    product: 'PLAUD Note Pro', serial: '01020304AABBCCDD', protocolVersion: 20, encrypted: true,
    summary: 'Serial 01020304AABBCCDD · protocol 20 · encrypted session'
  });
  const other = identify({ manufacturer: hex(advertisement(883, 9, '0102030405060708')) });
  assert.equal(other.product, 'PLAUD Note Pro'); assert.equal(other.serial, '0102030405060708');
  assert.equal(other.protocolVersion, 9); assert.equal(other.encrypted, false);
});

test('truncated, malformed and shifted advertisements do not identify Note Pro', () => {
  for (let length = 0; length < 22; length++) assert.equal(identify({ manufacturer: hex(advertisement().subarray(0, length)) }), null);
  for (const value of ['xx', '123', '', undefined, '0000']) assert.equal(identify({ manufacturer: value }), null);
  assert.equal(identify({ manufacturer: hex(advertisement().subarray(2)) }), null);
  for (const offset of [2, 5, 10]) {
    const data = advertisement(); data[offset]++;
    assert.equal(identify({ manufacturer: hex(data) }), null);
  }
});

test('model identification rejects unrelated projects, names, addresses and serial text', () => {
  assert.equal(identify({ manufacturer: hex(advertisement(880)) }), null);
  assert.equal(identify({ name: 'PLAUD Note Pro', address: '02:00:00:00:00:03', manufacturer: '01020304AABBCCDD' }), null);
  assert.equal(identify({ manufacturer: '4c00021500112233445566778899aabbccddeeff001122' }), null);
  assert.equal(identify(null), null);
});

test('Pocket requires both its name prefix and one exact advertised service', () => {
  assert.equal(identify({ name: 'PKT01_123456', services: ['0x5536'] }).product, 'Pocket Recorder');
  assert.equal(identify({ name: 'PKT01_123456', services: ['00002222-0000-1000-8000-00805f9b34fb'] }).product, 'Pocket Recorder');
  assert.equal(identify({ name: 'PKT01_123456', services: [] }), null);
  assert.equal(identify({ name: 'Other', services: ['5536'] }), null);
  assert.equal(identify({ name: 'PKT01_123456', services: ['aa5536bb-1111-2222-3333-444455556666'] }), null);
});

test('Pocket authentication command data is fully omitted from labels', () => {
  for (const input of ['APP&SK&private-key', 'MCU&FW&1.2APP&SK&private-key']) {
    const label = decode({ hex: text(input) });
    assert.equal(label, 'Pocket authentication command · redacted');
    assert.equal(label.includes('private-key'), false);
  }
  assert.equal(decode({ hex: text('MCU&SK&OK') }), 'Pocket authentication accepted');
  assert.equal(decode({ hex: text('MCU&SK&ERR') }), 'Pocket authentication rejected');
});

test('Pocket commands and recording replies have concrete packet labels', () => {
  assert.equal(decode({ hex: text('APP&LIST_DIRS') }), 'Pocket: list recording dates');
  assert.equal(decode({ hex: text('APP&U&20261025&001.mp3') }), 'Pocket: download 20261025/001.mp3');
  assert.equal(decode({ hex: text('MCU&U&1024') }), 'Pocket download: 1024 bytes announced');
  assert.equal(decode({ hex: text('MCU&F&20261025&001.mp3&60') }), 'Pocket recording: 20261025/001.mp3 · 60s');
});

test('PLAUD chunk envelopes decode little-endian opcodes and zero-based indices', () => {
  assert.equal(decode({ uuid: '0x2bb1', hex: '10fe0300aa' }), 'PLAUD FE10 signature · chunk 1/3 (index 0)');
  assert.equal(decode({ uuid: '00002bb0-0000-1000-8000-00805f9b34fb', hex: '12fe0302aa' }), 'PLAUD FE12 encrypted session secret · chunk 3/3 (index 2)');
  assert.equal(decode({ uuid: '2BB0', hex: '11fe' }), 'PLAUD FE11 public-key request');
  assert.equal(decode({ uuid: '2bb0', hex: '12fe03' }), 'PLAUD FE12 encrypted session secret · truncated header');
  assert.equal(decode({ uuid: '2bb0', hex: '12fe0303aa' }), 'PLAUD FE12 encrypted session secret · invalid chunk header');
  assert.equal(decode({ uuid: '2bb0', hex: '12fe0300aa', truncated: true }), 'PLAUD FE12 encrypted session secret · chunk 1/3 (index 0) · truncated');
});

test('unknown payloads are not presented as decoded or implicitly encrypted', () => {
  assert.equal(decode({ uuid: '2bb0', hex: 'aabbccdd' }), 'PLAUD protocol payload');
  assert.equal(decode({ uuid: '2bb1', hex: 'aabbccdd', encrypted: true }), 'PLAUD encrypted session payload');
  assert.equal(decode({ uuid: '2bb0', hex: 'fe10' }), 'PLAUD protocol payload');
  assert.equal(decode({ uuid: '2bb0', hex: 'not-hex' }), 'PLAUD protocol payload');
  assert.equal(decode({ uuid: 'ffff', hex: '12fe0302aa' }), '');
  assert.equal(decode({ hex: '00' }), '');
  assert.equal(decode(null), '');
});
