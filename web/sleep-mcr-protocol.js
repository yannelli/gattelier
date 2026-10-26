'use strict';

const NanoSleepMcrProtocol = (() => {
  const SERVICE = 'ffffd1fd-388d-938b-344a-939d1f6efee0', NOTIFY = 'ffffd1fd-388d-938b-344a-939d1f6efee1', WRITE = 'ffffd1fd-388d-938b-344a-939d1f6efee2';
  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value !== 'string' || value.length % 2 || !/^[\da-f]*$/i.test(value)) throw new Error('Invalid hexadecimal MCR bytes.');
    return Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));
  }
  const hex = value => Array.from(bytes(value), byte => byte.toString(16).padStart(2, '0')).join('');
  const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength);
  function checksum(value) { let sum = 0, result = 0; for (const byte of value) { sum += byte; result += sum; } return result & 65535; }
  function identity(storage, address, random = globalThis.crypto) {
    if (!/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(address || '')) throw new Error('Select a bed with a valid Bluetooth address.');
    const key = `nanoscope.mcr.clientId.${address.toLowerCase()}`; let value;
    try {
      value = storage.getItem(key);
      if (/^[\da-f]{16}$/i.test(value || '') && !/^0{16}$/.test(value)) return value.toLowerCase();
      const generated = new Uint8Array(8); random.getRandomValues(generated); if (generated.every(byte => byte === 0)) generated[7] = 1;
      value = hex(generated); storage.setItem(key, value);
      if (storage.getItem(key) !== value) throw new Error();
    } catch { throw new Error('Browser storage is required to retain this bed\'s MCR client identity.'); }
    return value;
  }
  function request(kind, session = {}, identifier = '') {
    if (!['bind', 'firmness'].includes(kind)) throw new Error('Unsupported MCR read command.');
    const payload = kind === 'bind' ? bytes(identifier) : new Uint8Array();
    if (kind === 'bind' && (payload.length !== 8 || payload.every(byte => byte === 0))) throw new Error('MCR binding requires a nonzero eight-byte client identity.');
    const client = kind === 'bind' ? 0 : session.client, bed = kind === 'bind' ? 0 : session.bed;
    if (![client, bed].every(value => Number.isInteger(value) && value >= 0 && value <= 65535)) throw new Error('MCR session addresses are unavailable.');
    const result = new Uint8Array(14 + payload.length), data = view(result);
    result.set([0x16, 0x16, 2]); data.setUint16(3, client); data.setUint16(5, bed); result[7] = 2; data.setUint16(8, client);
    result[10] = kind === 'bind' ? 0 : 18; result[11] = payload.length; result.set(payload, 12); data.setUint16(result.length - 2, checksum(result.subarray(2, -2))); return result;
  }
  function decode(value) {
    value = bytes(value);
    if (value.length < 14 || value[0] !== 0x16 || value[1] !== 0x16) throw new Error('MCR response header is invalid.');
    if (value.length !== 14 + (value[11] & 15)) throw new Error('MCR response length is invalid.');
    const data = view(value);
    if (data.getUint16(value.length - 2) !== checksum(value.subarray(2, -2))) throw new Error('MCR response checksum failed.');
    return { type: value[2], target: data.getUint16(3), subAddress: data.getUint16(5), status: value[7], echo: data.getUint16(8), function: value[10] & 127, response: Boolean(value[10] & 128), side: value[11] >> 4, payload: value.slice(12, -2) };
  }
  class Assembler {
    constructor() { this.data = new Uint8Array(); }
    append(value) {
      value = bytes(value);
      if (!value.length || this.data.length + value.length > 4096) throw new Error('Invalid MCR response fragment.');
      const joined = new Uint8Array(this.data.length + value.length); joined.set(this.data); joined.set(value, this.data.length); this.data = joined; const frames = [];
      while (this.data.length >= 2) {
        if (this.data[0] !== 0x16 || this.data[1] !== 0x16) throw new Error('MCR response lost frame alignment.');
        if (this.data.length < 12) break;
        const length = 14 + (this.data[11] & 15); if (this.data.length < length) break;
        frames.push(decode(this.data.slice(0, length))); this.data = this.data.slice(length);
      }
      return frames;
    }
  }
  function matches(frame, kind, session = {}) {
    if ((frame.type & 0xf0) !== 0 || frame.function !== (kind === 'bind' ? 0 : 18)) return false;
    if (kind === 'bind') return frame.payload.length >= 10;
    return frame.response && frame.subAddress === session.client && (session.client === 0 || frame.echo === session.bed);
  }
  function bind(frame) {
    if (!matches(frame, 'bind')) throw new Error('MCR bind response omitted assigned addresses.');
    return { client: view(frame.payload).getUint16(8), bed: frame.target };
  }
  function firmness(frame) {
    if (frame.function !== 18 || frame.payload.length < 3 || ![0, 1].includes(frame.side)) throw new Error('MCR firmness response has an unsupported chamber layout.');
    return { adjusting: frame.payload[0] !== 0, dualChamber: frame.side === 1, left: frame.payload[1], right: frame.payload[2] };
  }
  function handles(state) {
    const service = state.services?.find(item => item.uuid?.toLowerCase() === SERVICE);
    const write = service?.characteristics?.find(item => item.uuid?.toLowerCase() === WRITE), notify = service?.characteristics?.find(item => item.uuid?.toLowerCase() === NOTIFY);
    return write && notify ? { write, notify } : null;
  }
  return { SERVICE, WRITE, NOTIFY, bytes, hex, checksum, identity, request, decode, Assembler, matches, bind, firmness, handles };
})();
if (typeof module !== 'undefined') module.exports = NanoSleepMcrProtocol;
