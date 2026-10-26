'use strict';

const NanoGattValues = (() => {
  const strings = { '2a00': 'Device name', '2a29': 'Manufacturer', '2a24': 'Model', '2a25': 'Serial number', '2a26': 'Firmware revision', '2a27': 'Hardware revision', '2a28': 'Software revision' };
  const temperatureTypes = ['Reserved', 'Armpit', 'Body', 'Ear', 'Finger', 'Gastrointestinal tract', 'Mouth', 'Rectum', 'Toe', 'Eardrum'];
  const appearances = {
    0: 'Unknown', 1: 'Phone', 2: 'Computer', 3: 'Watch', 4: 'Clock', 5: 'Display', 6: 'Remote Control', 7: 'Eye-glasses', 8: 'Tag', 9: 'Keyring',
    10: 'Media Player', 11: 'Barcode Scanner', 12: 'Thermometer', 13: 'Heart Rate Sensor', 14: 'Blood Pressure', 15: 'Human Interface Device', 16: 'Glucose Meter',
    17: 'Running Walking Sensor', 18: 'Cycling', 19: 'Control Device', 20: 'Network Device', 21: 'Sensor', 22: 'Light Fixtures', 23: 'Fan', 24: 'HVAC',
    25: 'Air Conditioning', 26: 'Humidifier', 27: 'Heating', 28: 'Access Control', 29: 'Motorized Device', 30: 'Power Device', 31: 'Light Source',
    32: 'Window Covering', 33: 'Audio Sink', 34: 'Audio Source', 35: 'Motorized Vehicle', 36: 'Domestic Appliance', 37: 'Wearable Audio Device',
    38: 'Aircraft', 39: 'AV Equipment', 40: 'Display Equipment', 41: 'Hearing aid', 42: 'Gaming', 43: 'Signage', 49: 'Pulse Oximeter', 50: 'Weight Scale',
    51: 'Personal Mobility Device', 52: 'Continuous Glucose Monitor', 53: 'Insulin Pump', 54: 'Medication Delivery', 55: 'Spirometer',
    81: 'Outdoor Sports Activity', 82: 'Industrial Measurement Device', 83: 'Industrial Tools', 84: 'Cookware Device'
  };
  const formats = ['Reserved', 'Boolean', 'uint2', 'uint4', 'uint8', 'uint12', 'uint16', 'uint24', 'uint32', 'uint48', 'uint64', 'uint128', 'sint8', 'sint12', 'sint16', 'sint24', 'sint32', 'sint48', 'sint64', 'sint128', 'float32', 'float64', 'SFLOAT', 'FLOAT', 'IEEE-20601', 'UTF-8', 'UTF-16', 'Opaque structure'];
  const sourceList = [
    { title: 'Bluetooth SIG GATT Specification Supplement', url: 'https://btprodspecificationrefs.blob.core.windows.net/gatt-specification-supplement/GATT_Specification_Supplement.pdf' },
    { title: 'Bluetooth SIG Heart Rate Service', url: 'https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/HRS_v1.0/out/en/index-en.html' },
    { title: 'Bluetooth SIG appearance values', url: 'https://bitbucket.org/bluetooth-SIG/public/raw/main/assigned_numbers/core/appearance_values.yaml' },
    { title: 'Bluetooth SIG Generic Attribute Profile', url: 'https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/host/generic-attribute-profile--gatt-.html' }
  ];
  const field = (label, value) => ({ label, value: String(value) });
  const hex16 = value => `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
  function shortUuid(uuid) {
    if (typeof uuid !== 'string') return '';
    uuid = uuid.trim().toLowerCase();
    if (/^(?:0x)?[\da-f]{4}$/.test(uuid)) return uuid.replace(/^0x/, '');
    const base = /^0000([\da-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(uuid);
    return base ? base[1] : '';
  }
  function heartRate(bytes, data) {
    if (bytes.length < 2 || (bytes[0] & 0xe0)) return [];
    const flags = bytes[0], wide = Boolean(flags & 1);
    let offset = wide ? 3 : 2;
    if (bytes.length < offset) return [];
    const fields = [field('Heart rate measurement', `${wide ? data.getUint16(1, true) : bytes[1]} bpm`)];
    if (flags & 4) fields.push(field('Sensor contact', flags & 2 ? 'Detected' : 'Not detected'));
    else fields.push(field('Sensor contact', 'Not supported'));
    if (flags & 8) {
      if (bytes.length < offset + 2) return [];
      fields.push(field('Energy expended', `${data.getUint16(offset, true)} kJ`)); offset += 2;
    }
    if (flags & 16) {
      if (bytes.length < offset + 2 || (bytes.length - offset) % 2) return [];
      for (let index = 1; offset < bytes.length; offset += 2, index++) fields.push(field(`RR interval ${index}`, `${Number((data.getUint16(offset, true) * 1000 / 1024).toFixed(6))} ms`));
    }
    return offset === bytes.length ? fields : [];
  }
  function decode(uuid, hex) {
    if (typeof hex !== 'string' || hex.length > 1024 || hex.length % 2 || !/^[\da-f]*$/i.test(hex)) return [];
    const key = shortUuid(uuid), bytes = Uint8Array.from(hex.match(/../g) || [], pair => parseInt(pair, 16));
    const data = new DataView(bytes.buffer);
    try {
      if (Object.hasOwn(strings, key)) {
        if (!bytes.length) return [];
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return [];
        return [field(strings[key], text)];
      }
      if (key === '2a19' && bytes.length === 1) {
        if (bytes[0] === 255) return [field('Battery level', 'Unknown / reserved (0xFF)')];
        return bytes[0] <= 100 ? [field('Battery level', `${bytes[0]}%`)] : [];
      }
      if (key === '2a01' && bytes.length === 2) {
        const value = data.getUint16(0, true), category = value >>> 6;
        return [field('Appearance', hex16(value)), field('Appearance category', appearances[category] || `Unassigned category ${hex16(category)}`), field('Appearance subcategory', value & 63)];
      }
      if (key === '2a6e' && bytes.length === 2) {
        const value = data.getInt16(0, true);
        if (value === -32768) return [field('Temperature', 'Unknown')];
        return value >= -27315 ? [field('Temperature', `${(value / 100).toFixed(2)} °C`)] : [];
      }
      if (key === '2a6f' && bytes.length === 2) {
        const value = data.getUint16(0, true);
        if (value === 65535) return [field('Humidity', 'Unknown')];
        return value <= 10000 ? [field('Humidity', `${(value / 100).toFixed(2)}%`)] : [];
      }
      if (['2a1c', '2a1e'].includes(key)) {
        const flags = bytes[0], length = 5 + (flags & 2 ? 7 : 0) + (flags & 4 ? 1 : 0);
        if (bytes.length !== length || flags & 0xf8) return [];
        const raw = data.getUint32(1, true), mantissa = (raw << 8) >> 8, exponent = data.getInt8(4);
        const special = { 0x007fffff: 'Not a number', 0x007ffffe: 'Positive infinity', 0x00800002: 'Negative infinity', 0x00800000: 'Not at this resolution', 0x00800001: 'Reserved value' };
        const fields = [field(key === '2a1c' ? 'Temperature measurement' : 'Intermediate temperature', special[raw] || `${Number((mantissa * 10 ** exponent).toPrecision(10))} °${flags & 1 ? 'F' : 'C'}`)];
        if (flags & 2) {
          const year = data.getUint16(5, true), month = bytes[7], day = bytes[8], hour = bytes[9], minute = bytes[10], second = bytes[11];
          if (year && (year < 1582 || year > 9999) || month > 12 || day > 31 || hour > 23 || minute > 59 || second > 59) return [];
          const pad = number => String(number).padStart(2, '0');
          fields.push(field('Device timestamp', `${year || 'Unknown year'}-${month ? pad(month) : '??'}-${day ? pad(day) : '??'} ${pad(hour)}:${pad(minute)}:${pad(second)}`));
        }
        if (flags & 4) fields.push(field('Measurement location', temperatureTypes[bytes[length - 1]] || `Reserved (${bytes[length - 1]})`));
        return fields;
      }
      if (key === '2a1d' && bytes.length === 1) return [field('Measurement location', temperatureTypes[bytes[0]] || `Reserved (${bytes[0]})`)];
      if (key === '2a21' && bytes.length === 2) return [field('Measurement interval', data.getUint16(0, true) ? `${data.getUint16(0, true)} seconds` : 'No periodic measurement')];
      if (key === '2a6d' && bytes.length === 4) return [field('Pressure', `${data.getUint32(0, true) / 10} Pa`)];
      if (key === '2a07' && bytes.length === 1) {
        const value = data.getInt8(0);
        return value >= -100 && value <= 20 ? [field('Transmit power', `${value} dBm`)] : [];
      }
      if (key === '2a37') return heartRate(bytes, data);
      if (key === '2904' && bytes.length === 7) return [
        field('Value format', formats[bytes[0]] || `Reserved format 0x${bytes[0].toString(16).padStart(2, '0')}`),
        field('Decimal exponent (raw)', data.getInt8(1)), field('Unit UUID', hex16(data.getUint16(2, true))),
        field('Namespace', bytes[4] === 1 ? 'Bluetooth SIG' : `0x${bytes[4].toString(16).padStart(2, '0')}`),
        field('Description code', hex16(data.getUint16(5, true)))
      ];
    } catch { return []; }
    return typeof NanoMetadata !== 'undefined' ? NanoMetadata.decode(uuid, hex) : [];
  }
  return { decode, sources: () => sourceList.map(source => ({ ...source })) };
})();
if (typeof module !== 'undefined') module.exports = NanoGattValues;
