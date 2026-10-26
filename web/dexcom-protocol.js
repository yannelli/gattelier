'use strict';

const NanoDexcomProtocol = (() => {
  const suffix = '-849e-531c-c594-30f1f86a4ea5';
  const SERVICE = `f8083532${suffix}`, CONTROL = `f8083534${suffix}`, BACKFILL = `f8083536${suffix}`;
  const SOURCE = 'https://github.com/NightscoutFoundation/xDrip/tree/c42cf55c6b972215654bc2a34ce563c87a7aa594/app/src/main/java/com/eveningoutpost/dexdrip';
  const labels = ['Unknown', 'Stopped', 'Warming up', 'Excess noise', 'Needs initial calibration', 'Needs second calibration', 'OK', 'Needs calibration', 'Confused calibration 1', 'Confused calibration 2', 'Needs more calibration', 'Sensor failed', 'Sensor failed 2', 'Unusual calibration', 'Insufficient calibration', 'Ended', 'Sensor failed 3', 'Transmitter problem', 'Sensor errors', 'Sensor failed 4', 'Sensor failed 5', 'Sensor failed 6', 'Sensor failed start', 'Sensor failed start 2', 'Sensor expired', 'Sensor failed 7', 'Sensor stopped 2', 'Sensor failed 8', 'Sensor failed 9', 'Sensor failed 10', 'Sensor failed 11'];
  const states = new Map(labels.map((label, index) => [index, label]));
  states.set(0xc1, 'Sensor started'); states.set(0xc2, 'Sensor stopped'); states.set(0xc3, 'Calibration sent');
  const stateLabel = code => states.get(code) || `Unknown state 0x${code.toString(16).padStart(2, '0')}`;
  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value !== 'string') throw new Error('Enter a HEX packet.');
    const text = value.replace(/\s/g, '').replace(/^0x/i, '');
    if (!text.length || text.length % 2 || /[^0-9a-f]/i.test(text)) throw new Error('Enter complete hexadecimal byte pairs.');
    return Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
  }
  const hex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
  function reading(view, offset, history = false) {
    const packed = view.getUint16(offset, true), state = view.getUint8(offset + 2), trendRaw = view.getInt8(offset + (history ? 4 : 3));
    const glucoseRaw = packed & 0x0fff, displayOnly = Boolean(packed & 0xf000);
    return { glucoseRaw, glucoseMgDl: (state === 6 || state === 7) && glucoseRaw > 13 && !displayOnly ? glucoseRaw : null,
      displayOnly, state, stateLabel: stateLabel(state), trendRaw, trendMgDlMinute: trendRaw === 127 ? null : trendRaw / 10 };
  }
  function decode(uuid, value, options = {}) {
    const data = bytes(value), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const receivedAt = Number.isFinite(options.receivedAt) ? options.receivedAt : null;
    if (data.length > 512) throw new Error('A Dexcom packet exceeds 512 bytes.');
    uuid = String(uuid).toLowerCase();
    if (uuid === BACKFILL) {
      if (!data.length || data.length % 9) throw new Error('G7 backfill requires complete 9-byte records.');
      return { kind: 'history', records: Array.from({ length: data.length / 9 }, (_, index) => {
        const offset = index * 9;
        return { ...reading(view, offset + 4, true), clock: view.getUint32(offset, true), extra: view.getUint8(offset + 7), source: 'backfill' };
      }) };
    }
    if (uuid !== CONTROL) throw new Error('Choose the documented G7 control or backfill characteristic.');
    if (data[0] === 0x4e) {
      if (data.length < 19) throw new Error('G7 glucose response is truncated; 19 bytes are required.');
      const clock = view.getUint32(2, true), ageSeconds = view.getUint16(10, true);
      if (ageSeconds > clock) throw new Error('G7 reading age exceeds its sensor clock.');
      return { kind: 'glucose', ...reading(view, 12), statusRaw: data[1], clock, ageSeconds, sequence: view.getUint16(6, true),
        predictedRaw: view.getUint16(16, true) & 0x03ff, infoRaw: data[18], source: 'control', receivedAt,
        timestamp: receivedAt === null ? null : receivedAt - ageSeconds * 1000,
        estimatedStart: receivedAt === null ? null : receivedAt - clock * 1000 };
    }
    if (data[0] === 0x4a) {
      if (data.length < 20) throw new Error('G7 identity response is truncated; 20 bytes are required.');
      let serial = 0;
      for (let index = 0; index < 6; index++) serial += data[14 + index] * 2 ** (index * 8);
      return { kind: 'identity', statusRaw: data[1], firmware: Array.from(data.slice(2, 6)).join('.'), build: view.getUint32(6, true), versionCode: view.getUint32(10, true), serial: String(serial) };
    }
    if (data[0] === 0x59) return { kind: 'history-status', opcode: 0x59, raw: hex(data) };
    throw new Error(`Unsupported G7 control opcode 0x${data[0].toString(16).padStart(2, '0')}.`);
  }
  function characteristics(state) {
    const service = state.services?.find(item => item.uuid?.toLowerCase() === SERVICE);
    return (service?.characteristics || []).filter(item => [CONTROL, BACKFILL].includes(item.uuid?.toLowerCase()));
  }
  function createStore(device) {
    if (!device?.address) throw new Error('Select a Dexcom device first.');
    const scope = { address: device.address.toLowerCase(), addressType: device.addressType }, records = new Map();
    let latest = null, identity = null, estimatedStart = null, packets = 0;
    function add(uuid, value, options = {}) {
      const decoded = decode(uuid, value, options); packets++;
      if (decoded.kind === 'identity') identity = decoded;
      if (decoded.kind === 'glucose') {
        latest = decoded;
        if (decoded.estimatedStart !== null) estimatedStart = decoded.estimatedStart;
        records.set(decoded.clock - decoded.ageSeconds, { ...decoded, clock: decoded.clock - decoded.ageSeconds });
      }
      for (const item of decoded.records || []) records.set(item.clock, item);
      while (records.size > 5000) records.delete(records.keys().next().value);
      return decoded;
    }
    function snapshot() {
      return { scope: { ...scope }, packets, latest, identity, estimatedStart, records: [...records.values()].map(item => ({ ...item,
        timestamp: item.timestamp ?? (estimatedStart === null ? null : estimatedStart + item.clock * 1000) })).sort((a, b) => a.clock - b.clock) };
    }
    return { add, snapshot };
  }
  return { SERVICE, CONTROL, BACKFILL, SOURCE, bytes, hex, stateLabel, decode, characteristics, createStore };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcomProtocol;
