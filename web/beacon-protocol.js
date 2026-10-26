'use strict';

const NanoBeaconProtocol = (() => {
  const base = 'https://github.com/google/eddystone/blob/bb8738d7ddac0ddd3dfa70e594d011a0475e763d/';
  const sources = [{ title: 'Eddystone configuration service', url: base + 'configuration-service/README.md' }, { title: 'Eddystone frame formats', url: base + 'protocol-specification.md' }];
  const service = 'a3c87500-8ed3-4bdf-8a39-a01bebede295', characteristic = index => `a3c875${index.toString(16).padStart(2, '0')}-8ed3-4bdf-8a39-a01bebede295`;
  const normalize = value => String(value || '').toLowerCase().replace(/^0x/, '').replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  const profiles = () => typeof module !== 'undefined' ? require('./profiles.js') : NanoProfiles;
  const field = (label, value) => ({ label, value: String(value) });
  const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  function bytes(value) {
    if (typeof value !== 'string' || value.length > 1024 || !/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('Enter complete HEX bytes, up to 512 bytes.');
    return Uint8Array.from(value.match(/../g) || [], value => parseInt(value, 16));
  }
  const services = device => (Array.isArray(device?.services) ? device.services : []).map(normalize);
  const canPrepare = device => services(device).some(value => [service, 'feaa'].includes(value)) || (Array.isArray(device?.serviceData) ? device.serviceData : []).some(item => normalize(item?.uuid) === 'feaa');
  function identify(device) {
    if (!device || typeof device !== 'object') return null;
    const config = services(device).includes(service), manufacturer = String(device.manufacturer || '').toLowerCase();
    const broadcast = canPrepare(device) && !config || services(device).some(value => ['feed', 'feec', 'feaa'].includes(value)) || /^(?:4c000215[0-9a-f]{42}|4c001219[0-9a-f]{50})$/.test(manufacturer) || (Array.isArray(device.serviceData) ? device.serviceData : []).some(item => normalize(item?.uuid) === 'feaa');
    if (broadcast) {
      const result = profiles().identify(device);
      if (['beacon', 'tracker'].includes(result.category)) return { ...result, sources: [...result.sources, ...sources] };
    }
    if (!config) return null;
    return { title: 'Eddystone configuration service', category: 'beacon', confidence: 'Service match', evidence: ['Advertised Eddystone configuration service UUID.'], fields: [field('Configuration service', service)], limitations: ['Configuration requires the beacon’s unlock procedure and the capabilities of its current firmware.'], sources };
  }
  function decodeService(uuid, value) {
    if (normalize(uuid) !== 'feaa') return [];
    bytes(value);
    return profiles().identify({ serviceData: [{ uuid: 'feaa', hex: value }] }).fields;
  }
  function decode(uuid, value) {
    const id = Array.from({ length: 12 }, (_, i) => characteristic(i + 1)).indexOf(normalize(uuid)) + 1;
    if (!id) return [];
    const data = bytes(value), view = new DataView(data.buffer), exact = size => { if (data.length !== size) throw new Error(`This characteristic requires ${size} bytes.`); };
    if (id === 1) {
      if (data.length < 7) throw new Error('Capabilities require at least 7 bytes.');
      if (data[0] !== 0) return [field('Configuration version', data[0]), field('Unsupported capabilities HEX', value)];
      const types = view.getUint16(4), powers = Array.from(data.slice(6), byte => byte > 127 ? byte - 256 : byte);
      return [field('Configuration version', data[0]), field('Total slots', data[1]), field('EID slots', data[2]), field('Per-slot interval', data[3] & 1 ? 'Supported' : 'Global'), field('Per-slot TX power', data[3] & 2 ? 'Supported' : 'Global'), field('Supported frame types', ['UID', 'URL', 'TLM', 'EID'].filter((_, i) => types & 1 << i).join(', ') || 'None'), field('Supported radio powers', powers.map(power => `${power} dBm`).join(', ')), field('Reserved capability bits', `0x${(data[3] & 0xfc).toString(16)} / 0x${(types & 0xfff0).toString(16)}`)];
    }
    if ([2, 4, 5, 6, 12].includes(id)) {
      exact(1);
      if (id === 2) return [field('Active slot', data[0])];
      if ([4, 5].includes(id)) return [field(id === 4 ? 'Radio TX power' : 'Advertised TX power', `${view.getInt8(0)} dBm`)];
      if (id === 6) return [field('Lock state', ['Locked', 'Unlocked', 'Unlocked; automatic relocking disabled'][data[0]] || `Unknown (${data[0]})`)];
      return [field('Can become non-connectable', data[0] ? 'Yes' : 'No')];
    }
    if (id === 3) { exact(2); return [field('Advertising interval', `${view.getUint16(0)} ms`)]; }
    if (id === 7) { exact(16); return [field('Unlock challenge HEX', value), field('Unlock operation', 'AES-128-ECB of this challenge using the authorized lock code')]; }
    if (id === 8) { exact(32); return [field('Public ECDH key HEX', value)]; }
    if (id === 9) { exact(16); return [field('Encrypted identity key', '16-byte protected value')]; }
    if (id === 10) {
      if (!data.length || data.length === 1 && data[0] === 0) return [field('Slot state', 'Not broadcasting')];
      if (data[0] === 0x30) { exact(14); return [field('Slot frame', 'EID'), field('Rotation exponent', data[1]), field('Beacon clock', `${view.getUint32(2)} seconds`), field('Ephemeral identifier', hex(data.slice(6)))]; }
      const fields = decodeService('feaa', value); if (!fields.length) throw new Error('Unsupported or incomplete slot data.'); return fields;
    }
    return [];
  }
  const numeric = (id, label, min, max, value) => ({ id, label, type: 'number', min, max, step: 1, default: value });
  const slot = numeric('slot', 'Slot index', 0, 254, 0);
  const commands = [
    { id: 'select-slot', label: 'Select active slot', inputs: [slot] },
    { id: 'interval', label: 'Set advertising interval', inputs: [slot, numeric('milliseconds', 'Interval (ms)', 1, 65535, 1000)] },
    { id: 'radio-power', label: 'Set radio TX power', inputs: [slot, numeric('power', 'Requested radio power (dBm)', -128, 127, -20)] },
    { id: 'advertised-power', label: 'Set advertised TX calibration', inputs: [slot, numeric('power', 'Calibrated power at 0 m (dBm)', -128, 127, -20)] },
    { id: 'uid', label: 'Configure UID slot', inputs: [slot, { id: 'namespace', label: 'Namespace (20 HEX characters)', type: 'text', default: '' }, { id: 'instance', label: 'Instance (12 HEX characters)', type: 'text', default: '' }] },
    { id: 'telemetry', label: 'Configure telemetry slot', inputs: [slot] },
    { id: 'clear-slot', label: 'Clear slot', inputs: [slot] },
    { id: 'remain-connectable', label: 'Set connectable behavior', inputs: [{ id: 'enabled', label: 'Remain connectable', type: 'select', default: '1', options: [{ value: '1', label: 'Yes' }, { value: '0', label: 'Resume normal behavior after disconnect' }] }] },
    { id: 'lock', label: 'Lock configuration', inputs: [] },
  ].map(command => ({ ...command, description: 'Prepare Eddystone configuration writes for an unlocked beacon. This app does not send them.' }));
  function integer(value, min, max, label) { if (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`); return Number(value); }
  function buildCommand(id, values = {}) {
    const command = commands.find(item => item.id === id); if (!command) throw new Error('Unsupported Eddystone operation.');
    if (!canPrepare(values.device)) throw new Error('Choose an Eddystone beacon or configuration service.');
    const writes = [], add = (index, bytes) => writes.push({ service, characteristic: characteristic(index), response: true, hex: bytes });
    const slotNumber = command.inputs.some(input => input.id === 'slot') ? integer(values.slot, 0, 254, 'Slot index') : null;
    if (slotNumber !== null) add(2, slotNumber.toString(16).padStart(2, '0'));
    if (id === 'interval') add(3, integer(values.milliseconds, 1, 65535, 'Interval').toString(16).padStart(4, '0'));
    if (['radio-power', 'advertised-power'].includes(id)) add(id === 'radio-power' ? 4 : 5, (integer(values.power, -128, 127, 'Power') & 255).toString(16).padStart(2, '0'));
    if (id === 'uid') { if (!/^[0-9a-f]{20}$/i.test(values.namespace) || !/^[0-9a-f]{12}$/i.test(values.instance)) throw new Error('UID needs a 10-byte namespace and 6-byte instance.'); add(10, `00${values.namespace}${values.instance}`.toLowerCase()); }
    if (id === 'telemetry') add(10, '20');
    if (id === 'clear-slot') add(10, '00');
    if (id === 'remain-connectable') add(12, integer(values.enabled, 0, 1, 'Connectable behavior').toString(16).padStart(2, '0'));
    if (id === 'lock') add(6, '00');
    return { summary: command.label, transport: 'Eddystone Configuration GATT', offlineOnly: true, writes,
      prerequisites: ['Discover the configuration service and confirm its characteristic properties.', 'Complete the beacon’s authorized unlock procedure before writing.', 'Read capabilities: the slot must be below total slots, the frame type must be supported, and power/interval behavior can be global.'],
      warnings: [id === 'clear-slot' ? 'Clearing a slot stops its broadcasts and destroys any EID state for that slot.' : 'The device can clamp unsupported interval and power values.', 'Advertised TX calibration describes measured signal at 0 m; it is separate from the radio power setting.', 'No writes were sent. This plan is not an executable GATT recipe.'], sources };
  }
  return { identify, decode, decodeService, buildCommand, commands, canPrepare, sources, service: 'feaa', configurationService: service, characteristics: { status: characteristic(1) } };
})();
if (typeof module !== 'undefined') module.exports = NanoBeaconProtocol;
