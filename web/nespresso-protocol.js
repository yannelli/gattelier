'use strict';

const NanoNespressoProtocol = (() => {
  const suffix = '-f22a-11e3-9daa-0002a5d5c51b', uuid = part => `06aa${part}${suffix}`;
  const services = { basic: uuid('1910'), machine: uuid('1920'), settings: uuid('1940') };
  const characteristics = { profile: uuid('3a11'), status: uuid('3a12'), info: uuid('3a21'), serial: uuid('3a31'), auth: uuid('3a41'), pairing: uuid('3a51'), settings: uuid('3a44') };
  const sources = [
    { title: 'Vertuo models, GATT services and settings protocol', url: 'https://github.com/FezVrasta/ha-nespresso-smart/blob/61d68aaa867a93e8a73b2a41f816076faeb245a1/PROTOCOL.md' },
    { title: 'Vertuo manufacturer byte order and broadcast status', url: 'https://github.com/renaudallard/homeassistant_nespresso_smart/blob/87c94b385f00d444215bf4de242e83b55401f02a/custom_components/nespresso/ble/parsing.py#L127' },
    { title: 'Nespresso BLE characteristic parsing', url: 'https://github.com/joostlek/nespresso-ble/blob/de47d6d7e3068ab354887ecd7d29b02bb9439497/src/nespresso_ble/parsing.py' },
    { title: 'Vertuo water-hardness read-modify-write', url: 'https://github.com/FezVrasta/ha-nespresso-smart/blob/61d68aaa867a93e8a73b2a41f816076faeb245a1/custom_components/nespresso_smart/device.py#L508' }
  ];
  const models = { CV1: 'Vertuo Next', DV1: 'Vertuo Next', CV3: 'Vertuo Next', DV3: 'Vertuo Next', CV2: 'Vertuo Pop', DV2: 'Vertuo Pop', DV5: 'Vertuo Lattissima', CV5: 'Vertuo Creatista', CV6: 'Vertuo Pop+', DV6: 'Vertuo Pop+' };
  const states = { 0: 'Factory reset', 1: 'Heating', 2: 'Ready', 3: 'Descaling ready', 4: 'Brewing', 5: 'Cleaning', 6: 'Descaling', 7: 'Emptying', 8: 'Device error', 9: 'Power save', 10: 'Cooldown', 11: 'Service mode', 12: 'Standby', 13: 'Updating', 14: 'Rinsing', 17: 'Capsule reading', 18: 'Descale sequence decoding', 19: 'Tank empty', 20: 'Descaling paused', 21: 'Initializing', 22: 'Rinsing ready', 23: 'Maintenance menu', 26: 'Cleaning paused', 33: 'Emptying ready', 34: 'Cleaning ready', 35: 'Ready with old capsule', 36: 'Rinsing paused' };
  const pairing = ['None', 'Temporary', 'Final', 'Undefined'];
  const field = (label, value) => ({ label, value: String(value) });
  const hex = data => Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value !== 'string' || value.length > 1024 || !/^(?:[\da-f]{2})+$/i.test(value.replace(/\s/g, ''))) throw new Error('Enter complete Nespresso HEX bytes.');
    return Uint8Array.from(value.replace(/\s/g, '').match(/../g), part => parseInt(part, 16));
  }
  function identity(device = {}) {
    const name = typeof device.name === 'string' ? device.name : '';
    const code = /^(?:Vertuo[_ -])?(CV[12356]|DV[12356])(?:[_ -]|$)/i.exec(name)?.[1]?.toUpperCase();
    const original = /^(?:Prodigio|Expert|Blue)(?:[_ -]|$)/i.test(name);
    const service = (Array.isArray(device.services) ? device.services : []).some(item => String(typeof item === 'string' ? item : item?.uuid).toLowerCase() === services.basic);
    let manufacturer = null;
    try { manufacturer = bytes(device.manufacturer); } catch {}
    const company = manufacturer?.length >= 2 && (manufacturer[0] === 2 && manufacturer[1] === 0x25 || manufacturer[0] === 0x25 && manufacturer[1] === 2);
    return { code: models[code] ? code : null, original, service, manufacturer, company, vertuo: !original && Boolean(models[code] || /^Vertuo[_ -]/i.test(name) || /^Venus(?:[_ -]|$)/i.test(name)) };
  }
  function status(data) {
    if (data.length < 3 || data.length > 8) return [];
    const state = (data[1] & 15) | (data[2] & 0xf0);
    const fields = [field('Vertuo machine state', states[state] || `Unrecognized (${state})`), field('State code', state), field('Pairing key state', pairing[data[0] >> 5 & 3])];
    for (const [label, offset, mask] of [['Water tank empty', 0, 1], ['Cleaning needed', 0, 2], ['Descaling needed', 0, 4], ['Error reported', 0, 16], ['Bootloader active', 0, 128], ['Brewing unit closed', 1, 128], ['Capsule container full', 1, 64]]) fields.push(field(label, data[offset] & mask ? 'Yes' : 'No'));
    fields.push(field('Raw status', hex(data))); return fields;
  }
  function decode(characteristic, value, context = {}) {
    let data;
    try { data = bytes(value); } catch { return []; }
    const key = String(characteristic).toLowerCase(), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (context.family && context.family !== 'vertuo') return [];
    if (context.device && !identity(context.device).vertuo) return [];
    if (key === characteristics.status) return status(data);
    if (key === characteristics.pairing && data.length === 1) return [field('Pairing key state', pairing[data[0]] || `Unrecognized (${data[0]})`)];
    if (key === characteristics.profile && [2, 4].includes(data.length)) {
      const number = view.getUint16(0); return [field('Profile version', `${Math.floor(number / 100)}.${number % 100}`)];
    }
    if (key === characteristics.settings && data.length === 4) return [field('Auto power-off time (raw)', view.getUint16(0, true)), field('Water hardness level', data[2] <= 4 ? data[2] : `Unrecognized (${data[2]})`), field('Standby time (raw)', data[3]), field('Current settings HEX', hex(data))];
    if (key === characteristics.info && data.length === 16) {
      const fields = [];
      for (const [label, offset] of [['Hardware version', 0], ['Bootloader version', 2], ['Firmware version', 4], ['Recipe database version', 6]]) {
        const number = view.getUint16(offset); fields.push(field(label, `${Math.floor(number / 100)}.${number % 100}`));
      }
      const version = view.getUint16(8);
      fields.push(field('Connectivity firmware', `${Math.floor(version / 10000)}.${Math.floor(version % 10000 / 100)}.${version % 100}`), field('Device address', Array.from(data.slice(10), byte => byte.toString(16).padStart(2, '0')).join(':')));
      return fields;
    }
    if (key === characteristics.serial && data.length <= 64) {
      try {
        const serial = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\0+$/, '');
        return serial && !/[\u0000-\u001f\u007f-\u009f]/.test(serial) ? [field('Serial number', serial)] : [];
      } catch { return []; }
    }
    return [];
  }
  function identify(device) {
    if (!device || typeof device !== 'object') return null;
    const match = identity(device);
    if (!match.service && !match.company && !match.vertuo) return null;
    const result = { category: 'appliance', title: match.original ? 'Nespresso OriginalLine candidate' : match.vertuo ? 'Nespresso Vertuo' : 'Nespresso BLE family', family: match.vertuo ? 'vertuo' : match.original ? 'original' : 'unconfirmed',
      confidence: match.service ? 'Service match' : match.company ? 'Manufacturer match' : 'Name candidate', evidence: [], fields: [], limitations: ['The shared 06AA service alone does not establish a Vertuo model. Protected reads and settings require BLE security and the authorized 8-byte CMID key.'], sources: sources.map(source => ({ ...source })) };
    if (match.service) result.evidence.push(`Advertised Nespresso service ${services.basic}.`);
    if (match.company) result.evidence.push('Manufacturer bytes match the documented Nespresso company encoding or its on-wire byte-swapped form.');
    if (match.code) { result.modelCode = match.code; result.fields.push(field('Model candidate', models[match.code]), field('Model code', match.code)); result.evidence.push(`Broadcast name contains documented model prefix ${match.code}.`); }
    if (match.vertuo && match.company && !device.payloadTruncated) {
      const decoded = status(match.manufacturer.slice(2));
      if (decoded.length) result.fields.push(...decoded);
      else result.limitations.push('Manufacturer status payload is incomplete or has an unsupported length.');
    }
    if (device.payloadTruncated) result.limitations.push('Advertisement was truncated; status bytes were not decoded.');
    result.limitations.push('Remote brewing is not implemented for Vertuo. Expert/Prodigio brew packets do not establish Vertuo compatibility.');
    return result;
  }
  const compatibility = { family: 'vertuo', modelCodes: Object.keys(models), evidence: sources[0].url, requiresAuthentication: true, hardwareValidated: false };
  const commands = [
    { id: 'authenticate', label: 'Authenticate with CMID key', sensitive: true, description: 'Encode the existing authorized 8-byte key for this Vertuo connection. The key is secret.', compatibility,
      inputs: [{ id: 'authKey', label: 'Authorized CMID key (16 HEX characters)', type: 'password', default: '' }] },
    { id: 'water-hardness', label: 'Set water hardness', description: 'Preserve the supplied settings record and replace only water hardness. Authenticate the connection first.', compatibility,
      inputs: [{ id: 'currentSettings', label: 'Current settings HEX', type: 'text', default: '' }, { id: 'level', label: 'Water hardness level', type: 'select', options: [0, 1, 2, 3, 4].map(value => ({ value: String(value), label: String(value) })), default: '2' }] }
  ];
  function buildCommand(id, values = {}) {
    if (!commands.some(command => command.id === id)) throw new Error('Unsupported Nespresso command.');
    const match = identity(values.device);
    if (!match.vertuo || !match.code || !match.service) throw new Error('This command requires a documented Vertuo model name and its 06AA basic service.');
    const warnings = ['This preview is based on public protocol source. Device execution and firmware compatibility have not been validated.'];
    if (id === 'authenticate') {
      const key = bytes(values.authKey);
      if (key.length !== 8 || key[0] >> 4 !== 8) throw new Error('Enter an authorized 8-byte CMID key beginning with HEX 8.');
      return { summary: 'Authenticate the selected Vertuo with its existing CMID key', sensitive: true, compatibility: { ...compatibility }, warnings: [...warnings, 'Keep this key out of saved recipes, exports and traffic logs. BLE bonding/encryption is required.'],
        steps: [{ action: 'write', service: services.basic, uuid: characteristics.auth, hex: hex(key), response: true, sensitive: true }] };
    }
    const current = bytes(values.currentSettings), level = values.level;
    if (current.length !== 4) throw new Error('Current settings must be the complete 4-byte GeneralUserSettings value.');
    if (!(typeof level === 'number' || typeof level === 'string' && /^[0-4]$/.test(level)) || !Number.isInteger(Number(level)) || Number(level) < 0 || Number(level) > 4) throw new Error('Water hardness must be an integer from 0 to 4.');
    const updated = current.slice(); updated[2] = Number(level);
    return { summary: `Set Vertuo water hardness to ${Number(level)}`, compatibility: { ...compatibility }, warnings: [...warnings, 'Use a fresh settings value from this machine. Auto power-off and standby bytes are preserved; a stale record overwrites their newer values.', 'Authenticate this connection with the authorized CMID key before writing settings.'],
      steps: [{ action: 'write', service: services.settings, uuid: characteristics.settings, hex: hex(updated), response: true }] };
  }
  return { identify, decode, buildCommand, commands, compatibility, sources, services, characteristics };
})();
if (typeof module !== 'undefined') module.exports = NanoNespressoProtocol;
