'use strict';

const NanoBTHomeCrypto = (() => {
  const sources = [
    { title: 'BTHome encryption', url: 'https://bthome.io/encryption/' },
    { title: 'BTHome reference encryption example', url: 'https://github.com/Bluetooth-Devices/bthome-ble/blob/18e1c664c8595ac5f7e2daa63e9a90516ccd3800/src/bthome_ble/bthome_v2_encryption.py' },
    { title: 'NIST CCM specification', url: 'https://doi.org/10.6028/NIST.SP.800-38C' },
  ];
  function bytes(value, length, name) {
    const result = typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value)
      ? Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16))
      : value instanceof Uint8Array ? value.slice() : null;
    if (!result || (length !== undefined && result.length !== length)) throw new Error(`Invalid ${name}.`);
    return result;
  }
  const hex = data => Array.from(data, value => value.toString(16).padStart(2, '0')).join('');
  async function decrypt({ hex: frameHex, mac, key } = {}) {
    const data = bytes(frameHex, undefined, 'BTHome frame');
    if (data.length < 11 || data.length > 65544 || (data[0] & 0xfb) !== 0x41) throw new Error('Invalid encrypted BTHome v2 frame.');
    if (typeof mac !== 'string' || !/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2})$/i.test(mac)) throw new Error('A six-byte sensor MAC address is required.');
    const secret = bytes(key, 16, 'BTHome key (expected 32 hexadecimal characters)');
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) { secret.fill(0); throw new Error('BTHome decryption requires browser cryptography on HTTPS or localhost.'); }
    let plaintext;
    try {
      const nonce = new Uint8Array(13);
      nonce.set(bytes(mac.replaceAll(':', ''), 6, 'sensor MAC'));
      nonce.set([0xd2, 0xfc, data[0]], 6);
      nonce.set(data.subarray(-8, -4), 9);
      const [ctrKey, cbcKey] = await Promise.all([
        subtle.importKey('raw', secret, 'AES-CTR', false, ['decrypt']),
        subtle.importKey('raw', secret, 'AES-CBC', false, ['encrypt']),
      ]);
      const counter = new Uint8Array(16);
      counter[0] = 1; counter.set(nonce, 1); counter[15] = 1;
      plaintext = new Uint8Array(await subtle.decrypt({ name: 'AES-CTR', counter, length: 16 }, ctrKey, data.subarray(1, -8)));
      const blocks = new Uint8Array(16 + Math.ceil(plaintext.length / 16) * 16);
      blocks[0] = 9; blocks.set(nonce, 1);
      blocks[14] = plaintext.length >> 8; blocks[15] = plaintext.length & 255;
      blocks.set(plaintext, 16); counter[15] = 0;
      const [macBlocks, mask] = await Promise.all([
        subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, cbcKey, blocks),
        subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, cbcKey, counter),
      ]);
      // WebCrypto appends CBC padding; the preceding block is the CCM CBC-MAC.
      const tag = new Uint8Array(macBlocks).subarray(blocks.length - 16, blocks.length), pad = new Uint8Array(mask);
      let difference = 0;
      for (let index = 0; index < 4; index++) difference |= (tag[index] ^ pad[index]) ^ data[data.length - 4 + index];
      if (difference) throw new Error('BTHome authentication failed: key, MAC address, or payload does not match.');
      const count = new DataView(data.buffer, data.byteOffset + data.length - 8, 4).getUint32(0, true);
      return { hex: hex(Uint8Array.of(data[0] & 0xfe)) + hex(plaintext), counter: count };
    } finally {
      secret.fill(0); plaintext?.fill(0);
    }
  }
  return { decrypt, sources };
})();
if (typeof module !== 'undefined') module.exports = NanoBTHomeCrypto;
