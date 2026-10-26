'use strict';

const NanoSensorProfiles = (() => {
  const sources = {
    bthome: { title: 'BTHome v2 format', url: 'https://bthome.io/format/' },
    encryption: { title: 'BTHome encryption', url: 'https://bthome.io/encryption/' },
    parser: { title: 'BTHome reference object definitions', url: 'https://github.com/Bluetooth-Devices/bthome-ble/blob/18e1c664c8595ac5f7e2daa63e9a90516ccd3800/src/bthome_ble/const.py' },
    ruuvi: { title: 'Ruuvi RAWv2 format', url: 'https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-5-rawv2' },
    ruuvi6: { title: 'Ruuvi Air format 6', url: 'https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-6' },
    ruuviE1: { title: 'Ruuvi Air extended format E1', url: 'https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-e1' },
  };
  const uuid = value => String(value || '').toLowerCase().replace(/^0x/, '').replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  const bytes = value => typeof value === 'string' && /^(?:[0-9a-f]{2})*$/i.test(value) ? Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16)) : null;
  const formatted = (value, unit = '') => unit ? `${Number(value.toFixed(6))} ${unit}` : Number(value.toFixed(6));
  const field = (profile, label, value, numericValue, unit = '') => profile.fields.push({ label, value, ...(Number.isFinite(numericValue) ? { numericValue: Number(numericValue.toFixed(6)), unit } : {}) });
  const measurement = (profile, label, value, unit = '') => field(profile, label, formatted(value, unit), value, unit);
  const profile = (title, evidence, source) => ({ category: 'sensor', protocol: source, title, confidence: 'Format match', evidence: [evidence], fields: [], limitations: [], sources: [{ ...sources[source] }] });
  const objects = {
    0x00: ['Packet ID', 1, false, 1, ''], 0x01: ['Battery', 1, false, 1, '%'],
    0x02: ['Temperature', 2, true, 0.01, '°C'], 0x03: ['Humidity', 2, false, 0.01, '%'],
    0x04: ['Pressure', 3, false, 0.01, 'hPa'], 0x05: ['Illuminance', 3, false, 0.01, 'lx'],
    0x06: ['Mass', 2, false, 0.01, 'kg'], 0x07: ['Mass', 2, false, 0.01, 'lb'],
    0x08: ['Dewpoint', 2, true, 0.01, '°C'],
    0x09: ['Count', 1, false, 1, ''], 0x0b: ['Power', 3, false, 0.01, 'W'],
    0x0a: ['Energy', 3, false, 0.001, 'kWh'], 0x12: ['CO2', 2, false, 1, 'ppm'],
    0x43: ['Current', 2, false, 0.001, 'A'], 0x4d: ['Energy', 4, false, 0.001, 'kWh'],
    0x0c: ['Voltage', 2, false, 0.001, 'V'], 0x2e: ['Humidity', 1, false, 1, '%'],
    0x0d: ['PM2.5', 2, false, 1, 'µg/m³'], 0x0e: ['PM10', 2, false, 1, 'µg/m³'],
    0x13: ['TVOC', 2, false, 1, 'µg/m³'], 0x14: ['Moisture', 2, false, 0.01, '%'],
    0x2f: ['Moisture', 1, false, 1, '%'],
    0x3d: ['Count', 2, false, 1, ''], 0x3e: ['Count', 4, false, 1, ''],
    0x45: ['Temperature', 2, true, 0.1, '°C'], 0x4a: ['Voltage', 2, false, 0.1, 'V'],
    0x3f: ['Rotation', 2, true, 0.1, '°'], 0x40: ['Distance', 2, false, 1, 'mm'],
    0x41: ['Distance', 2, false, 0.1, 'm'], 0x42: ['Duration', 3, false, 0.001, 's'],
    0x44: ['Speed', 2, false, 0.01, 'm/s'], 0x46: ['UV index', 1, false, 0.1, ''],
    0x47: ['Volume', 2, false, 0.1, 'L'], 0x48: ['Volume', 2, false, 1, 'mL'],
    0x49: ['Volume flow rate', 2, false, 0.001, 'm³/hr'],
    0x4b: ['Gas', 3, false, 0.001, 'm³'], 0x4c: ['Gas', 4, false, 0.001, 'm³'],
    0x4e: ['Volume', 4, false, 0.001, 'L'], 0x4f: ['Water', 4, false, 0.001, 'L'],
    0x50: ['Timestamp', 4, false, 1, ''], 0x51: ['Acceleration', 2, false, 0.001, 'm/s²'],
    0x52: ['Gyroscope', 2, false, 0.001, '°/s'],
    0x55: ['Volume storage', 4, false, 0.001, 'L'], 0x56: ['Conductivity', 2, false, 1, 'µS/cm'],
    0x57: ['Temperature', 1, true, 1, '°C'], 0x58: ['Temperature', 1, true, 0.35, '°C'],
    0x59: ['Count', 1, true, 1, ''], 0x5a: ['Count', 2, true, 1, ''],
    0x5b: ['Count', 4, true, 1, ''], 0x5c: ['Power', 4, true, 0.01, 'W'],
    0x5d: ['Current', 2, true, 0.001, 'A'], 0x5e: ['Direction', 2, false, 0.01, '°'],
    0x5f: ['Precipitation', 2, false, 0.1, 'mm'], 0x60: ['Channel', 1, false, 1, ''],
    0x61: ['Rotational speed', 2, false, 1, 'rpm'], 0x62: ['Speed', 4, true, 0.000001, 'm/s'],
    0x63: ['Acceleration', 4, true, 0.000001, 'm/s²'], 0x64: ['Light level', 1, false, 1, ''],
    0x65: ['Settings revision', 1, false, 1, ''],
    0xf0: ['Device type ID', 2, false, 1, ''], 0xf1: ['Firmware version', 4, false, 1, ''],
    0xf2: ['Firmware version', 3, false, 1, ''],
  };
  const binary = {
    0x0f: ['Boolean', 'Off', 'On'], 0x10: ['Power state', 'Off', 'On'],
    0x11: ['Opening', 'Closed', 'Open'], 0x15: ['Battery state', 'Normal', 'Low'],
    0x16: ['Charging', 'Not charging', 'Charging'], 0x1a: ['Door', 'Closed', 'Open'],
    0x17: ['Carbon monoxide', 'Clear', 'Detected'], 0x18: ['Cold', 'Normal', 'Cold'],
    0x19: ['Connectivity', 'Disconnected', 'Connected'],
    0x1b: ['Garage door', 'Closed', 'Open'], 0x21: ['Motion', 'Clear', 'Detected'],
    0x1c: ['Gas detected', 'Clear', 'Detected'], 0x1d: ['Heat', 'Normal', 'Hot'],
    0x1e: ['Light', 'No light', 'Light detected'], 0x1f: ['Lock', 'Locked', 'Unlocked'],
    0x20: ['Moisture state', 'Dry', 'Wet'],
    0x22: ['Moving', 'Not moving', 'Moving'], 0x23: ['Occupancy', 'Clear', 'Detected'],
    0x2d: ['Window', 'Closed', 'Open'],
    0x24: ['Plug', 'Unplugged', 'Plugged in'], 0x25: ['Presence', 'Away', 'Home'],
    0x26: ['Problem', 'OK', 'Problem'], 0x27: ['Running', 'Not running', 'Running'],
    0x28: ['Safety', 'Unsafe', 'Safe'], 0x29: ['Smoke', 'Clear', 'Detected'],
    0x2a: ['Sound', 'Clear', 'Detected'], 0x2b: ['Tamper', 'Off', 'On'],
    0x2c: ['Vibration', 'Clear', 'Detected'],
  };
  const metadataIDs = new Set([0x00, 0x50, 0x60, 0x64, 0x65, 0xf0, 0xf1, 0xf2]);
  const buttonEvents = { 0: 'None', 1: 'Press', 2: 'Double press', 3: 'Triple press', 4: 'Long press', 5: 'Long double press', 6: 'Long triple press', 128: 'Hold press' };
  function littleEndian(data, offset, size, signed = false) {
    let value = 0;
    for (let i = 0; i < size; i++) value += data[offset + i] * 256 ** i;
    return signed && value >= 2 ** (size * 8 - 1) ? value - 2 ** (size * 8) : value;
  }
  function bthome(hex) {
    const result = profile('BTHome service', 'Service UUID 0xFCD2 is advertised.', 'bthome');
    result.sources.push({ ...sources.parser });
    const data = bytes(hex);
    if (!data?.length) {
      result.confidence = hex === undefined ? 'Service match' : 'Malformed frame';
      result.limitations.push(hex === undefined ? 'No BTHome service-data payload was received.' : 'Missing or invalid hexadecimal BTHome device-information byte.');
      return result;
    }
    const version = data[0] >> 5, encrypted = Boolean(data[0] & 1);
    field(result, 'BTHome version', version);
    if (version !== 2) { result.confidence = 'Service match'; result.limitations.push(`BTHome version ${version} is unsupported by this v2 decoder.`); return result; }
    result.title = 'BTHome v2 sensor';
    field(result, 'Encryption', encrypted ? 'Encrypted' : 'Unencrypted');
    field(result, 'Update mode', data[0] & 4 ? 'Trigger-based' : 'Periodic');
    if (data[0] & 0x1a) { result.confidence = 'Malformed frame'; result.limitations.push('Reserved BTHome device-information bits are set; measurements were not decoded.'); return result; }
    if (encrypted) {
      result.title = 'BTHome v2 encrypted sensor'; result.sources.push({ ...sources.encryption });
      if (data.length < 11) { result.confidence = 'Malformed frame'; result.limitations.push('Encrypted BTHome payload is too short for measurements, counter, and authentication tag.'); return result; }
      field(result, 'Encrypted bytes', data.length - 9);
      field(result, 'Advertised counter', littleEndian(data, data.length - 8, 4));
      result.limitations.push('Encrypted measurements require the device key; payload authentication was not verified.');
      return result;
    }
    let previous = -1, decoded = 0;
    const counts = new Map();
    const stop = message => { result.confidence = decoded ? 'Partial decode' : 'Malformed frame'; result.limitations.push(message); };
    for (let offset = 1; offset < data.length;) {
      const id = data[offset++], label = `0x${id.toString(16).padStart(2, '0')}`;
      if (id < previous) { stop(`Object ${label} is out of ascending ID order; decoding stopped.`); return result; }
      previous = id;
      const object = objects[id], bit = binary[id], variable = id === 0x53 || id === 0x54 || id === 0x3b;
      const event = id === 0x3a || id === 0x3b || id === 0x3c;
      if (!object && !bit && !variable && !event) { result.confidence = decoded ? 'Partial decode' : 'Format match'; result.limitations.push(`Unsupported object ${label}; remaining bytes were not interpreted.`); return result; }
      if (variable && offset === data.length) { stop(`Truncated object ${label}: missing length byte.`); return result; }
      if (id === 0x3b && data[offset] & 0xe0) { stop('Command object has reserved argument-length bits set.'); return result; }
      const size = variable ? data[offset] + (id === 0x3b ? 2 : 1) : event ? (id === 0x3a ? 1 : 2) : bit ? 1 : object[1];
      if (offset + size > data.length) { stop(`Truncated object ${label}: expected ${size} value bytes, received ${data.length - offset}.`); return result; }
      if (bit && data[offset] > 1) { stop(`Binary object ${label} has invalid value ${data[offset]}; expected 0 or 1.`); return result; }
      const name = variable ? ({ 0x53: 'Text', 0x54: 'Raw', 0x3b: 'Command' })[id] : event ? (id === 0x3a ? 'Button' : 'Dimmer') : bit ? bit[0] : object[0], count = (counts.get(name) || 0) + 1;
      counts.set(name, count);
      const fieldName = count === 1 ? name : `${name} ${count}`, rawHex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
      if (id === 0x53) {
        try { field(result, fieldName, new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset + 1, offset + size))); }
        catch { stop('Text object contains invalid UTF-8.'); return result; }
      } else if (id === 0x54) field(result, fieldName, rawHex(data.subarray(offset + 1, offset + size)));
      else if (id === 0x3a) field(result, fieldName, buttonEvents[data[offset]] || `Unknown event ${data[offset]}`);
      else if (id === 0x3b) {
        const opcode = data[offset + 1], command = ['Off', 'On', 'Toggle', 'Step up', 'Step down'][opcode] || `Opcode ${opcode}`;
        field(result, fieldName, `${command}${data[offset] ? ` (arguments ${rawHex(data.subarray(offset + 2, offset + size))})` : ''}`);
      } else if (id === 0x3c) field(result, fieldName, `${['None', 'Rotate left', 'Rotate right'][data[offset]] || `Unknown event ${data[offset]}`} (${data[offset + 1]} steps)`);
      else if (bit) field(result, fieldName, bit[data[offset] + 1], data[offset], '');
      else {
        const value = littleEndian(data, offset, size, object[2]) * object[3];
        if (id === 0x50) field(result, fieldName, new Date(value * 1000).toISOString());
        else if (id === 0xf1 || id === 0xf2) field(result, fieldName, Array.from(data.subarray(offset, offset + size)).reverse().join('.'));
        else if (id === 0x64) field(result, fieldName, ['Dark', 'Twilight', 'Bright'][value] || `Unknown level ${value}`);
        else if (metadataIDs.has(id)) field(result, fieldName, value);
        else measurement(result, fieldName, value, object[4]);
      }
      offset += size; decoded++;
    }
    result.confidence = decoded ? 'Decoded format' : 'Format match';
    if (!decoded) result.limitations.push('The frame contains no measurement objects.');
    return result;
  }
  function ruuvi(data) {
    const result = profile('Ruuvi RAWv2 sensor', 'Manufacturer company 0x0499 with data format 5.', 'ruuvi');
    if (data.length !== 26) { result.confidence = 'Malformed frame'; result.limitations.push(`RAWv2 requires 26 manufacturer-data bytes including the company ID; received ${data.length}.`); return result; }
    const payload = new DataView(data.buffer, data.byteOffset + 2, 24);
    const signed = (label, offset, factor, unit) => payload.getInt16(offset) === -32768 ? field(result, label, 'Not available') : measurement(result, label, payload.getInt16(offset) * factor, unit);
    const unsigned = (label, offset, factor, adjustment, unit) => payload.getUint16(offset) === 65535 ? field(result, label, 'Not available') : measurement(result, label, payload.getUint16(offset) * factor + adjustment, unit);
    signed('Temperature', 1, 0.005, '°C'); unsigned('Humidity', 3, 0.0025, 0, '%'); unsigned('Pressure', 5, 1, 50000, 'Pa');
    signed('Acceleration X', 7, 0.001, 'g'); signed('Acceleration Y', 9, 0.001, 'g'); signed('Acceleration Z', 11, 0.001, 'g');
    const power = payload.getUint16(13), voltage = power >> 5, tx = power & 31;
    voltage === 2047 ? field(result, 'Battery voltage', 'Not available') : measurement(result, 'Battery voltage', (voltage + 1600) / 1000, 'V');
    tx === 31 ? field(result, 'TX power', 'Not available') : measurement(result, 'TX power', tx * 2 - 40, 'dBm');
    payload.getUint8(15) === 255 ? field(result, 'Movement counter', 'Not available') : measurement(result, 'Movement counter', payload.getUint8(15));
    field(result, 'Measurement sequence', payload.getUint16(16) === 65535 ? 'Not available' : payload.getUint16(16));
    const mac = data.slice(20, 26);
    field(result, 'Sensor MAC', mac.every(value => value === 255) ? 'Not available' : Array.from(mac, value => value.toString(16).padStart(2, '0')).join(':'));
    result.confidence = 'Decoded format';
    return result;
  }
  function identify(device = {}) {
    if (!device || typeof device !== 'object') return null;
    const service = Array.isArray(device.serviceData) ? device.serviceData.find(item => uuid(item?.uuid) === 'fcd2') : null;
    if (service || (Array.isArray(device.services) && device.services.some(item => uuid(item) === 'fcd2'))) return bthome(service?.hex);
    const manufacturer = bytes(device.manufacturer);
    if (manufacturer?.length >= 3 && manufacturer[0] === 0x99 && manufacturer[1] === 4 && manufacturer[2] === 5) return ruuvi(manufacturer);
    if (manufacturer?.length >= 3 && manufacturer[0] === 0x99 && manufacturer[1] === 4 && [6, 0xe1].includes(manufacturer[2])) return ruuviAir(manufacturer, device.payloadTruncated === true);
    return null;
  }
  function ruuviAir(data, truncated) {
    const extended = data[2] === 0xe1, format = extended ? 'E1' : '6', length = extended ? 42 : 22;
    const result = profile(`Ruuvi Air · format ${format}`, `Manufacturer company 0x0499 with data format ${format}.`, 'ruuvi');
    result.sources = [{ ...sources[extended ? 'ruuviE1' : 'ruuvi6'] }];
    if (truncated || data.length !== length) { result.confidence = 'Malformed frame'; result.limitations.push(`Format ${format} requires ${length} complete manufacturer-data bytes including the company ID; received ${data.length}${truncated ? ' with a truncation flag' : ''}.`); return result; }
    const payload = data.subarray(2), view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength), flags = payload[extended ? 28 : 16];
    const u16 = (label, offset, factor, adjustment, unit) => view.getUint16(offset) === 65535 ? field(result, label, 'Not available') : measurement(result, label, view.getUint16(offset) * factor + adjustment, unit);
    const u24 = offset => payload[offset] * 65536 + payload[offset + 1] * 256 + payload[offset + 2];
    const temperature = view.getInt16(1);
    temperature === -32768 ? field(result, 'Temperature', 'Not available') : measurement(result, 'Temperature', temperature * .005, '°C');
    u16('Humidity', 3, .0025, 0, '%'); u16('Pressure', 5, 1, 50000, 'Pa');
    for (const [label, offset] of extended ? [['PM1', 7], ['PM2.5', 9], ['PM4', 11], ['PM10', 13]] : [['PM2.5', 7]]) u16(label, offset, .1, 0, 'µg/m³');
    u16('CO2', extended ? 15 : 9, 1, 0, 'ppm');
    for (const [label, offset, bit] of [['VOC index', extended ? 17 : 11, 6], ['NOX index', extended ? 18 : 12, 7]]) {
      const value = payload[offset] * 2 + ((flags >> bit) & 1);
      value === 511 ? field(result, label, 'Not available') : measurement(result, label, value);
    }
    const light = extended ? u24(19) : payload[13];
    light === (extended ? 16777215 : 255) ? field(result, 'Illuminance', 'Not available') : measurement(result, 'Illuminance', extended ? light * .01 : Math.round(Math.expm1(light * Math.log(65536) / 254) * 100) / 100, 'lx');
    const sequence = extended ? u24(25) : payload[15];
    field(result, 'Measurement sequence', extended && sequence === 16777215 ? 'Not available' : sequence);
    field(result, 'Calibration', flags & 1 ? 'In progress' : 'Complete');
    const mac = payload.subarray(extended ? 34 : 17);
    field(result, extended ? 'Sensor MAC' : 'Sensor MAC suffix', mac.every(value => value === 255) ? 'Not available' : Array.from(mac, value => value.toString(16).padStart(2, '0')).join(':'));
    if (flags & 1) result.limitations.push('Calibration is in progress; sensor readings have not settled.');
    if (extended) result.limitations.push('Format E1 needs a complete extended advertisement. Live reception depends on the controller and firmware.');
    else result.limitations.push('The three-byte MAC suffix is not a complete address. Format 6 carries fewer measurements than E1.');
    result.confidence = 'Decoded format'; return result;
  }
  async function identifyDecrypted(device, key) {
    const service = device?.serviceData?.find(item => uuid(item?.uuid) === 'fcd2');
    const original = identify(device);
    if (original?.protocol !== 'bthome' || original.confidence === 'Malformed frame' || !service?.hex || !(bytes(service.hex)[0] & 1)) throw new Error('An encrypted BTHome v2 service-data frame is required.');
    const decoder = typeof NanoBTHomeCrypto !== 'undefined' ? NanoBTHomeCrypto : typeof require === 'function' ? require('./bthome-crypto.js') : null;
    if (!decoder) throw new Error('BTHome cryptography is unavailable.');
    const decrypted = await decoder.decrypt({ hex: service.hex, mac: device.address, key });
    const result = bthome(decrypted.hex);
    result.title = 'BTHome v2 encrypted sensor'; result.authenticated = true; result.counter = decrypted.counter;
    result.fields.find(item => item.label === 'Encryption').value = 'Encrypted';
    field(result, 'Authentication', 'Verified MIC'); field(result, 'Advertised counter', decrypted.counter);
    result.sources.push({ ...sources.encryption });
    return result;
  }
  return { identify, identifyDecrypted, sources };
})();
if (typeof module !== 'undefined') module.exports = NanoSensorProfiles;
