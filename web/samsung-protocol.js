'use strict';

const NanoSamsungProtocol = (() => {
  const utag = 'https://github.com/KieronQuinn/uTag/blob/f46375a9c2af6de4c8678f6aba7b91972054ae74/app/src/main/java/com/kieronquinn/app/utag/';
  const sources = [
    { title: 'uTag Offline Finding service-data decoder', url: utag + 'repositories/SmartTagRepository.kt#L505' },
    { title: 'uTag battery bands', url: utag + 'model/BatteryLevel.kt' },
    { title: 'ESPresense Samsung company and SmartTag service matching', url: 'https://github.com/ESPresense/ESPresense/blob/d6107ab14f8061bd41490f2ddb253616647c23bd/lib/BleFingerprint/BleFingerprint.cpp#L269' }
  ];
  const service = '0000fd5a-0000-1000-8000-00805f9b34fb';
  const states = { 1: 'Recently disconnected', 2: 'Offline', 3: 'Long-term offline', 4: 'Connected to owner', 5: 'Connected to a non-owner', 6: 'Two connections' };
  const battery = ['Very low', 'Low', 'Medium', 'Full'];
  const hex = data => Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
  const field = (label, value) => ({ label, value: String(value) });
  const yesNo = value => value ? 'Yes' : 'No';
  const isService = uuid => typeof uuid === 'string' && ['fd5a', '0xfd5a', service].includes(uuid.toLowerCase());
  function bytes(value) {
    if (value instanceof Uint8Array && value.length <= 1650) return value;
    if (typeof value !== 'string' || value.length > 3300 || !/^(?:[\da-f]{2})*$/i.test(value)) return null;
    return Uint8Array.from(value.match(/../g) || [], part => parseInt(part, 16));
  }
  function decodeServiceData(value) {
    const data = bytes(value), fields = [], limitations = [];
    if (!data) return { decoded: false, fields, limitations: ['Offline Finding data is not complete HEX bytes.'] };
    fields.push(field('Offline Finding frame HEX', hex(data)), field('Offline Finding frame length', `${data.length} bytes`));
    if (data.length !== 20) return { decoded: false, fields, limitations: ['Offline Finding decoding requires the complete 20-byte registered-tag format.'] };
    const version = data[0] >> 4;
    fields.push(field('Offline Finding version', version));
    if (version !== 1) return { decoded: false, fields, limitations: [`Offline Finding version ${version} has no supported field layout.`] };
    const state = data[0] & 7, flags = data[12];
    fields.push(field('Reported tag state', states[state] || `Unrecognized (${state})`), field('Tag state code', state),
      field('Advertisement type bit', (data[0] >> 3) & 1), field('Aging counter (raw)', data[1] | data[2] << 8 | data[3] << 16),
      field('Rotating privacy ID', hex(data.slice(4, 12))), field('Region code', flags >> 4), field('Battery band', battery[flags & 3]),
      field('UWB flag', yesNo(flags & 4)), field('Encryption flag', yesNo(flags & 8)), field('Motion detection flag', yesNo(data[13] & 0x80)),
      field('Activity tracking flag', yesNo(data[15] & 1)), field('Reserved bytes HEX', hex(data.slice(14, 16))), field('Signature HEX (unverified)', hex(data.slice(16, 20))));
    limitations.push('Battery is a four-band report, without a percentage. The aging counter is shown without converting it to a clock time.',
      'The rotating privacy ID does not establish a stable identity or ownership. Signature verification and location decryption are not implemented.');
    return { decoded: true, fields, limitations };
  }
  function decodeService(uuid, value) { return isService(uuid) ? decodeServiceData(value).fields : []; }
  function metadataMatch(device) {
    const library = typeof module !== 'undefined' ? require('./device-library.js') : typeof NanoDeviceLibrary === 'undefined' ? null : NanoDeviceLibrary;
    return library?.match(device).find(item => item.id === 'samsung-device');
  }
  function identify(device = {}) {
    if (!device || typeof device !== 'object') return null;
    const manufacturer = bytes(device.manufacturer), company = manufacturer?.length >= 2 && manufacturer[0] === 0x75 && manufacturer[1] === 0;
    const frames = (Array.isArray(device.serviceData) ? device.serviceData : []).filter(item => isService(item?.uuid));
    const advertised = frames.length > 0 || (Array.isArray(device.services) ? device.services : []).some(item => isService(typeof item === 'string' ? item : item?.uuid));
    const metadata = !company && !advertised ? metadataMatch(device) : null;
    if (!company && !advertised && !metadata) return null;
    const result = { category: advertised ? 'tracker' : 'vendor', title: advertised ? 'Samsung Offline Finding' : metadata ? 'Samsung device candidate' : 'Samsung BLE broadcast',
      confidence: advertised ? 'Service match' : metadata?.confidence || 'Manufacturer match', evidence: [], fields: [], limitations: [], sources: [...sources, ...(metadata?.sources || [])].map(item => ({ ...item })) };
    if (metadata) {
      result.evidence.push(metadata.evidence);
      result.fields.push(field('Samsung match evidence', metadata.evidence));
      result.limitations.push(metadata.models, metadata.limitations);
    }
    if (company) {
      result.evidence.push('Samsung company identifier 0x0075.');
      result.fields.push(field('Company identifier', '0x0075'), field('Manufacturer frame length', `${manufacturer.length} bytes`),
        field('Manufacturer payload prefix', hex(manufacturer.slice(2, 6))), field('Manufacturer payload HEX', hex(manufacturer.slice(2))));
      result.limitations.push('Samsung manufacturer payload is preserved without assigning a model, device category, battery, power state or writable service. The company identifier is shared across Samsung product families.');
    }
    if (advertised) result.evidence.push('Advertised Samsung Offline Finding service 0xFD5A.');
    if (advertised && !frames.length) result.limitations.push('No Offline Finding service-data bytes were captured.');
    for (const [index, frame] of frames.entries()) {
      const decoded = decodeServiceData(frame.hex);
      if (device.payloadTruncated) {
        result.fields.push(...decoded.fields.filter(item => /frame HEX|frame length/.test(item.label)));
      } else {
        result.fields.push(...decoded.fields.map(item => frames.length > 1 ? { ...item, label: `${item.label} (${index + 1})` } : item));
        result.limitations.push(...decoded.limitations);
        if (decoded.decoded) result.confidence = 'Decoded broadcast';
      }
    }
    if (device.payloadTruncated) result.limitations.push('The advertisement was truncated; Offline Finding status fields were not decoded.');
    result.limitations.push('Broadcasts are unauthenticated. Offline Finding bytes do not identify a SmartTag generation. No device control is implemented for this broadcast.');
    return result;
  }
  return { identify, decodeServiceData, decodeService, service, sources, commands: [] };
})();
if (typeof module !== 'undefined') module.exports = NanoSamsungProtocol;
