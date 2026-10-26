import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { generateKeyPairSync, publicEncrypt, constants, createCipheriv, randomBytes } from 'node:crypto';
const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout });
context.window = context;
vm.runInContext(readFileSync(new URL('../web/plaud-crypto.js', import.meta.url), 'utf8'), context);
const c = context.NanoPlaudCrypto;

test('browser RSA decrypts a PKCS8 account key and rejects damaged padding', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const plain = randomBytes(80);
  const encrypted = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, plain);
  assert.deepEqual(Buffer.from(c.decryptRSA(pem, encrypted)), plain);
  assert.throws(() => c.decryptRSA(pem, new Uint8Array(256)));
});
test('browser session AEAD matches independent OpenSSL encryption and rejects a changed tag', () => {
  const key = randomBytes(32), nonce = randomBytes(12), aad = randomBytes(12), plain = randomBytes(96);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plain.length });
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  assert.deepEqual(Buffer.from(c.encryptChaCha(key, nonce, aad, plain)), encrypted);
  assert.deepEqual(Buffer.from(c.decryptChaCha(key, nonce, aad, encrypted)), plain);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => c.decryptChaCha(key, nonce, aad, encrypted));
});
test('recording ChaCha20 uses the RFC8439 counter and nonce layout', () => {
  const key = randomBytes(32), nonce = randomBytes(12), plain = randomBytes(513), iv = Buffer.alloc(16);
  iv.writeUInt32LE(7); nonce.copy(iv, 4);
  const cipher = createCipheriv('chacha20', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  assert.deepEqual(Buffer.from(c.chacha20(key, nonce, encrypted, 7)), plain);
});

test('complete protocol session and recording decrypt with real RSA and ChaCha', () => {
  vm.runInContext(readFileSync(new URL('../web/plaud-protocol.js', import.meta.url), 'utf8') + '\nglobalThis.protocol = NanoPlaudProtocol;', context);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const key = randomBytes(32), nonce = randomBytes(12), aad = randomBytes(12);
  const encrypt = plain => {
    const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad, { plaintextLength: plain.length });
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  const wrap = plain => publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, plain);
  const wrapped = wrap(Buffer.concat([key, nonce, aad, encrypt(Buffer.from('PLAUD.AI'))]));
  const session = new context.protocol.Session(pem, wrapped);
  const packet = Buffer.from([2, 0, 0, 0, 1, 26, 0]);
  assert.deepEqual(Buffer.from(session.open(encrypt(packet))), packet.subarray(4));
  assert.equal(session.open(encrypt(packet)), null);
  const audio = readFileSync(new URL('./fixtures/plaud-test.ogg', import.meta.url));
  const header = Buffer.alloc(512); header.write('PLAUD.AI'); header.writeUInt16LE(1, 8); header.writeUInt16LE(512, 10);
  header.writeUInt32LE(1, 128); nonce.copy(header, 132); wrap(key).copy(header, 256);
  const cipher = createCipheriv('chacha20', key, header.subarray(128, 144));
  const encrypted = Buffer.concat([header, cipher.update(audio), cipher.final()]);
  assert.deepEqual(Buffer.from(context.protocol.decryptRecording(encrypted, pem)), audio);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => context.protocol.decryptRecording(encrypted, pem));
});
