import forge from 'node-forge/lib/forge.js';
import 'node-forge/lib/asn1.js';
import 'node-forge/lib/pem.js';
import 'node-forge/lib/rsa.js';
import { chacha20, chacha20poly1305 } from '@noble/ciphers/chacha.js';

const toBinary = bytes => Array.from(bytes, byte => String.fromCharCode(byte)).join('');
const fromBinary = text => Uint8Array.from(text, character => character.charCodeAt(0));
globalThis.NanoPlaudCrypto = {
  decryptRSA(pem, ciphertext) {
    const decoded = forge.pem.decode(pem)[0];
    if (!decoded || !['PRIVATE KEY', 'RSA PRIVATE KEY'].includes(decoded.type)) throw new Error('Expected an RSA private key PEM.');
    const key = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(decoded.body));
    if (key.n.bitLength() !== 2048 || ciphertext.length !== 256) throw new Error('PLAUD requires an RSA-2048 key and 256-byte ciphertext.');
    return fromBinary(key.decrypt(toBinary(ciphertext), 'RSAES-PKCS1-V1_5'));
  },
  encryptChaCha: (key, nonce, aad, bytes) => chacha20poly1305(key, nonce, aad).encrypt(bytes),
  decryptChaCha: (key, nonce, aad, bytes) => chacha20poly1305(key, nonce, aad).decrypt(bytes),
  chacha20: (key, nonce, bytes, counter) => chacha20(key, nonce, bytes, undefined, counter)
};
