'use strict';

const NanoRadiaCodeProtocol = (() => {
  const WRITE = 'e63215e6-7003-49d8-96b0-b024798fb901', NOTIFY = 'e63215e7-7003-49d8-96b0-b024798fb901';
  const commands = { exchange: [7, '01ff12ff'], version: [10, ''], status: [5, ''], serial: [0x826, '08000000'], measurements: [0x826, '00010000'] };
  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value !== 'string' || value.length % 2 || !/^[\da-f]*$/i.test(value)) throw new Error('Invalid hexadecimal RadiaCode bytes.');
    return Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));
  }
  const hex = value => Array.from(bytes(value), byte => byte.toString(16).padStart(2, '0')).join('');
  const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength);
  function request(kind, sequence) {
    if (!Object.hasOwn(commands, kind)) throw new Error('Unsupported RadiaCode read command.');
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 31) throw new Error('RadiaCode sequence must be 0..31.');
    const [command, raw] = commands[kind], args = bytes(raw), result = new Uint8Array(8 + args.length), data = view(result);
    data.setUint32(0, result.length - 4, true); data.setUint16(4, command, true); result[7] = 0x80 + sequence; result.set(args, 8); return result;
  }
  class Assembler {
    constructor() { this.data = new Uint8Array(); }
    append(value) {
      value = bytes(value);
      if (!value.length || this.data.length + value.length > 65540) throw new Error('RadiaCode response fragment exceeds its size limit.');
      const joined = new Uint8Array(this.data.length + value.length); joined.set(this.data); joined.set(value, this.data.length); this.data = joined;
      const frames = [];
      while (this.data.length >= 4) {
        const length = view(this.data).getUint32(0, true);
        if (length < 4 || length > 65536) throw new Error('RadiaCode response length is invalid.');
        if (this.data.length < length + 4) break;
        frames.push(this.data.slice(4, length + 4)); this.data = this.data.slice(length + 4);
      }
      return frames;
    }
  }
  function response(frame, requestFrame) {
    frame = bytes(frame); requestFrame = bytes(requestFrame);
    if (frame.length < 4 || requestFrame.length < 8 || !frame.subarray(0, 4).every((byte, index) => byte === requestFrame[index + 4])) throw new Error('RadiaCode response command or sequence does not match the request.');
    return frame.slice(4);
  }
  function ascii(value) {
    if (value.some(byte => byte > 127)) throw new Error('RadiaCode response contains invalid ASCII.');
    return String.fromCharCode(...value).replace(/\0+$/, '');
  }
  function version(value) {
    value = bytes(value); const data = view(value); let offset = 0;
    const part = () => {
      if (offset + 5 > value.length) throw new Error('RadiaCode firmware response is truncated.');
      const minor = data.getUint16(offset, true), major = data.getUint16(offset + 2, true), length = value[offset + 4]; offset += 5;
      if (offset + length > value.length) throw new Error('RadiaCode firmware date is truncated.');
      const date = ascii(value.slice(offset, offset + length)); offset += length; return { major, minor, date };
    };
    const result = { boot: part(), firmware: part() };
    if (offset !== value.length) throw new Error('RadiaCode firmware response has trailing bytes.');
    return result;
  }
  function virtualString(value) {
    value = bytes(value);
    if (value.length < 8) throw new Error('RadiaCode virtual-string response is truncated.');
    const data = view(value), result = data.getUint32(0, true), length = data.getUint32(4, true);
    if (result !== 1) throw new Error(`RadiaCode rejected the read (result ${result}).`);
    if (value.length === length + 9 && value[value.length - 1] === 0) value = value.slice(0, -1);
    if (value.length !== length + 8) throw new Error('RadiaCode virtual-string length does not match the response.');
    return value.slice(8);
  }
  function status(value) { value = bytes(value); if (value.length !== 4) throw new Error('RadiaCode status response must contain four bytes.'); return view(value).getUint32(0, true); }
  function measurements(value) {
    value = bytes(value); const data = view(value), records = []; let offset = 0, nextSequence;
    const need = size => { if (offset + size > value.length) throw new Error('RadiaCode measurement record is truncated.'); };
    const float = at => { const number = data.getFloat32(at, true); if (!Number.isFinite(number)) throw new Error('RadiaCode measurement contains an invalid numeric value.'); return number; };
    const sizes = [15, 8, 16, 14, 16, 16, 6, 4, 6, 6];
    while (offset < value.length) {
      need(7); const sequence = value[offset], event = value[offset + 1], group = value[offset + 2], timestampOffsetMs = data.getInt32(offset + 3, true) * 10; offset += 7;
      if (nextSequence !== undefined && sequence !== nextSequence) throw new Error('RadiaCode measurement records contain a sequence gap.');
      nextSequence = (sequence + 1) & 255;
      if (event === 1 && [1, 2, 3].includes(group)) { need(6); const length = 6 + data.getUint16(offset, true) * ({ 1: 8, 2: 16, 3: 14 })[group]; need(length); offset += length; continue; }
      if (event !== 0 || sizes[group] === undefined) throw new Error(`Unsupported RadiaCode measurement record ${event}/${group}.`);
      need(sizes[group]); const record = { sequence, timestampOffsetMs };
      if (group === 0) Object.assign(record, { type: 'live', countRate: float(offset), doseRate: float(offset + 4), countErrorPercent: data.getUint16(offset + 8, true) / 10, doseErrorPercent: data.getUint16(offset + 10, true) / 10, flags: data.getUint16(offset + 12, true), liveFlags: value[offset + 14] });
      if (group === 1) Object.assign(record, { type: 'raw', countRate: float(offset), doseRate: float(offset + 4) });
      if (group === 2) Object.assign(record, { type: 'history', count: data.getUint32(offset, true), countRate: float(offset + 4), doseRate: float(offset + 8), doseErrorPercent: data.getUint16(offset + 12, true) / 10, flags: data.getUint16(offset + 14, true) });
      if (group === 3) Object.assign(record, { type: 'device', durationSeconds: data.getUint32(offset, true), dose: float(offset + 4), temperatureC: (data.getUint16(offset + 8, true) - 2000) / 100, batteryPercent: data.getUint16(offset + 10, true) / 100, flags: data.getUint16(offset + 12, true) });
      if (group === 7) Object.assign(record, { type: 'event', event: value[offset], parameter: value[offset + 1], flags: data.getUint16(offset + 2, true) });
      if (group === 8 || group === 9) Object.assign(record, { type: group === 8 ? 'count' : 'dose', [group === 8 ? 'countRate' : 'doseRate']: float(offset), flags: data.getUint16(offset + 4, true) });
      if (record.type) records.push(record); offset += sizes[group];
    }
    return records;
  }
  function handles(state) {
    for (const service of state.services || []) {
      const write = service.characteristics?.find(item => item.uuid?.toLowerCase() === WRITE), notify = service.characteristics?.find(item => item.uuid?.toLowerCase() === NOTIFY);
      if (write && notify) return { write, notify };
    }
    return null;
  }
  return { WRITE, NOTIFY, bytes, hex, request, Assembler, response, version, virtualString, status, measurements, ascii, handles };
})();
if (typeof module !== 'undefined') module.exports = NanoRadiaCodeProtocol;
