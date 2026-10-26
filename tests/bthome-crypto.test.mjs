import { createRequire } from 'node:module';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { decrypt, sources } = require('../web/bthome-crypto.js');
const key = '231d39c1d7cc1ab1aee224cd096db932', mac = '54:48:e6:8f:80:a5', hex = '41e445f3c9962b332211006c7c4519';

test('Official BTHome v2 example authenticates with canonical MAC byte order', async () => {
  assert.deepEqual(await decrypt({ hex, mac, key }), { hex: '4002ca0903bf13', counter: 1122867 });
  assert.deepEqual(await decrypt({ hex, mac: '5448E68F80A5', key: Buffer.from(key, 'hex') }), { hex: '4002ca0903bf13', counter: 1122867 });
  assert.match(sources[1].url, /18e1c664c8595ac5f7e2daa63e9a90516ccd3800/);
  await assert.rejects(decrypt({ hex, mac: 'a5:80:8f:e6:48:54', key }), /authentication failed/);
});

test('Ciphertext, counter, MIC, information byte, key and MAC tampering withholds plaintext', async () => {
  const frame = Buffer.from(hex, 'hex');
  for (let index = 1; index < frame.length; index++) {
    const modified = Buffer.from(frame); modified[index] ^= 1;
    await assert.rejects(decrypt({ hex: modified.toString('hex'), mac, key }), /authentication failed/, `byte ${index}`);
  }
  await assert.rejects(decrypt({ hex: '45' + hex.slice(2), mac, key }), /authentication failed/);
  await assert.rejects(decrypt({ hex, mac, key: '001d39c1d7cc1ab1aee224cd096db932' }), /authentication failed/);
  await assert.rejects(decrypt({ hex, mac: '54:48:e6:8f:80:a4', key }), /authentication failed/);
});

test('WebCrypto CCM matches independent Node AES-CCM across block boundaries', async () => {
  for (const length of [2, 15, 16, 17, 31, 32, 33, 250, 511]) {
    const cleartext = Buffer.from(Array.from({ length }, (_, index) => (index * 37 + 9) & 255));
    const header = 0x45, counter = Buffer.from('feffffff', 'hex');
    const nonce = Buffer.concat([Buffer.from('5448e68f80a5d2fc', 'hex'), Buffer.of(header), counter]);
    const cipher = createCipheriv('aes-128-ccm', Buffer.from(key, 'hex'), nonce, { authTagLength: 4 });
    cipher.setAAD(Buffer.alloc(0), { plaintextLength: length });
    const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    const frame = Buffer.concat([Buffer.of(header), ciphertext, counter, cipher.getAuthTag()]);
    assert.deepEqual(await decrypt({ hex: frame.toString('hex'), mac, key }), { hex: '44' + cleartext.toString('hex'), counter: 4294967294 }, `length ${length}`);
  }
});

test('Invalid encrypted input and unavailable browser cryptography return explicit errors', async () => {
  for (const invalid of ['', '41', '410203', 'abc', 'zz', '40' + hex.slice(2), '43' + hex.slice(2), '61' + hex.slice(2)]) {
    await assert.rejects(decrypt({ hex: invalid, mac, key }), /Invalid/);
  }
  for (const invalid of ['', '00'.repeat(15), '00'.repeat(17), 'zz'.repeat(16)]) await assert.rejects(decrypt({ hex, mac, key: invalid }), /Invalid BTHome key/);
  for (const invalid of ['', '54:48:e6:8f:80', '54-48-e6-8f-80-a5']) await assert.rejects(decrypt({ hex, mac: invalid, key }), /MAC address/);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try { await assert.rejects(decrypt({ hex, mac, key }), /HTTPS or localhost/); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto; }
});
