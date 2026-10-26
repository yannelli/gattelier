'use strict';
const NanoPlaudProtocol = (() => {
  const encoder = new TextEncoder();
  const marker = encoder.encode('PLAUD.AI');
  const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint = (value, max = 0xffffffff) => {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error('Invalid unsigned integer');
    return value;
  };
  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (!Array.isArray(value) || !value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Invalid packet bytes');
    return Uint8Array.from(value);
  }
  function join(...parts) {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  function u32(value) {
    const result = new Uint8Array(4); view(result).setUint32(0, uint(value), true); return result;
  }
  function token(userId) {
    if (typeof userId !== 'string' || !/^[\x20-\x7e]{1,32}$/.test(userId)) throw new Error('User ID must contain 1 to 32 ASCII characters');
    return userId;
  }
  function pem(value, kind) {
    if (typeof value !== 'string') throw new Error(`Missing ${kind.toLowerCase()} key PEM`);
    const match = value.trim().match(/^-----BEGIN (RSA )?(PUBLIC|PRIVATE) KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END (RSA )?(PUBLIC|PRIVATE) KEY-----$/);
    if (!match || match[2] !== kind || match[1] !== match[4] || match[2] !== match[5]) throw new Error(`Invalid ${kind.toLowerCase()} key PEM`);
    return value;
  }
  function credentials(value) {
    if (!value || typeof value.serial !== 'string' || !/^[0-9a-f]{16}$/i.test(value.serial)) throw new Error('Serial must contain 16 hexadecimal characters');
    const userId = token(value.userId), privateKeyPem = pem(value.privateKeyPem, 'PRIVATE'), publicKeyPem = pem(value.publicKeyPem, 'PUBLIC');
    if (typeof value.signature !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.signature)) throw new Error('Invalid signature base64');
    const signature = Uint8Array.from(atob(value.signature), character => character.charCodeAt(0));
    if (signature.length !== 256) throw new Error('Protocol 20 requires a 256-byte signature');
    return { serial: value.serial.toLowerCase(), userId, privateKeyPem, publicKeyPem, signature };
  }
  function handles(state) {
    const short = uuid => String(uuid).toLowerCase().replace(/^0x/, '').replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
    const service = state.services?.find(item => short(item.uuid) === '1910');
    const find = uuid => service?.characteristics?.find(item => short(item.uuid) === uuid)?.handle;
    return { command: find('2bb1'), response: find('2bb0') };
  }
  function chunks(opcode, payload, max = 100) {
    if (opcode !== 0xfe10 && opcode !== 0xfe12) throw new Error('Unsupported pre-handshake opcode');
    uint(max, 100); if (!max) throw new Error('Chunk size must be positive');
    payload = bytes(payload);
    const total = Math.ceil(payload.length / max);
    if (total < 1 || total > 255) throw new Error('Invalid chunk count');
    return Array.from({ length: total }, (_, index) => join(Uint8Array.of(opcode & 255, opcode >> 8, total, index), payload.slice(index * max, (index + 1) * max)));
  }
  class Assembler {
    constructor() { this.total = null; this.parts = new Map(); }
    add(packet) {
      packet = bytes(packet);
      if (packet.length < 5 || packet.length > 104 || view(packet).getUint16(0, true) !== 0xfe12) throw new Error('Invalid FE12 chunk');
      const total = packet[2], index = packet[3], part = packet.slice(4);
      if (!total || total > 3 || index >= total || (this.total !== null && this.total !== total)) throw new Error('Invalid FE12 chunk count or index');
      if (this.parts.has(index) && !equal(this.parts.get(index), part)) throw new Error('Conflicting FE12 duplicate chunk');
      this.total = total; this.parts.set(index, part);
      if (this.parts.size !== total) return null;
      const result = join(...Array.from({ length: total }, (_, i) => this.parts.get(i)));
      if (result.length !== 256) throw new Error('Protocol 20 requires a 256-byte wrapped secret');
      return result;
    }
  }
  class Session {
    constructor(privateKeyPem, wrapped) {
      wrapped = bytes(wrapped);
      if (wrapped.length !== 256) throw new Error('Protocol 20 requires a 256-byte wrapped secret');
      const secret = bytes(globalThis.NanoPlaudCrypto.decryptRSA(privateKeyPem, wrapped));
      if (secret.length < 72) throw new Error('Invalid protocol 20 session secret');
      this.key = secret.slice(0, 32); this.nonce = secret.slice(32, 44); this.aad = secret.slice(44, 56);
      const verification = globalThis.NanoPlaudCrypto.decryptChaCha(this.key, this.nonce, this.aad, secret.slice(56));
      if (!equal(bytes(verification), marker)) throw new Error('Invalid protocol 20 verification marker');
      this.txSeq = 1; this.rxSeq = -1;
    }
    seal(payload) {
      payload = bytes(payload);
      if (this.txSeq === 0xffffffff) throw new Error('Session sequence exhausted');
      return bytes(globalThis.NanoPlaudCrypto.encryptChaCha(this.key, this.nonce, this.aad, join(u32(++this.txSeq), payload)));
    }
    open(cipher) {
      cipher = bytes(cipher);
      if (cipher.length < 20) throw new Error('Invalid encrypted session packet');
      const plain = bytes(globalThis.NanoPlaudCrypto.decryptChaCha(this.key, this.nonce, this.aad, cipher));
      if (plain.length < 4) throw new Error('Invalid session packet');
      const sequence = view(plain).getUint32(0, true);
      if (sequence <= this.rxSeq) return null;
      this.rxSeq = sequence; return plain.slice(4);
    }
  }
  function command(code, params = []) {
    uint(code, 0xffff); return join(Uint8Array.of(1, code & 255, code >> 8), bytes(params));
  }
  function handshake(userId, second = false) {
    return command(1, join(Uint8Array.of(2, 0, second ? 1 : 0), encoder.encode(token(userId).padEnd(32, '0'))));
  }
  function listRequest(start = 0) {
    return command(26, join(u32(Math.floor(Date.now() / 1000)), u32(start), Uint8Array.of(0)));
  }
  function parseList(packet) {
    packet = bytes(packet);
    if (packet.length < 11 || packet[0] !== 1 || view(packet).getUint16(1, true) !== 26 || (packet.length - 11) % 10) throw new Error('Invalid recording list packet');
    const data = view(packet), requestId = data.getUint32(3, true), total = data.getUint16(7, true), index = data.getUint16(9, true);
    const count = (packet.length - 11) / 10;
    if (index + count > total) throw new Error('Recording list exceeds announced count');
    const entries = Array.from({ length: count }, (_, i) => {
      const offset = 11 + i * 10;
      return { id: data.getUint32(offset, true), size: data.getUint32(offset + 4, true), attributes: [packet[offset + 8], packet[offset + 9]] };
    });
    return { requestId, total, index, entries };
  }
  function downloadRequest(id, start, end) {
    uint(id); uint(start); uint(end);
    if (end < start) throw new Error('Download end precedes start');
    return command(28, join(u32(id), u32(start), u32(end)));
  }
  function parseData(packet) {
    packet = bytes(packet);
    if (packet.length < 10 || packet[0] !== 2) throw new Error('Invalid recording data packet');
    const data = view(packet), id = data.getUint32(1, true), offset = data.getUint32(5, true);
    if (offset === 0xffffffff) {
      if (packet.length !== 10) throw new Error('Invalid recording end packet');
      return { id, offset, end: true, code: packet[9], data: new Uint8Array() };
    }
    if (packet.length !== 10 + packet[9]) throw new Error('Recording data length mismatch');
    return { id, offset, end: false, data: packet.slice(10) };
  }
  const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ ((value & 0x80000000) ? 0x04c11db7 : 0);
    return value >>> 0;
  });
  function validateOgg(data) {
    let offset = 0, eos = false;
    while (offset < data.length) {
      if (data.length - offset < 27 || !equal(data.subarray(offset, offset + 4), Uint8Array.of(79, 103, 103, 83)) || data[offset + 4] !== 0) throw new Error('Invalid Ogg page header');
      const headerLength = 27 + data[offset + 26];
      if (offset + headerLength > data.length) throw new Error('Truncated Ogg segment table');
      let length = headerLength;
      for (let i = offset + 27; i < offset + headerLength; i++) length += data[i];
      if (offset + length > data.length) throw new Error('Truncated Ogg page body');
      let crc = 0;
      for (let i = 0; i < length; i++) {
        const byte = i >= 22 && i < 26 ? 0 : data[offset + i];
        crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255]) >>> 0;
      }
      if (crc !== view(data).getUint32(offset + 22, true)) throw new Error('Ogg page CRC mismatch');
      eos = Boolean(data[offset + 5] & 4); offset += length;
    }
    if (!offset || !eos) throw new Error('Ogg recording is missing its end page');
  }
  function decryptRecording(input, privateKeyPem) {
    const file = bytes(input);
    if (file.length < 512 || !equal(file.subarray(0, 8), marker)) throw new Error('Unsupported PLAUD recording file');
    const data = view(file), version = data.getUint16(8, true), headerSize = data.getUint16(10, true);
    if (version !== 1) throw new Error('Unsupported PLAUD recording version');
    if (headerSize < 512 || headerSize > file.length) throw new Error('Invalid PLAUD recording header size');
    const secret = bytes(globalThis.NanoPlaudCrypto.decryptRSA(privateKeyPem, file.slice(256, 512)));
    if (secret.length < 32) throw new Error('Invalid PLAUD recording content key');
    const plain = bytes(globalThis.NanoPlaudCrypto.chacha20(secret.slice(-32), file.slice(132, 144), file.slice(headerSize), data.getUint32(128, true)));
    validateOgg(plain); return plain;
  }
  return { credentials, handles, chunks, Assembler, Session, command, handshake, listRequest, parseList, downloadRequest, parseData, decryptRecording };
})();
if (typeof module !== 'undefined') module.exports = NanoPlaudProtocol;
