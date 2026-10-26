'use strict';

const NanoSensorProfiles = (() => {
  const sources = {
    bthome: { title: 'BTHome v2 format', url: 'https://bthome.io/format/' },
    encryption: { title: 'BTHome encryption', url: 'https://bthome.io/encryption/' },
    ruuvi: { title: 'Ruuvi RAWv2 format', url: 'https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-5-rawv2' },
  };
  const uuid = value => String(value || '').toLowerCase().replace(/^0x/, '').replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  const bytes = value => typeof value === 'string' && /^(?:[0-9a-f]{2})*$/i.test(value) ? Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16)) : null;
  const formatted = (value, unit = '') => unit ? `${Number(value.toFixed(6))} ${unit}` : Number(value.toFixed(6));
  const field = (profile, label, value) => profile.fields.push({ label, value });
  const profile = (title, evidence, source) => ({ category: 'sensor', title, confidence: 'Format match', evidence: [evidence], fields: [], limitations: [], sources: [{ ...sources[source] }] });
  const objects = {
    0x00: ['Packet ID', 1, false, 1, ''], 0x01: ['Battery', 1, false, 1, '%'],
    0x02: ['Temperature', 2, true, 0.01, '°C'], 0x03: ['Humidity', 2, false, 0.01, '%'],
    0x04: ['Pressure', 3, false, 0.01, 'hPa'], 0x05: ['Illuminance', 3, false, 0.01, 'lx'],
    0x09: ['Count', 1, false, 1, ''], 0x0b: ['Power', 3, false, 0.01, 'W'],
    0x0c: ['Voltage', 2, false, 0.001, 'V'], 0x2e: ['Humidity', 1, false, 1, '%'],
    0x3d: ['Count', 2, false, 1, ''], 0x3e: ['Count', 4, false, 1, ''],
    0x45: ['Temperature', 2, true, 0.1, '°C'], 0x4a: ['Voltage', 2, false, 0.1, 'V'],
    0x57: ['Temperature', 1, true, 1, '°C'], 0x58: ['Temperature', 1, true, 0.35, '°C'],
    0x59: ['Count', 1, true, 1, ''], 0x5a: ['Count', 2, true, 1, ''],
    0x5b: ['Count', 4, true, 1, ''], 0x5c: ['Power', 4, true, 0.01, 'W'],
  };
  const binary = {
    0x0f: ['Boolean', 'Off', 'On'], 0x10: ['Power state', 'Off', 'On'],
    0x11: ['Opening', 'Closed', 'Open'], 0x15: ['Battery state', 'Normal', 'Low'],
    0x16: ['Charging', 'Not charging', 'Charging'], 0x1a: ['Door', 'Closed', 'Open'],
    0x1b: ['Garage door', 'Closed', 'Open'], 0x21: ['Motion', 'Clear', 'Detected'],
    0x22: ['Moving', 'Not moving', 'Moving'], 0x23: ['Occupancy', 'Clear', 'Detected'],
    0x2d: ['Window', 'Closed', 'Open'],
  };
  function littleEndian(data, offset, size, signed = false) {
    let value = 0;
    for (let i = 0; i < size; i++) value += data[offset + i] * 256 ** i;
    return signed && value >= 2 ** (size * 8 - 1) ? value - 2 ** (size * 8) : value;
  }
  function bthome(hex) {
    const result = profile('BTHome service', 'Service UUID 0xFCD2 is advertised.', 'bthome');
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
      const object = objects[id], bit = binary[id];
      if (!object && !bit) { result.confidence = decoded ? 'Partial decode' : 'Format match'; result.limitations.push(`Unsupported object ${label}; remaining bytes were not interpreted.`); return result; }
      const size = bit ? 1 : object[1];
      if (offset + size > data.length) { stop(`Truncated object ${label}: expected ${size} value bytes, received ${data.length - offset}.`); return result; }
      if (bit && data[offset] > 1) { stop(`Binary object ${label} has invalid value ${data[offset]}; expected 0 or 1.`); return result; }
      const name = bit ? bit[0] : object[0], count = (counts.get(name) || 0) + 1;
      counts.set(name, count);
      const value = bit ? bit[data[offset] + 1] : formatted(littleEndian(data, offset, size, object[2]) * object[3], object[4]);
      field(result, count === 1 ? name : `${name} ${count}`, value);
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
    const signed = (label, offset, factor, unit) => field(result, label, payload.getInt16(offset) === -32768 ? 'Not available' : formatted(payload.getInt16(offset) * factor, unit));
    const unsigned = (label, offset, factor, adjustment, unit) => field(result, label, payload.getUint16(offset) === 65535 ? 'Not available' : formatted(payload.getUint16(offset) * factor + adjustment, unit));
    signed('Temperature', 1, 0.005, '°C'); unsigned('Humidity', 3, 0.0025, 0, '%'); unsigned('Pressure', 5, 1, 50000, 'Pa');
    signed('Acceleration X', 7, 0.001, 'g'); signed('Acceleration Y', 9, 0.001, 'g'); signed('Acceleration Z', 11, 0.001, 'g');
    const power = payload.getUint16(13), voltage = power >> 5, tx = power & 31;
    field(result, 'Battery voltage', voltage === 2047 ? 'Not available' : formatted((voltage + 1600) / 1000, 'V'));
    field(result, 'TX power', tx === 31 ? 'Not available' : formatted(tx * 2 - 40, 'dBm'));
    field(result, 'Movement counter', payload.getUint8(15) === 255 ? 'Not available' : payload.getUint8(15));
    unsigned('Measurement sequence', 16, 1, 0, '');
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
    return null;
  }
  return { identify };
})();
if (typeof module !== 'undefined') module.exports = NanoSensorProfiles;
