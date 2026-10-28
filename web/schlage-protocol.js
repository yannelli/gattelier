'use strict';

const NanoSchlage = (() => {
  const source = 'https://github.com/huguesb/schlage-uweave/blob/main/PROTOCOL.md';
  const transport = '883f45ec-14cb-46aa-9864-9a4e782b33d0';
  const rx = 'ff530c78-cd50-4bb9-bbd4-0712f32b3796', tx = '26002998-e001-4812-8c08-5cd2afda0830';
  const instance = 'e604e95d-a759-4817-87d3-aa005083a0d1';
  const services = {
    [transport]: ['Schlage uWeave', 'Authenticated command and response transport.'],
    '7f0dee73-4a3f-4103-98e6-a46cd301bdfb': ['Schlage service 7f0dee73', 'Observed in the BE489WB service table.'],
    '1f6b43aa-94de-4ba9-981c-da38823117bd': ['Schlage service 1f6b43aa', 'Observed in the BE489WB service table.']
  };
  const uuid = value => String(value || '').toLowerCase().replace(/^0x/, '').replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  const same = (a, b) => Boolean(a?.address && b?.address && a.address.toLowerCase() === b.address.toLowerCase() && a.addressType === b.addressType);
  const gatt = (device, state) => state?.ble?.connected && same(device, state.ble) ? state.services || [] : [];
  function text(hex) {
    if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2}){1,256}$/i.test(hex)) return '';
    return new TextDecoder().decode(Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16))).replace(/\0+$/, '').trim();
  }
  function identity(device, state = {}) {
    const fields = {}, names = { '2a24': 'model', '2a25': 'serial', '2a26': 'firmware', '2a27': 'hardware', '2a28': 'software', '2a29': 'manufacturer' };
    for (const service of gatt(device, state)) {
      if (uuid(service.uuid) !== '180a') continue;
      for (const characteristic of service.characteristics || []) {
        const key = names[uuid(characteristic.uuid)], value = text(characteristic.valueHex);
        if (key && value && !/^(?:Software|Hardware|Firmware) Revision$/i.test(value)) fields[key] = value;
      }
    }
    return fields;
  }
  function identify(device, state = {}) {
    if (!device) return null;
    const data = identity(device, state), discovered = gatt(device, state);
    const advertised = (device.services || []).map(item => uuid(typeof item === 'string' ? item : item.uuid));
    const service = [...advertised, ...discovered.map(item => uuid(item.uuid))].find(id => Object.hasOwn(services, id));
    const manufacturer = /^schlage$/i.test(data.manufacturer || '');
    const name = /^schlage(?:[ _-]|[0-9a-f]{8}$)/i.test(device.name || '');
    if (!service && !manufacturer && !name) return null;
    const family = /^be489/i.test(data.model || '') ? 'Schlage Encode' : /^be499/i.test(data.model || '') ? 'Schlage Encode Plus' : 'Schlage';
    return { title: family, identity: data, evidence: manufacturer ? 'Device Information' : service ? 'Schlage service' : 'Broadcast name', service, modelConfirmed: Boolean(manufacturer && data.model) };
  }
  function lookup(value, serviceUuid = '') {
    const id = uuid(value), parent = uuid(serviceUuid);
    if (Object.hasOwn(services, id)) return { name: services[id][0], description: services[id][1], source: id === transport ? source : '' };
    if (parent === transport && id === rx) return { name: 'uWeave commands', description: 'Client to lock; authenticated uWeave messages.', source };
    if (parent === transport && id === tx) return { name: 'uWeave responses', description: 'Lock to client; fragmented uWeave indications.', source };
    if (Object.hasOwn(services, parent) && id === instance) return { name: 'Service instance ID', description: '16-bit service identifier.', source: 'https://pyhomekit.readthedocs.io/en/latest/_modules/pyhomekit/constants.html' };
    return null;
  }
  function decode(value, hex, { serviceUuid = '' } = {}) {
    const id = uuid(value), parent = uuid(serviceUuid);
    if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2}){1,512}$/i.test(hex)) return [];
    const bytes = Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
    if (Object.hasOwn(services, parent) && id === instance && bytes.length === 2) return [{ label: 'Service instance ID', value: String(bytes[0] | bytes[1] << 8) }];
    if (parent !== transport || ![rx, tx].includes(id)) return [];
    const control = Boolean(bytes[0] & 128);
    return [
      { label: 'Direction', value: id === rx ? 'Client to lock' : 'Lock to client' },
      { label: 'uWeave packet', value: control ? 'Control' : 'Data fragment' },
      { label: 'Sequence', value: String((bytes[0] >> 4) & 7) },
      ...(control ? [{ label: 'Control opcode', value: `0x${(bytes[0] & 15).toString(16)}` }] : [{ label: 'Fragment', value: bytes[0] & 8 ? bytes[0] & 4 ? 'Complete message' : 'First' : bytes[0] & 4 ? 'Last' : 'Continuation' }]),
      { label: 'Payload length', value: `${bytes.length - 1} bytes` }
    ];
  }
  return { identify, identity, lookup, decode, same, gatt, uuid, transport, rx, tx, source };
})();
if (typeof module !== 'undefined') module.exports = NanoSchlage;
