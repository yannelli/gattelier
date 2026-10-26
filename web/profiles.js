'use strict';

const NanoProfiles = (() => {
  const references = {
    ad: { title: 'Bluetooth advertising data', url: 'https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/CSS_v11/out/en/supplement-to-the-bluetooth-core-specification/data-types-specification.html' },
    findmy: { title: 'Find My envelope reference', url: 'https://github.com/seemoo-lab/openhaystack/blob/main/Firmware/ESP32/main/openhaystack_main.c' },
    ibeacon: { title: 'iBeacon format', url: 'https://github.com/espressif/arduino-esp32/blob/master/libraries/BLE/src/BLEBeacon.cpp' },
    eddystone: { title: 'Eddystone specification', url: 'https://github.com/google/eddystone/blob/master/protocol-specification.md' },
    sig: { title: 'Bluetooth service registry', url: 'https://bitbucket.org/bluetooth-SIG/public/raw/main/assigned_numbers/uuids/member_uuids.yaml' },
    dexcom: { title: 'Dexcom service metadata', url: 'https://github.com/LoopKit/G7SensorKit/blob/main/G7SensorKit/BluetoothServices.swift' },
    dexcomName: { title: 'Dexcom broadcast names', url: 'https://github.com/LoopKit/G7SensorKit/blob/main/G7SensorKit/G7CGMManager/G7Sensor.swift' },
    sleep: { title: 'Sleep Number BLE transports', url: 'https://github.com/kristofferR/ha-adjustable-bed/blob/main/docs/beds/sleep_number.md' }
  };
  const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  const bytes = value => typeof value === 'string' && /^(?:[\da-f]{2})*$/i.test(value) ? Uint8Array.from(value.match(/../g) || [], value => parseInt(value, 16)) : new Uint8Array();
  const signed = value => value > 127 ? value - 256 : value;
  const uuid = value => String(value).toLowerCase().replace(/^0x/, '').replace(/^0000([\da-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  const uuid128 = value => { const h = hex(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  function advertisement(value) {
    const data = bytes(value), fields = [], errors = [];
    if (value && !data.length) errors.push('Invalid hexadecimal advertisement.');
    for (let offset = 0; offset < data.length;) {
      const length = data[offset++]; if (!length) break;
      if (offset + length > data.length) { errors.push(`Truncated AD structure at byte ${offset - 1}.`); break; }
      const type = data[offset], part = data.slice(offset + 1, offset + length); offset += length;
      let label = `AD type 0x${type.toString(16).padStart(2, '0')}`, result = hex(part);
      if (type === 1 && part.length === 1) { label = 'Flags'; result = `${hex(part)} · ${part[0] & 2 ? 'General discoverable' : part[0] & 1 ? 'Limited discoverable' : 'Discovery mode unspecified'}${part[0] & 4 ? ' · LE only' : ''}`; }
      if ([8, 9].includes(type)) { label = type === 9 ? 'Complete local name' : 'Shortened local name'; result = new TextDecoder().decode(part); }
      if (type === 10 && part.length === 1) { label = 'Advertised TX power'; result = `${signed(part[0])} dBm`; }
      if (type === 25 && part.length === 2) { label = 'Appearance code'; result = String(part[0] | part[1] << 8); }
      if ([2, 3].includes(type) && part.length % 2 === 0) { label = '16-bit service UUIDs'; result = Array.from({ length: part.length / 2 }, (_, i) => `0x${hex(part.slice(i * 2, i * 2 + 2).reverse())}`).join(', '); }
      if ([6, 7].includes(type) && part.length % 16 === 0) { label = '128-bit service UUIDs'; result = Array.from({ length: part.length / 16 }, (_, i) => uuid128(part.slice(i * 16, i * 16 + 16).reverse())).join(', '); }
      if (type === 255 && part.length >= 2) { label = 'Manufacturer data'; result = `Company 0x${hex(part.slice(0, 2).reverse())} · ${hex(part.slice(2))}`; }
      fields.push({ label, value: result });
    }
    return { fields, errors };
  }
  function identify(device = {}) {
    const result = { category: 'other', title: 'BLE metadata', confidence: 'Unclassified', evidence: [], fields: [], limitations: [], sources: [references.ad] };
    const manufacturer = bytes(device.manufacturer), services = (device.services || []).map(uuid);
    const set = (category, title, confidence, evidence, source) => Object.assign(result, { category, title, confidence, evidence: [evidence], fields: [], limitations: [], sources: [references[source]] });
    const field = (label, value) => result.fields.push({ label, value });
    if (manufacturer.length === 29 && hex(manufacturer.slice(0, 4)) === '4c001219') {
      set('tracker', 'Find My-compatible broadcast', 'Format match', 'Apple manufacturer envelope 0x12 with 25-byte payload.', 'findmy');
      field('Status byte', `0x${hex(manufacturer.slice(4, 5))}`);
      result.limitations.push('This envelope does not identify an AirTag model, owner, location, or tracking intent.');
    } else if (manufacturer.length === 25 && hex(manufacturer.slice(0, 4)) === '4c000215') {
      set('beacon', 'iBeacon', 'Decoded format', 'Apple manufacturer data with iBeacon type 0x02 and length 0x15.', 'ibeacon');
      field('Beacon UUID', uuid128(manufacturer.slice(4, 20))); field('Major', manufacturer[20] << 8 | manufacturer[21]); field('Minor', manufacturer[22] << 8 | manufacturer[23]); field('Calibrated TX at 1 m', `${signed(manufacturer[24])} dBm`);
    } else if (services.some(value => ['feed', 'feec'].includes(value))) {
      set('tracker', 'Tile service', 'Service match', 'Advertised FEED/FEEC service assigned to Tile.', 'sig');
      result.limitations.push('The service does not identify a model, owner, or location.');
    }
    const eddystone = (device.serviceData || []).find(item => uuid(item.uuid) === 'feaa');
    if (eddystone || services.includes('feaa')) {
      set('beacon', 'Eddystone service', 'Service match', 'Service UUID FEAA is advertised.', 'eddystone');
      const data = bytes(eddystone?.hex), view = new DataView(data.buffer);
      if (data[0] === 0 && [18, 20].includes(data.length)) {
        result.title = 'Eddystone UID'; result.confidence = 'Decoded format'; field('Namespace', hex(data.slice(2, 12))); field('Instance', hex(data.slice(12, 18))); field('Calibrated TX at 0 m', `${signed(data[1])} dBm`);
      } else if (data[0] === 0x10 && data.length >= 4 && data.length <= 20) {
        const schemes = ['http://www.', 'https://www.', 'http://', 'https://'];
        const endings = ['.com/', '.org/', '.edu/', '.net/', '.info/', '.biz/', '.gov/', '.com', '.org', '.edu', '.net', '.info', '.biz', '.gov'];
        const valid = schemes[data[2]] && data.slice(3).every(value => value <= 13 || value >= 33 && value <= 126);
        if (valid) { result.title = 'Eddystone URL'; result.confidence = 'Decoded format'; field('Broadcast URL', schemes[data[2]] + Array.from(data.slice(3), value => value <= 13 ? endings[value] : String.fromCharCode(value)).join('')); field('Calibrated TX at 0 m', `${signed(data[1])} dBm`); }
        else result.limitations.push('Malformed URL frame; URL not decoded.');
      } else if (data[0] === 0x20 && data.length === 14 && data[1] === 0) {
        result.title = 'Eddystone telemetry'; result.confidence = 'Decoded format';
        field('Battery voltage', view.getUint16(2) ? `${view.getUint16(2)} mV` : 'Not supplied');
        field('Beacon temperature', view.getUint16(4) === 0x8000 ? 'Not supplied' : `${view.getInt16(4) / 256} °C`);
        field('Advertisement counter', view.getUint32(6)); field('Beacon uptime', `${view.getUint32(10) / 10} seconds`);
      } else if (data[0] === 0x30 && data.length === 10) {
        result.title = 'Eddystone EID'; result.confidence = 'Decoded format';
        field('Calibrated TX power', `${view.getInt8(1)} dBm`); field('Ephemeral identifier', Array.from(data.slice(2), value => value.toString(16).padStart(2, '0')).join(''));
        result.limitations.push('This rotating identifier requires its authorized resolver to establish a beacon identity.');
      } else result.limitations.push('No supported UID, URL, EID, or unencrypted telemetry frame in this advertisement.');
    }
    const dexcomService = services.find(value => ['febc', 'f8083532-849e-531c-c594-30f1f86a4ea5'].includes(value));
    const dexcomName = /^(?:DXCM|DX02|Dexcom)[\da-z]{2}$/i.test(device.name || '');
    if (dexcomService || dexcomName) {
      set('medical', 'Dexcom metadata', dexcomService ? 'Service match' : 'Name candidate', dexcomService ? `Advertised Dexcom service ${dexcomService}.` : `Name ${device.name} matches a published Dexcom naming pattern.`, dexcomService ? 'dexcom' : 'dexcomName');
      field('Broadcast name', device.name || 'Not advertised'); field('Advertised services', services.join(', ') || 'None');
      result.limitations.push('Advertisements do not provide a validated glucose reading. Name-only matches are unconfirmed.');
    }
    const sleep = services.includes('09d23fae-90e6-44c2-95b6-0b3d0f1abf25') ? 'Fuzion' : services.includes('ffffd1fd-388d-938b-344a-939d1f6efee0') ? 'MCR' : '';
    if (sleep) {
      set('sleep', `Sleep Number ${sleep}`, 'Service match', `Advertised documented Sleep Number ${sleep} service.`, 'sleep'); field('Transport', sleep);
      result.limitations.push(sleep === 'Fuzion' ? 'Open the Sleep Number app for session-based configuration and firmness reads.' : 'Open the Sleep Number app to bind an MCR client and read firmness values.');
      result.limitations.push('Bed settings are separate from cloud sleep scores and health metrics.');
    }
    const recorders = typeof NanoRecorders !== 'undefined' ? NanoRecorders : typeof module !== 'undefined' ? require('./recorders.js') : null;
    const recorder = recorders?.identify(device);
    if (recorder) { Object.assign(result, { category: 'recorder', title: recorder.product, confidence: 'Protocol match', evidence: [recorder.summary], fields: [], sources: [], limitations: ['Open the matching app for authenticated file access.'] }); }
    const sensors = typeof NanoSensorProfiles !== 'undefined' ? NanoSensorProfiles : typeof module !== 'undefined' ? require('./sensor-profiles.js') : null;
    const sensor = sensors?.identify(device); if (sensor && result.category === 'other') return sensor;
    const samsungProtocol = typeof NanoSamsungProtocol !== 'undefined' ? NanoSamsungProtocol : typeof module !== 'undefined' ? require('./samsung-protocol.js') : null;
    const samsungProfile = samsungProtocol?.identify(device); if (samsungProfile && result.category === 'other') return samsungProfile;
    if (result.category === 'other') {
      const library = typeof NanoDeviceLibrary !== 'undefined' ? NanoDeviceLibrary : typeof module !== 'undefined' ? require('./device-library.js') : null;
      const samsung = library?.match(device).find(entry => entry.id === 'samsung-device');
      if (samsung) {
        Object.assign(result, { category: 'vendor', title: samsung.title, confidence: samsung.confidence, evidence: [samsung.evidence], sources: samsung.sources, limitations: [samsung.limitations] });
        field(samsung.confidence === 'Name candidate' ? 'Manufacturer candidate' : 'Assigned company', 'Samsung Electronics'); field('Advertised services', services.join(', ') || 'None');
      }
    }
    if (result.category === 'other') {
      const apps = typeof NanoDeviceApps !== 'undefined' ? NanoDeviceApps : typeof module !== 'undefined' ? require('./device-apps.js') : null;
      const profile = apps?.identify(device); if (profile) return profile;
      result.evidence.push('No supported device profile matched.'); field('Advertised services', services.join(', ') || 'None');
    }
    return result;
  }
  function catalog() {
    return [
      { category: 'tracker', title: 'BLE trackers', description: 'Find My envelopes and Tile service matches.' },
      { category: 'beacon', title: 'Beacons', description: 'iBeacon identity and Eddystone telemetry.' },
      { category: 'medical', title: 'Dexcom metadata', description: 'Broadcast names, services, and match evidence.' },
      { category: 'sleep', title: 'Sleep Number', description: 'Fuzion and MCR identification; paired Fuzion queries.' },
      { category: 'sensor', title: 'Environmental sensors', description: 'BTHome v2 and Ruuvi measurements from broadcasts.' },
      { category: 'recorder', title: 'Recorders', description: 'PLAUD and Pocket protocol identification.' },
      { category: 'vendor', title: 'Vendor broadcasts', description: 'Apple, Samsung, and LG manufacturer evidence and decoded broadcast fields.' },
      { category: 'appliance', title: 'Home appliances', description: 'Nespresso, Levoit, and LG device identification, saved responses, and command previews.' },
      { category: 'other', title: 'BLE metadata', description: 'Advertising structures and unclassified devices.' }
    ];
  }
  return { identify, advertisement, catalog };
})();
if (typeof module !== 'undefined') module.exports = NanoProfiles;
