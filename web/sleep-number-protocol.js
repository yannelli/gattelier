'use strict';

const NanoSleepProtocol = (() => {
  const SERVICE = '09d23fae-90e6-44c2-95b6-0b3d0f1abf25';
  const MCR = 'ffffd1fd-388d-938b-344a-939d1f6efee0';
  const AUTH = '8d4675a5-b5fa-42b2-b587-0ee71c46b709';
  const BAMKEY = '421e00f3-ae76-4c49-ab6e-39e4df4a5333';
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const preamble = encoder.encode('fUzIoN');
  const requests = Object.freeze({ capabilities: 'SYCG ', left: 'SNCG left', right: 'SNCG right', privacy: 'SPRG ' });
  const labels = ['Chambers', 'Pressure control', 'Articulation', 'Underbed light', 'Rapid setting', 'Thermal control', 'Right head actuator', 'Right foot actuator', 'Left head actuator', 'Left foot actuator', 'Flat preset', 'Favorite preset', 'Snore preset', 'Zero gravity preset', 'Watch TV preset', 'Read preset'];
  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value !== 'string' || value.length % 2 || !/^[\da-f]*$/i.test(value)) throw new Error('Invalid hexadecimal bytes.');
    return Uint8Array.from(value.match(/../g) || [], value => parseInt(value, 16));
  }
  const hex = value => Array.from(bytes(value), value => value.toString(16).padStart(2, '0')).join('');
  const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength);
  function crc32(value) {
    let crc = 0xffffffff;
    for (const byte of value) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function request(kind) {
    if (!Object.hasOwn(requests, kind)) throw new Error('Only read-only Sleep Number metadata queries are supported.');
    const payload = encoder.encode(requests[kind]), frame = new Uint8Array(payload.length + 14);
    frame.set(preamble); view(frame).setUint32(6, frame.length, true); frame.set(payload, 10);
    view(frame).setUint32(frame.length - 4, crc32(frame.subarray(0, -4)), true);
    return frame;
  }
  function session(value) {
    value = bytes(value);
    if (value.length !== 16) throw new Error('Sleep Number Auth must return a 16-byte session UUID. Reconnect to discover fresh characteristics.');
    if (value.subarray(0, 15).every(byte => byte === 0) && value[15] < 2) {
      throw new Error(value[15] ? 'Sleep Number rejected this session. Check the connection security state.' : 'Sleep Number refused a session: connection limit reached.');
    }
    return value.slice();
  }
  function hint(value, identifier) {
    value = bytes(value);
    return value.length === 16 && (value.every(byte => byte === 0) || value.every((byte, index) => byte === identifier[index]));
  }
  function frameLength(value) {
    if (value.length < 10) return null;
    if (!preamble.every((byte, index) => value[index] === byte)) throw new Error('Sleep Number response has an invalid Fuzion header.');
    const total = view(value).getUint32(6, true);
    if (total < 14 || total > 8192 || value.length > total) throw new Error('Sleep Number response has an invalid length.');
    return total;
  }
  function decodeFrame(value) {
    value = bytes(value);
    if (frameLength(value) !== value.length) throw new Error('Sleep Number response is incomplete.');
    if (view(value).getUint32(value.length - 4, true) !== crc32(value.subarray(0, -4))) throw new Error('Sleep Number response failed CRC verification.');
    const text = decoder.decode(value.subarray(10, -4)).trim();
    if (!text) throw new Error('Sleep Number response is empty.');
    return text;
  }
  class Assembler {
    constructor() { this.data = new Uint8Array(); }
    append(chunk) {
      chunk = bytes(chunk);
      if (!chunk.length || this.data.length + chunk.length > 8192) throw new Error('Invalid Sleep Number response fragment.');
      const joined = new Uint8Array(this.data.length + chunk.length); joined.set(this.data); joined.set(chunk, this.data.length); this.data = joined;
      const size = frameLength(joined);
      return size === joined.length ? decodeFrame(joined) : null;
    }
  }
  function response(kind, raw) {
    if (!Object.hasOwn(requests, kind)) throw new Error('Unsupported metadata query.');
    let text = String(raw).trim();
    const failure = /^FAIL:([012])(?:\s|$)/.exec(text);
    if (failure) throw new Error(['This metadata command is unsupported by the bed.', 'The bed timed out while reading metadata.', 'The bed returned a protocol error.'][Number(failure[1])]);
    if (!text.startsWith('PASS:')) throw new Error('Sleep Number returned an unknown response.');
    text = text.slice(5); if (/^ACK(?:\s|$)/.test(text)) text = text.slice(3);
    const parts = text.trim().split(/\s+/);
    if (kind === 'capabilities') {
      if (parts.length !== 16 || !['single', 'dual'].includes(parts[0]) || !['none', 'heat_cool', 'cool'].includes(parts[5]) || parts.some((part, index) => index !== 0 && index !== 5 && !['yes', 'no'].includes(part))) throw new Error('Invalid Sleep Number capability fields.');
      return parts.map((value, index) => ({ label: labels[index], value }));
    }
    if (kind === 'privacy') {
      if (parts.length !== 1 || !['unknown', 'active', 'paused'].includes(parts[0])) throw new Error('Invalid SleepIQ privacy-state field.');
      return [{ label: 'SleepIQ data state', value: parts[0] }];
    }
    if (parts.length !== 3 || !['0', '1'].includes(parts[0]) || parts.slice(1).some(part => !/^-?\d+$/.test(part) || !Number.isSafeInteger(Number(part)))) throw new Error('Invalid Sleep Number firmness fields.');
    return [{ label: 'Side', value: kind }, { label: 'Adjustment status code', value: parts[0] }, { label: 'Ambient firmness setting', value: parts[1] }, { label: 'User firmness setting', value: parts[2] }];
  }
  function handles(state) {
    const services = state.services || [], service = services.find(item => item.uuid.toLowerCase() === SERVICE);
    const result = { variant: service ? 'Fuzion' : services.some(item => item.uuid.toLowerCase() === MCR) ? 'MCR' : null };
    for (const characteristic of service?.characteristics || []) {
      if (characteristic.uuid.toLowerCase() === AUTH) result.auth = characteristic;
      if (characteristic.uuid.toLowerCase() === BAMKEY) result.bamkey = characteristic;
    }
    return result;
  }
  return { SERVICE, MCR, AUTH, BAMKEY, bytes, hex, crc32, request, session, hint, frameLength, decodeFrame, Assembler, response, handles };
})();
if (typeof module !== 'undefined') module.exports = NanoSleepProtocol;
