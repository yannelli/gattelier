import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const p = require('../web/plaud-protocol.js');
const encode = text => new TextEncoder().encode(text);
const privateKeyPem = '-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----';
const publicKeyPem = '-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----';
const credentials = { serial: '01020304aabbccdd', userId: 'example', privateKeyPem, publicKeyPem, signature: Buffer.alloc(256, 7).toString('base64') };
const set16 = (bytes, offset, value) => new DataView(bytes.buffer).setUint16(offset, value, true);
const set32 = (bytes, offset, value) => new DataView(bytes.buffer).setUint32(offset, value, true);

test('credentials validate imported fields and decode the RSA signature', () => {
  const result = p.credentials(credentials);
  assert.equal(result.signature.length, 256); assert.equal(result.signature[0], 7);
  assert.equal(result.publicKeyPem, publicKeyPem);
  for (const override of [{ serial: '1234' }, { userId: 'é' }, { userId: 'a'.repeat(33) }, { privateKeyPem: publicKeyPem }, { signature: '%%%%' }, { signature: 'AQID' }]) {
    assert.throws(() => p.credentials({ ...credentials, ...override }));
  }
});
test('service and characteristic handles accept standard short and full UUIDs', () => {
  const state = { services: [{ uuid: '00001910-0000-1000-8000-00805f9b34fb', characteristics: [
    { uuid: '0x2BB1', handle: 12 }, { uuid: '00002bb0-0000-1000-8000-00805f9b34fb', handle: 15 }
  ] }] };
  assert.deepEqual(p.handles(state), { command: 12, response: 15 });
  assert.deepEqual(p.handles({}), { command: undefined, response: undefined });
});
test('FE12 chunks reassemble out of order and accept matching duplicates', () => {
  const payload = Uint8Array.from({ length: 256 }, (_, i) => i), chunks = p.chunks(0xfe12, payload);
  assert.deepEqual(Array.from(chunks[0].slice(0, 4)), [0x12, 0xfe, 3, 0]);
  assert.deepEqual(chunks.map(chunk => chunk.length), [104, 104, 60]);
  const assembler = new p.Assembler();
  assert.equal(assembler.add(chunks[2]), null); assert.equal(assembler.add(chunks[2]), null);
  assert.equal(assembler.add(chunks[0]), null); assert.deepEqual(assembler.add(chunks[1]), payload);
});
test('FE12 rejects conflicting duplicates, total changes, indices and wrong secret size', () => {
  const chunks = p.chunks(0xfe12, new Uint8Array(256)), assembler = new p.Assembler();
  assembler.add(chunks[0]);
  const duplicate = chunks[0].slice(); duplicate[4] = 1;
  assert.throws(() => assembler.add(duplicate), /Conflicting/);
  const total = chunks[1].slice(); total[2] = 2;
  assert.throws(() => assembler.add(total));
  const index = chunks[1].slice(); index[3] = 3;
  assert.throws(() => assembler.add(index));
  assert.throws(() => new p.Assembler().add(Uint8Array.of(0x12, 0xfe, 1, 0, 0)), /256-byte/);
  assert.throws(() => new p.Assembler().add(new Uint8Array(105)));
  assert.throws(() => new p.Assembler().add(Uint8Array.of(0x10, 0xfe, 1, 0, 0)));
  for (const [opcode, payload, max] of [[0xfe30, [1], 100], [0xfe12, [], 100], [0xfe12, [1], 0], [0xfe12, [1], 101], [0xfe12, new Uint8Array(256), 1]]) {
    assert.throws(() => p.chunks(opcode, payload, max));
  }
});
test('session verifies the secret layout and authenticates before advancing receive sequence', () => {
  const secret = Uint8Array.from({ length: 80 }, (_, i) => i), encrypted = new Uint8Array(25);
  const reply = Uint8Array.of(3, 0, 0, 0, 1, 26, 0);
  let fail = false, malformed = false, sealed;
  globalThis.NanoPlaudCrypto = {
    decryptRSA(pem, wrapped) { assert.equal(pem, privateKeyPem); assert.equal(wrapped.length, 256); return secret; },
    decryptChaCha(key, nonce, aad, input) {
      assert.deepEqual(key, secret.slice(0, 32)); assert.deepEqual(nonce, secret.slice(32, 44)); assert.deepEqual(aad, secret.slice(44, 56));
      if (input.length === 24) { assert.deepEqual(input, secret.slice(56)); return encode('PLAUD.AI'); }
      if (fail) throw new Error('authentication failed');
      return malformed ? new Uint8Array(3) : reply;
    },
    encryptChaCha(key, nonce, aad, input) { sealed = input; return encrypted; }
  };
  const session = new p.Session(privateKeyPem, new Uint8Array(256));
  assert.equal(session.seal([1, 26, 0]), encrypted);
  assert.deepEqual(Array.from(sealed), [2, 0, 0, 0, 1, 26, 0]);
  fail = true; assert.throws(() => session.open(encrypted), /authentication/); assert.equal(session.rxSeq, -1);
  fail = false; malformed = true; assert.throws(() => session.open(encrypted), /Invalid session/);
  malformed = false; assert.deepEqual(session.open(encrypted), reply.slice(4));
  assert.equal(session.open(encrypted), null);
  set32(reply, 0, 2); assert.equal(session.open(encrypted), null);
  assert.throws(() => session.open(new Uint8Array(19)));
  session.txSeq = 0xffffffff; assert.throws(() => session.seal([]), /exhausted/);
  globalThis.NanoPlaudCrypto.decryptChaCha = () => encode('WRONG.AI');
  assert.throws(() => new p.Session(privateKeyPem, new Uint8Array(256)), /marker/);
});
test('commands encode little-endian IDs, handshake padding and download offsets', () => {
  assert.deepEqual(Array.from(p.command(0x1234, [8])), [1, 0x34, 0x12, 8]);
  const handshake = p.handshake('abc', true);
  assert.equal(handshake.length, 38);
  assert.deepEqual(Array.from(handshake.slice(0, 6)), [1, 1, 0, 2, 0, 1]);
  assert.equal(new TextDecoder().decode(handshake.slice(6)), 'abc' + '0'.repeat(29));
  const download = p.downloadRequest(0x12345678, 2, 256);
  assert.deepEqual(Array.from(download), [1, 28, 0, 0x78, 0x56, 0x34, 0x12, 2, 0, 0, 0, 0, 1, 0, 0]);
  const list = p.listRequest(23);
  assert.equal(list.length, 12); assert.equal(new DataView(list.buffer).getUint32(7, true), 23); assert.equal(list[11], 0);
  assert.throws(() => p.downloadRequest(1, 3, 2)); assert.throws(() => p.listRequest(-1));
  assert.throws(() => p.command(65536)); assert.throws(() => p.command(1, [256]));
});
test('recording list parses complete entries and validates empty lists and bounds', () => {
  const packet = new Uint8Array(21); packet.set([1, 26, 0]);
  set32(packet, 3, 99); set16(packet, 7, 3); set16(packet, 9, 2);
  set32(packet, 11, 1234); set32(packet, 15, 9876); packet.set([7, 8], 19);
  assert.deepEqual(p.parseList(packet), { requestId: 99, total: 3, index: 2, entries: [{ id: 1234, size: 9876, attributes: [7, 8] }] });
  const empty = new Uint8Array(11); empty.set([1, 26, 0]);
  assert.deepEqual(p.parseList(empty), { requestId: 0, total: 0, index: 0, entries: [] });
  assert.throws(() => p.parseList(packet.slice(0, 20)));
  set16(packet, 9, 3); assert.throws(() => p.parseList(packet), /announced/);
  empty[1] = 28; assert.throws(() => p.parseList(empty));
});
test('recording data requires exact byte lengths and distinguishes end codes', () => {
  const packet = new Uint8Array(13); packet[0] = 2; set32(packet, 1, 123); set32(packet, 5, 4096); packet.set([3, 9, 8, 7], 9);
  assert.deepEqual(p.parseData(packet), { id: 123, offset: 4096, end: false, data: Uint8Array.of(9, 8, 7) });
  assert.throws(() => p.parseData(packet.slice(0, 12)));
  const end = packet.slice(0, 10); set32(end, 5, 0xffffffff); end[9] = 4;
  assert.deepEqual(p.parseData(end), { id: 123, offset: 0xffffffff, end: true, code: 4, data: new Uint8Array() });
  set32(packet, 5, 0xffffffff); assert.throws(() => p.parseData(packet));
  assert.throws(() => p.parseData(new Uint8Array(9)));
});
function oggPage(eos = true) {
  const page = new Uint8Array(31); page.set(encode('OggS')); page[5] = eos ? 4 : 0; page[26] = 1; page[27] = 3; page.set([1, 2, 3], 28);
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
  }
  set32(page, 22, crc >>> 0); return page;
}
test('recording decrypt uses header offsets, last32 key bytes and validates every Ogg page', () => {
  const file = new Uint8Array(523), secret = Uint8Array.from({ length: 48 }, (_, i) => i);
  file.set(encode('PLAUD.AI')); set16(file, 8, 1); set16(file, 10, 520); set32(file, 128, 0x12345678);
  file.set(Uint8Array.from({ length: 12 }, (_, i) => i + 20), 132); file.fill(5, 256, 512); file.set([8, 9, 10], 520);
  let plain = oggPage();
  globalThis.NanoPlaudCrypto = {
    decryptRSA(pem, cipher) { assert.equal(pem, privateKeyPem); assert.deepEqual(cipher, new Uint8Array(256).fill(5)); return secret; },
    chacha20(key, nonce, body, counter) {
      assert.deepEqual(key, secret.slice(-32)); assert.deepEqual(nonce, file.slice(132, 144));
      assert.deepEqual(body, Uint8Array.of(8, 9, 10)); assert.equal(counter, 0x12345678); return plain;
    }
  };
  assert.equal(p.decryptRecording(file, privateKeyPem), plain);
  const pages = new Uint8Array(62); pages.set(oggPage(false)); pages.set(oggPage(), 31); plain = pages;
  assert.equal(p.decryptRecording(file, privateKeyPem), pages);
  plain[28] ^= 1; assert.throws(() => p.decryptRecording(file, privateKeyPem), /CRC/);
  plain = oggPage(false); assert.throws(() => p.decryptRecording(file, privateKeyPem), /end page/);
  plain = new Uint8Array([...oggPage(), 0]); assert.throws(() => p.decryptRecording(file, privateKeyPem), /header/);
  plain = oggPage().slice(0, 30); assert.throws(() => p.decryptRecording(file, privateKeyPem), /body/);
  plain = oggPage(); plain[26] = 255; assert.throws(() => p.decryptRecording(file, privateKeyPem), /segment/);
  set16(file, 8, 2); assert.throws(() => p.decryptRecording(file, privateKeyPem), /Unsupported/);
  set16(file, 8, 1); set16(file, 10, 511); assert.throws(() => p.decryptRecording(file, privateKeyPem), /header size/);
  assert.throws(() => p.decryptRecording(new Uint8Array(512), privateKeyPem), /Unsupported/);
});
