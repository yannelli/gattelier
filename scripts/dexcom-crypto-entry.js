import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ecb } from '@noble/ciphers/aes.js';
import { createJpake, bytes, concat, secureRandom } from './dexcom-jpake.js';
import { protocolCertificates, certificateSigningKey } from './dexcom-material.js';

export { createJpake };
export function aes8(key, value) {
  bytes(key, 16, 'session key'); bytes(value, 8, 'AES input');
  return ecb(key, { disablePadding: true }).encrypt(concat(value, value)).slice(0, 8);
}
export function signCertificateChallenge(packet) {
  bytes(packet, 18, 'certificate challenge');
  if (packet[0] !== 0x0c || packet[1] !== 0) throw new Error('G7 certificate challenge header is invalid.');
  return p256.sign(sha256(packet.subarray(2)), certificateSigningKey(), { prehash: false, lowS: false, format: 'compact', extraEntropy: true });
}
export const certificates = () => protocolCertificates();
export const randomToken = () => secureRandom(8);
globalThis.NanoDexcomCrypto = { createJpake, aes8, certificates, signCertificateChallenge, randomToken };
