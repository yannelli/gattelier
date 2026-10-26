import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

const Point = p256.Point, field = Point.Fn, order = field.ORDER;
const encoder = new TextEncoder(), client = encoder.encode('client'), server = encoder.encode('server');
export const concat = (...parts) => Uint8Array.from(parts.flatMap(part => Array.from(part)));
export function bytes(value, length, name = 'value') {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new Error(`G7 ${name} must contain ${length} bytes.`);
  return value;
}
export function integer(value) { return BigInt(`0x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`); }
export function scalarBytes(value) {
  const hex = value.toString(16).padStart(64, '0');
  if (hex.length !== 64 || value < 0n) throw new Error('G7 scalar exceeds its encoding.');
  return Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
}
export function secureRandom(length) {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random generation is unavailable.');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
function randomScalar(randomBytes) {
  for (let attempt = 0; attempt < 128; attempt++) {
    const candidate = integer(bytes(randomBytes(32), 32, 'random scalar'));
    if (candidate > 0n && candidate < order) return candidate;
  }
  throw new Error('G7 random source did not produce a valid scalar.');
}
function validPoint(point) {
  point.assertValidity();
  if (point.equals(Point.ZERO)) throw new Error('G7 proof contains the identity point.');
  return point;
}
const encodePoint = point => validPoint(point).toBytes(false).slice(1);
const decodePoint = value => validPoint(Point.fromBytes(concat(Uint8Array.of(4), bytes(value, 64, 'point'))));
function hashProof(base, commitment, publicPoint, identity) {
  const prefix = part => concat(Uint8Array.of(0, 0, 0, part.length), part);
  return field.create(integer(sha256(concat(prefix(validPoint(base).toBytes(false)), prefix(commitment.toBytes(false)), prefix(publicPoint.toBytes(false)), prefix(identity)))));
}
function decodeProof(value) {
  bytes(value, 160, 'proof');
  const response = integer(value.subarray(128));
  if (response >= order) throw new Error('G7 proof scalar is outside the curve order.');
  return { publicPoint: decodePoint(value.subarray(0, 64)), commitment: decodePoint(value.subarray(64, 128)), response };
}
function prove(base, secret, nonce) {
  validPoint(base);
  const publicPoint = base.multiply(secret), commitment = base.multiply(nonce);
  const response = field.sub(nonce, field.mul(hashProof(base, commitment, publicPoint, client), secret));
  return concat(encodePoint(publicPoint), encodePoint(commitment), scalarBytes(response));
}
function verify(base, proof) {
  const challenge = hashProof(base, proof.commitment, proof.publicPoint, server);
  if (!base.multiplyUnsafe(proof.response).add(proof.publicPoint.multiplyUnsafe(challenge)).equals(proof.commitment)) throw new Error('G7 peer proof verification failed.');
  return proof;
}

export function createJpake(pin, options = {}) {
  if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) throw new Error('Enter the four-digit G7 applicator code, including leading zeroes.');
  const randomBytes = options.randomBytes || secureRandom;
  let secret = integer(encoder.encode(pin)), x1 = randomScalar(randomBytes), x2 = randomScalar(randomBytes), destroyed = false, failed = false;
  const public1 = Point.BASE.multiply(x1), public2 = Point.BASE.multiply(x2), peer = [], rounds = [];
  const guard = () => { if (destroyed || failed) throw new Error('This G7 key exchange has ended.'); };
  function generate(index, base, exponent) {
    guard();
    if (!rounds[index]) rounds[index] = prove(base, exponent, randomScalar(randomBytes));
    return rounds[index].slice();
  }
  return {
    round1() { return generate(0, Point.BASE, x1); },
    round2() { return generate(1, Point.BASE, x2); },
    acceptPeerRound(round, value) {
      guard();
      try {
        if (![1, 2, 3].includes(round) || round !== peer.length + 1) throw new Error('G7 peer proofs arrived out of order.');
        const base = round === 3 ? validPoint(public1.add(public2).add(peer[0].publicPoint)) : Point.BASE;
        peer.push(verify(base, decodeProof(value)));
      } catch (error) { failed = true; x1 = 0n; x2 = 0n; secret = 0n; throw error; }
    },
    round3() {
      guard();
      if (peer.length < 2) throw new Error('G7 round three requires both peer public keys.');
      return generate(2, validPoint(public1.add(peer[0].publicPoint).add(peer[1].publicPoint)), field.mul(x2, secret));
    },
    deriveKey() {
      guard();
      if (peer.length !== 3) throw new Error('G7 session key requires three verified peer proofs.');
      const residual = validPoint(peer[2].publicPoint.subtract(peer[1].publicPoint.multiply(field.mul(x2, secret))));
      const shared = validPoint(residual.multiply(x2));
      return sha256(scalarBytes(shared.toAffine().x)).slice(0, 16);
    },
    destroy() { destroyed = true; secret = 0n; x1 = 0n; x2 = 0n; for (const round of rounds) round?.fill(0); peer.length = 0; }
  };
}
