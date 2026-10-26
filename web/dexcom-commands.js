'use strict';

const NanoDexcomCommands = (() => {
  const p = () => typeof NanoDexcomProtocol !== 'undefined' ? NanoDexcomProtocol : require('./dexcom-protocol.js');
  function crc(input) {
    let value = 0;
    for (const byte of input) {
      value ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) value = (value << 1 ^ (value & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
    return Uint8Array.of(value & 255, value >>> 8);
  }
  function handles(state) {
    const protocol = p(), service = state.services?.find(item => item.uuid?.toLowerCase() === protocol.SERVICE);
    const result = {};
    for (const [name, uuid] of Object.entries({ control: protocol.CONTROL, auth: protocol.AUTH, extra: protocol.EXTRA, backfill: protocol.BACKFILL })) {
      const found = service?.characteristics?.filter(item => item.uuid?.toLowerCase() === uuid) || [];
      if (found.length !== 1 || !Number.isInteger(found[0].handle)) throw new Error(`Dexcom ${name} characteristic is missing or ambiguous.`);
      result[name] = found[0];
    }
    for (const name of ['control', 'auth']) if (!result[name].properties?.includes('write')) throw new Error(`Dexcom ${name} requires write-with-response.`);
    if (!result.auth.properties?.includes('indicate')) throw new Error('Dexcom authentication requires indications.');
    if (!result.extra.properties?.includes('write-no-response')) throw new Error('Dexcom extra data requires write-without-response.');
    for (const name of ['control', 'extra', 'backfill']) if (!result[name].properties?.includes('notify')) throw new Error(`Dexcom ${name} requires notifications.`);
    return result;
  }
  const current = () => Uint8Array.of(0x4e);
  const identity = () => Uint8Array.of(0x4a, ...crc([0x4a]));
  function history(clock, hours) {
    if (!Number.isInteger(clock) || clock < 1 || clock > 0xffffffff) throw new Error('Read current glucose before requesting history.');
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('Choose a history window above zero and at most 24 hours.');
    const end = clock, start = Math.max(1, end - Math.ceil(hours * 3600));
    if (start >= end) throw new Error('No earlier sensor time is available.');
    const bytes = new Uint8Array(9), data = new DataView(bytes.buffer);
    bytes[0] = 0x59; data.setUint32(1, start, true); data.setUint32(5, end, true);
    return { bytes, start, end };
  }
  function certificate(index, length) {
    if (![0, 1].includes(index) || !Number.isInteger(length) || length < 1 || length > 4096) throw new Error('Invalid Dexcom certificate request.');
    const result = new Uint8Array(6); result.set([0x0b, index]); new DataView(result.buffer).setUint32(2, length, true); return result;
  }
  function certificateSize(value, index) {
    if (value.length !== 7 || value[0] !== 0x0b || value[1] !== 0 || value[2] !== index) throw new Error('Invalid Dexcom certificate response.');
    const size = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint16(3, true);
    if (!size || size > 4096) throw new Error('Dexcom peer certificate length is outside the supported range.');
    return size;
  }
  return { crc, handles, current, identity, history, certificate, certificateSize };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcomCommands;
