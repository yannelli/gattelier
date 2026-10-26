// SPDX-License-Identifier: GPL-3.0-or-later
// Captured Juggluco fixtures and provenance: ../DEXCOM-CRYPTO-NOTICE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify, X509Certificate } from 'node:crypto';
import { createJpake, aes8, certificates, signCertificateChallenge } from '../scripts/dexcom-crypto-entry.js';

const hex = bytes => Buffer.from(bytes).toString('hex');
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const scalar = number => bytes(BigInt(number).toString(16).padStart(64, '0'));
const random = (...values) => length => { assert.equal(length, 32); assert.ok(values.length, 'Unexpected random scalar request'); return scalar(values.shift()); };
const fixtures = {
  "client1": "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f551590b7a515140d2d784c85608668fdfef8c82fd1f5be52421554a0dc3d033ede0c17da8904a727d8ae1bf36bf8a79260d012f00d4d80888d1d0bb44fda16da4599572f2394aabed63f3caccb1bea8374ab19301edfb7fad8947877884da782b",
  "client2": "7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc4766997807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1b01a172a76a4602c92d3242cb897dde3024c740debb215b4c6b0aae93c2291a9e85c10743237dad56fec0e2dfba703791c00f7701c7e16bdfd7c48538fc77fe234c6c22711abec84038fb4cbcd0853b0187fc468c3eac71a05034e02501bb320",
  "peer1": "5ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c8734640c4998ff7e374b06ce1a64a2ecd82ab036384fb83d9a79b127a27d50328e533b6fa0bf7b4625bb30667c01fb607ef9f8b8a80fef5b300628703187b2a373eb1dbde03318366d069f83a6f5900053c73633cb041b21c55e1a86c1f400b4f1e419bea0ef4b339f4704d101ae0bdaf6414aba820062357796fdd499c0f7d9",
  "peer2": "e2534a3532d08fbba02dde659ee62bd0031fe2db785596ef509302446b030852e0f1575a4c633cc719dfee5fda862d764efc96c3f30ee0055c42c23f184ed8c63ed113b7883b4c590638379db0c21cda16742ed0255048bf433391d374bc21d19099209accc4c8a224c843afa4f4c68a090d04da5e9889dae2f8eefce82a3740ef0466759b735b08b236cf3ebc8b093d1101892657579d55e24f1ecde4465e9d",
  "peer3": "5698b7c56e43cdbb33e617345d1722a9f87fbd2e900c3df7f6976272ea4e07eafaf23ffd09f380e6ccd1e78e9c5dbb740f033dc0eaa49b1c13302dca44dc8902f15a2f3071e5deb0643ae80ab6565bdcd22b31d75a50ff4fd167018a33e671b23378f4c31e00234d7e2330f0eda0b0e1ea988aa39704d1cf6eec60b04bb452e75c22ce236437648954025f8b8f6b62355de4b62725d825b234e85ed77286be26",
  "client3": "041d14f1536778f82f12d1e027f4b81657a6068804c03d2889d3342add2e8b70b9f9ca6282bd3e2713955446ae0abfe6dfef2c5514c8cbd03c82fc48eac3938c5e1c5ae4fb09c8eaab6468da634eca8f3e3e6d7f8e6046550cb8721908fe0d581dbe0e4cf1263ae1011021805a75d65fc34bcf5a7cc488e7666ea648fdf2b0b3dc2ee718007966e12f294578bc87d9fb000474ab8e48d85f6c63bb4c45df01e6",
  "key": "e09fe6498ea2d2f0c4f2b33f99253e82",
  "packby1": "7ccc36e133643a357a1ffba9a2a266246ed504697f4ba03e6b2f4e7b62b4bb88b47e39052e0c11f525f344d6b3b0924f3d33cc25775b8a55cdc6117a518cff262cc2267b156f5bfc4bbbb0f93bf1f9ce09e17d621398c2b36e0acd772e713a77b14e175ae07b943411918fcfed480066a47c06f4c25b01cb20b148c036819f4afed6f7aaf7dfcfbcf0965ae8e11900022e9298b6a546b14769cbfee1c77b9170",
  "packby2": "0b7d5bc678f018f2d0d86ef4b982813e7f501c0d142975efda08e539dbf8e04d0ab6fd611dbcfe1bafd46a2fb806640c75872a2186b747a6afb8bea721e381bf823e7be9be45757c219f6a9f0f5d2d9de01cd05d3d72c911d0bae22c48ef05717ad3fc962bc47915f983285c4b78174be1d63151725dec834c4cf0769b44f8367dffb961d2a174bf3f8148707e5dae974adffb3f41c3e378a8c44d8666168ef3",
  "aes": "13ab13f6975e3082"
};

test('G7 J-PAKE matches fixed OpenSSL-generated proofs and session key with a leading-zero PIN', () => {
  const exchange = createJpake('0123', { randomBytes: random(1, 2, 5, 6, 17) });
  assert.equal(hex(exchange.round1()), fixtures.client1);
  assert.equal(hex(exchange.round1()), fixtures.client1);
  exchange.acceptPeerRound(1, bytes(fixtures.peer1));
  assert.equal(hex(exchange.round2()), fixtures.client2);
  exchange.acceptPeerRound(2, bytes(fixtures.peer2));
  assert.equal(hex(exchange.round3()), fixtures.client3);
  exchange.acceptPeerRound(3, bytes(fixtures.peer3));
  assert.equal(hex(exchange.deriveKey()), 'e09fe6498ea2d2f0c4f2b33f99253e82');
  exchange.destroy(); assert.throws(() => exchange.deriveKey(), /ended/);
});

test('captured upstream sensor proofs validate with the ASCII server identity and strict proof equality', () => {
  const exchange = createJpake('0123', { randomBytes: random(1, 2) });
  assert.doesNotThrow(() => exchange.acceptPeerRound(1, bytes(fixtures.packby1)));
  assert.doesNotThrow(() => exchange.acceptPeerRound(2, bytes(fixtures.packby2)));
  exchange.destroy();
  const tampered = bytes(fixtures.packby1); tampered[159] ^= 1;
  const failed = createJpake('0123', { randomBytes: random(1, 2) });
  assert.throws(() => failed.acceptPeerRound(1, tampered), /proof verification failed/);
  assert.throws(() => failed.round1(), /ended/);
});

test('malformed proof lengths, off-curve points and out-of-range scalars terminate the exchange', () => {
  const valid = bytes(fixtures.peer1), invalidPoint = valid.slice(), invalidScalar = valid.slice();
  invalidPoint.fill(0, 0, 64); invalidScalar.fill(255, 128);
  for (const payload of [valid.slice(0, 159), new Uint8Array(161), invalidPoint, invalidScalar]) {
    const exchange = createJpake('0123', { randomBytes: random(1, 2) });
    assert.throws(() => exchange.acceptPeerRound(1, payload));
    assert.throws(() => exchange.deriveKey(), /ended/);
  }
  const exchange = createJpake('0123', { randomBytes: random(1, 2) });
  assert.throws(() => exchange.acceptPeerRound(2, valid), /out of order/);
  assert.throws(() => exchange.round1(), /ended/);
});

test('key derivation requires verified proofs and round-three proof nonces come from the random source', () => {
  const outputs = [];
  for (const nonce of [17, 19]) {
    const exchange = createJpake('0123', { randomBytes: random(1, 2, nonce) });
    assert.throws(() => exchange.deriveKey(), /three verified/);
    assert.throws(() => exchange.round3(), /both peer/);
    exchange.acceptPeerRound(1, bytes(fixtures.peer1)); exchange.acceptPeerRound(2, bytes(fixtures.peer2));
    const round = exchange.round3(); assert.equal(round.length, 160); outputs.push(round);
    const bad = bytes(fixtures.peer3); bad[159] ^= 1;
    assert.throws(() => exchange.acceptPeerRound(3, bad), /proof verification/);
    assert.throws(() => exchange.deriveKey(), /ended/);
  }
  assert.deepEqual(outputs[0].slice(0, 64), outputs[1].slice(0, 64));
  assert.notDeepEqual(outputs[0].slice(64), outputs[1].slice(64));
});

test('PINs retain all four ASCII digits and random scalar sampling rejects zero and the group order', () => {
  for (const pin of [123, '123', '12345', '12\u00003', '１２３４']) assert.throws(() => createJpake(pin), /four-digit/);
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const exchange = createJpake('0000', { randomBytes: random(0, order, 1, 2, 5) });
  assert.equal(hex(exchange.round1()), fixtures.client1);
  exchange.destroy();
  assert.throws(() => createJpake('0123', { randomBytes: () => new Uint8Array(32) }), /valid scalar/);
  assert.throws(() => createJpake('0123', { randomBytes: () => new Uint8Array(31) }), /32 bytes/);
});

test('proof coordinates retain leading zero bytes in the fixed 160-byte encoding', () => {
  const exchange = createJpake('0123', { randomBytes: random(43, 2, 5) });
  const proof = exchange.round1(); assert.equal(proof.length, 160);
  assert.equal(hex(proof.slice(0, 64)), '986ae2506f1ff104d04230861d8f4b498f4bc4c6d009b30f7544dc129b82d28d003cccc0a6460e0ae328a4d97d3c7b61d86fc6289c189f2525110c441bb07e97');
  assert.equal(proof[32], 0); exchange.destroy();
});

test('duplicated token AES matches known AES-128 and upstream input vectors without padding', () => {
  assert.equal(hex(aes8(new Uint8Array(16), new Uint8Array(8))), '66e94bd4ef8a2c3b');
  assert.equal(hex(aes8(bytes('6f8326744bef03faa520ad9c5cff673f'), bytes('2a404290c4b63b01'))), '13ab13f6975e3082');
  assert.throws(() => aes8(new Uint8Array(15), new Uint8Array(8)), /16 bytes/);
  assert.throws(() => aes8(new Uint8Array(16), new Uint8Array(9)), /8 bytes/);
});

test('certificate challenge signature verifies through OpenSSL against the bundled leaf certificate', () => {
  const chain = certificates(); assert.deepEqual(chain.map(cert => cert.length), [494, 465]);
  const packet = bytes('0c000cee691b765a497d225823d14f278dd3');
  const signature = signCertificateChallenge(packet); assert.equal(signature.length, 64);
  const publicKey = new X509Certificate(chain[1]).publicKey;
  assert.equal(verify('sha256', packet.slice(2), { key: createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), dsaEncoding: 'ieee-p1363' }, signature), true);
  const modified = packet.slice(); modified[2] ^= 1;
  assert.equal(verify('sha256', modified.slice(2), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), false);
  chain[0].fill(0); assert.equal(certificates()[0][0], 0x30);
  assert.throws(() => signCertificateChallenge(new Uint8Array(17)), /18 bytes/);
  assert.throws(() => signCertificateChallenge(new Uint8Array(18)), /header/);
});
