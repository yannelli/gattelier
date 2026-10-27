import { chacha20, chacha20poly1305 } from '@noble/ciphers/chacha.js';

// WebCrypto has no RSAES-PKCS1-v1_5 and is unavailable on the board's plain-HTTP page, so the key is used via BigInt.
const keyError = () => new Error('Expected an RSA private key PEM.');
const toBigInt = bytes => BigInt(`0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') || '0'}`);
function der(bytes, at = 0) {
  const tag = bytes[at++];
  let length = bytes[at++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 3) throw keyError();
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[at++];
  }
  if (tag === undefined || !(at + length <= bytes.length)) throw keyError();
  return { tag, body: bytes.subarray(at, at + length), end: at + length };
}
function sequence(bytes) {
  const outer = der(bytes);
  if (outer.tag !== 0x30) throw keyError();
  const items = [];
  for (let at = 0; at < outer.body.length; at = items[items.length - 1].end) items.push(der(outer.body, at));
  return items;
}
function privateKey(pem) {
  const match = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----/.exec(pem);
  if (!match) throw keyError();
  let items = sequence(Uint8Array.from(atob(match[2].replace(/\s/g, '')), character => character.charCodeAt(0)));
  if (match[1] === 'PRIVATE KEY') {
    const oid = items[1]?.tag === 0x30 ? der(items[1].body) : null;
    if (items.length < 3 || oid?.tag !== 0x06 || toBigInt(oid.body) !== 0x2a864886f70d010101n || items[2].tag !== 0x04) throw keyError();
    items = sequence(items[2].body);
  }
  if (items.length !== 9 || items.some(item => item.tag !== 0x02)) throw keyError();
  const [, n, e, d, p, q, dp, dq, qi] = items.map(item => toBigInt(item.body));
  return { n, e, d, p, q, dp, dq, qi };
}
function modPow(base, exponent, modulus) {
  let result = 1n;
  for (base %= modulus; exponent; exponent >>= 1n) {
    if (exponent & 1n) result = result * base % modulus;
    base = base * base % modulus;
  }
  return result;
}
globalThis.NanoPlaudCrypto = {
  decryptRSA(pem, ciphertext) {
    const key = privateKey(pem);
    if (key.n.toString(2).length !== 2048 || ciphertext.length !== 256) throw new Error('PLAUD requires an RSA-2048 key and 256-byte ciphertext.');
    const c = toBigInt(ciphertext);
    if (c >= key.n) throw new Error('RSA decryption failed.');
    const m1 = modPow(c, key.dp, key.p), m2 = modPow(c, key.dq, key.q);
    const m = m2 + key.qi * (((m1 - m2) % key.p + key.p) % key.p) % key.p * key.q;
    if (modPow(m, key.e, key.n) !== c) throw new Error('RSA decryption failed.');
    const hex = m.toString(16).padStart(512, '0'), block = Uint8Array.from({ length: 256 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
    // PKCS#1 v1.5 type 2: 00 02, at least eight nonzero padding bytes, 00, message.
    const separator = block.indexOf(0, 2);
    if (block[0] !== 0 || block[1] !== 2 || separator < 10) throw new Error('RSA decryption failed.');
    return block.slice(separator + 1);
  },
  encryptChaCha: (key, nonce, aad, bytes) => chacha20poly1305(key, nonce, aad).encrypt(bytes),
  decryptChaCha: (key, nonce, aad, bytes) => chacha20poly1305(key, nonce, aad).decrypt(bytes),
  chacha20: (key, nonce, bytes, counter) => chacha20(key, nonce, bytes, undefined, counter)
};
