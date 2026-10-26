import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const p = require('../web/sleep-number-protocol.js');
const firmnessFrame = '66557a496f4e1e000000504153533a41434b2030203335203430c288af52';
const privacyFrame = '66557a496f4e19000000504153533a616374697665bcd2058b';
const configurationFrame = '66557a496f4e5b000000504153533a41434b206475616c2079657320796573206e6f2079657320686561745f636f6f6c2079657320796573207965732079657320796573207965732079657320796573206e6f20796573d7accd1f';

test('read-only commands match independently calculated Fuzion frame vectors', () => {
  assert.equal(p.hex(p.request('capabilities')), '66557a496f4e1300000053594347203cb4f0d0');
  assert.equal(p.hex(p.request('left')), '66557a496f4e17000000534e4347206c65667470976526');
  assert.equal(p.hex(p.request('right')), '66557a496f4e18000000534e4347207269676874c45b6ef1');
  assert.equal(p.hex(p.request('privacy')), '66557a496f4e130000005350524720f1321cb0');
  for (const command of ['SNCS', 'ACTS', 'SPRS', 'constructor', 'toString', 'SYCG ', 'left\nSNCS left 100']) assert.throws(() => p.request(command), /read-only/);
});

test('Fuzion response assembly handles split headers and verifies a complete CRC', () => {
  const frame = p.bytes(firmnessFrame), assembler = new p.Assembler();
  assert.equal(assembler.append(frame.subarray(0, 3)), null);
  assert.equal(assembler.append(frame.subarray(3, 12)), null);
  assert.equal(assembler.append(frame.subarray(12)), 'PASS:ACK 0 35 40');
  assert.equal(p.decodeFrame(privacyFrame), 'PASS:active');
  assert.throws(() => assembler.append(Uint8Array.of(0)), /length/);
});

test('malformed frames, bad CRC, invalid UTF-8 and oversized responses are rejected', () => {
  const frame = p.bytes(firmnessFrame);
  assert.throws(() => p.decodeFrame(frame.subarray(0, -1)), /incomplete/);
  const badCrc = frame.slice(); badCrc[12] ^= 1;
  assert.throws(() => p.decodeFrame(badCrc), /CRC/);
  const badHeader = frame.slice(); badHeader[0] = 0;
  assert.throws(() => p.decodeFrame(badHeader), /header/);
  const tooBig = frame.slice(); new DataView(tooBig.buffer).setUint32(6, 9000, true);
  assert.throws(() => p.decodeFrame(tooBig), /length/);
  const invalid = frame.slice(); invalid[10] = 255; new DataView(invalid.buffer).setUint32(invalid.length - 4, p.crc32(invalid.subarray(0, -4)), true);
  assert.throws(() => p.decodeFrame(invalid), /encoded data/);
  assert.throws(() => new p.Assembler().append(new Uint8Array()), /fragment/);
  assert.throws(() => p.bytes('0xz1'), /hexadecimal/);
});

test('session validation rejects refusal sentinels and accepts matching readback hints', () => {
  const id = p.session('00112233445566778899aabbccddeeff');
  assert.throws(() => p.session('00000000000000000000000000000000'), /connection limit/);
  assert.throws(() => p.session('00000000000000000000000000000001'), /rejected/);
  assert.throws(() => p.session('001122'), /16-byte/);
  assert.equal(p.hint(id, id), true);
  assert.equal(p.hint(new Uint8Array(16), id), true);
  assert.equal(p.hint('00112233445566778899aabbccddeefe', id), false);
  assert.equal(p.hint('00', id), false);
});

test('metadata parser keeps typed fields and rejects unknown enums and missing values', () => {
  assert.deepEqual(p.response('left', p.decodeFrame(firmnessFrame)), [
    { label: 'Side', value: 'left' }, { label: 'Adjustment status code', value: '0' },
    { label: 'Ambient firmness setting', value: '35' }, { label: 'User firmness setting', value: '40' }
  ]);
  assert.equal(p.response('privacy', p.decodeFrame(privacyFrame))[0].value, 'active');
  const configuration = p.response('capabilities', p.decodeFrame(configurationFrame));
  assert.equal(configuration.length, 16);
  assert.deepEqual(configuration[5], { label: 'Thermal control', value: 'heat_cool' });
  assert.throws(() => p.response('left', 'PASS:ACK 2 35 40'), /firmness/);
  assert.throws(() => p.response('right', 'PASS:1 35.5 40'), /firmness/);
  assert.throws(() => p.response('right', 'PASS:1 35 9007199254740992'), /firmness/);
  assert.throws(() => p.response('capabilities', 'PASS:dual yes'), /capability/);
  assert.throws(() => p.response('capabilities', p.decodeFrame(configurationFrame).replace('heat_cool', 'yes')), /capability/);
  assert.throws(() => p.response('privacy', 'PASS:off'), /privacy/);
  assert.throws(() => p.response('privacy', 'PASS:active paused'), /privacy/);
  assert.throws(() => p.response('privacy', 'FAIL:0'), /unsupported/);
  assert.throws(() => p.response('privacy', 'FAIL:1'), /timed out/);
  assert.throws(() => p.response('privacy', 'FAIL:2'), /protocol/);
  assert.throws(() => p.response('privacy', 'active'), /unknown/);
});

test('service discovery keeps MCR separate and binds characteristics to Fuzion service', () => {
  const chars = [{ uuid: p.AUTH, handle: 10 }, { uuid: p.BAMKEY, handle: 12 }];
  assert.deepEqual(p.handles({ services: [{ uuid: p.SERVICE.toUpperCase(), characteristics: chars }] }), { variant: 'Fuzion', auth: chars[0], bamkey: chars[1] });
  assert.deepEqual(p.handles({ services: [{ uuid: p.MCR, characteristics: chars }] }), { variant: 'MCR' });
  assert.deepEqual(p.handles({ services: [{ uuid: '180a', characteristics: chars }] }), { variant: null });
});
