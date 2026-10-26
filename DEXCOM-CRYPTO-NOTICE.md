# G7 cryptography sources

The J-PAKE arithmetic and proof checks in `scripts/dexcom-jpake.js` were implemented independently from protocol encodings and the equations in RFC 8235 and RFC 8236. P-256 operations, scalar-field operations, SHA-256, ECDSA and AES use the installed noble libraries. This notice does not change the license of unrelated project files.

## Attributed material

The certificate chain and public protocol signing material in `scripts/dexcom-material.js`, and the captured `packby1`/`packby2` proof fixtures in `tests/dexcom-crypto.test.mjs`, reproduce material from Juggluco commit `e41f4aa239d389bee78cdb8fc7d0dbe9ceb4df53`:

- Copyright (C) 2021 Jaap Korthals Altes <jaapkorthalsaltes@gmail.com>.
- GNU General Public License version 3 or, at your option, any later version.
- License text: `licenses/GPL-3.0-or-later.txt`.
- Source: <https://github.com/j-kaltes/Juggluco/tree/e41f4aa239d389bee78cdb8fc7d0dbe9ceb4df53>.
- Certificate chain: `Common/src/dex/java/tk/glucodata/DexGattCallback.java:945-951`.
- Signing scalar/public point and certificate challenge format: `Common/src/main/cpp/dexcom/ecJPake.cpp:610-659`.
- Captured proof fixtures: `Common/src/main/cpp/dexcom/ecJPake.cpp:686-701`.

The attributed files are distributed under GPL-3.0-or-later without a warranty of merchantability or fitness for a particular purpose. Their complete corresponding source is included in this repository. Bundle distributions must retain this notice, the license text and the corresponding source for the attributed material. The signing material is a shared protocol credential published by upstream, rather than a sensor's PIN, session key or patient credential.

## Protocol references and corrections

- <https://www.rfc-editor.org/rfc/rfc8235#section-3.3>: Schnorr proof verification over elliptic curves.
- <https://www.rfc-editor.org/rfc/rfc8236#section-3.2>: elliptic-curve J-PAKE rounds and shared secret.
- `ecJPake.cpp:306-353`: length-prefixed SEC1 uncompressed point encodings and party identity enter the SHA-256 proof challenge.
- `ecJPake.cpp:531-546`, `java.cpp:453-456`: shared-point x-coordinate hashing and first-16-byte session key.
- `ecJPake.cpp:670-681`: AES encrypts an eight-byte token repeated twice as one block, then retains its first eight bytes.
- `ecJPake.cpp:813`: the four applicator-code ASCII bytes form the big-endian password scalar. Leading zero characters are preserved.

The upstream proof verifier returns `EC_POINT_cmp(...) == 1`, which tests inequality, and its peer-party bytes are a nibble-swapped version of `server`. Both captured upstream sensor proofs satisfy the correct proof equation with ASCII `server`; both fail with the nibble-swapped identity. This implementation verifies equality, uses ASCII `client`/`server` and terminates the exchange on an invalid proof. It does not reproduce upstream's ignored verification result.

Coordinates, proof responses and the shared x-coordinate use fixed 32-byte big-endian encodings. This avoids upstream's variable-width `BN_bn2bin` alignment defects. Round-three proof nonces use fresh cryptographic randomness, replacing upstream's fixed nonce. These changes follow the protocol equations; sensor interoperability remains a separate hardware check.

## Fixture construction

The fixed `client1`, `client2`, `client3`, `peer1`, `peer2`, `peer3` and session-key fixtures were calculated with Node.js `node:crypto` backed by OpenSSL, without calling the implementation or noble point arithmetic. The fixture uses client exponents 1 and 2, peer exponents 3 and 4, ASCII PIN `0123`, client proof nonces 5, 6 and 17, and peer proof nonces 7, 11 and 13. Known base-point multiples let OpenSSL's P-256 ECDH public-key generation calculate every point. The expected shared point is `G * (32 * bigint(ASCII("0123")))`; SHA-256 of its fixed-width x-coordinate begins `e09fe6498ea2d2f0c4f2b33f99253e82`.

The AES fixture `13ab13f6975e3082` uses upstream's published test key/input and OpenSSL AES-128-ECB without padding. The all-zero AES fixture is the known AES-128 block result beginning `66e94bd4ef8a2c3b`. ECDSA challenge tests verify the raw 64-byte signature through OpenSSL against the bundled leaf certificate's public key.

Certificate bytes are retained as published, including their encoded validity dates. This implementation does not claim that an active sensor accepts that certificate chain. No live sensor operation formed part of the crypto implementation or fixture generation.
