'use strict';

const NanoBoseProtocol = (() => {
  const bozo = 'https://github.com/NerdySouth/bozo/blob/db07cad042093a4abcfb37c3f31ab6ace6137d4a/';
  const connect = 'https://github.com/kaledcorona/bose-connect/blob/a6bfffbc8c1d316153d95ca4d7dac7911c54f492/src/';
  const sig = 'https://bitbucket.org/bluetooth-SIG/public/src/e7f76d7c5e2edced4872a352ff4a300610ac8212/assigned_numbers/';
  const sources = [
    { title: 'QC Ultra Gen1 tested BLE scope', url: bozo + 'README.md#L70' },
    { title: 'BMAP BLE framing, messages and errors', url: bozo + 'docs/BMAP.md' },
    { title: 'Secure and unsecure characteristic selection', url: bozo + 'crates/bozod/src/ble/connection.rs' },
    { title: 'BMAP QC Ultra identity fixture', url: connect + 'fixtures.rs#L163' },
    { title: 'BMAP identity, battery and volume field codecs', url: connect + 'codec.rs' },
    { title: 'QC Ultra standby requests', url: bozo + 'crates/bozo-proto/src/protocol/standby.rs' },
    { title: 'QC Ultra audio-mode requests', url: bozo + 'crates/bozo-proto/src/protocol/audio_modes.rs' },
    { title: 'QC Ultra power requests', url: bozo + 'crates/bozo-proto/src/protocol/power.rs' },
    { title: 'Bluetooth SIG company identifiers', url: sig + 'company_identifiers/company_identifiers.yaml' },
    { title: 'Bluetooth SIG member UUIDs', url: sig + 'uuids/member_uuids.yaml' }
  ];
  const service = '0000febe-0000-1000-8000-00805f9b34fb';
  const characteristics = { secure: 'c65b8f2f-aee2-4c89-b758-bc4892d6f2d8', unsecure: 'd417c028-9818-4354-99d1-2ac09d074591', status: 'd417c028-9818-4354-99d1-2ac09d074591' };
  const operators = ['Set', 'Get', 'SetGet', 'Status', 'Error', 'Start', 'Result', 'Processing'];
  const errors = ['Unknown', 'Invalid length', 'Invalid checksum', 'Function block unsupported', 'Function unsupported', 'Operator unsupported', 'Invalid data', 'Data unavailable', 'Runtime error', 'Timeout', 'Invalid state', 'Device not found', 'Busy'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const field = (label, value) => ({ label, value: String(value) });
  const hex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
  const uuid = value => typeof value === 'string' ? value.toLowerCase().replace(/^0x/, '').replace(/^0000([\da-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1') : '';
  function bytes(value) {
    if (typeof value !== 'string' || value.length > 8192 || !/^(?:[\da-f]{2})+$/i.test(value)) throw new Error('Enter complete BMAP HEX bytes.');
    return Uint8Array.from(value.match(/../g), part => parseInt(part, 16));
  }
  const maxName = device => /\bSoundLink[ _-]+Max\b/i.test(typeof device?.name === 'string' ? device.name : '');
  function identify(device) {
    if (!object(device)) return null;
    const manufacturer = typeof device.manufacturer === 'string' && device.manufacturer.length <= 3300 && /^(?:[\da-f]{2}){2,}$/i.test(device.manufacturer) ? device.manufacturer.toLowerCase() : '';
    const company = manufacturer.startsWith('9e00'), named = /^(?:LE[ _-]+)?Bose(?:\b|[ _-])/i.test(typeof device.name === 'string' ? device.name : '');
    const advertised = [...(Array.isArray(device.services) ? device.services : []), ...(Array.isArray(device.serviceData) ? device.serviceData : [])].some(item => uuid(typeof item === 'string' ? item : item?.uuid) === 'febe');
    if (!company && !named && !advertised) return null;
    const result = { title: maxName(device) ? 'Bose SoundLink Max candidate' : 'Bose BMAP candidate', category: 'vendor', family: 'unconfirmed',
      confidence: advertised ? 'Service match' : company ? 'Manufacturer match' : 'Name candidate', evidence: [], fields: [], limitations: [], sources: sources.map(source => ({ ...source })) };
    if (company) { result.evidence.push('Company 0x009E is assigned to Bose Corporation.'); result.fields.push(field('Bluetooth company', 'Bose Corporation (0x009E)'), field('Manufacturer payload HEX', manufacturer.slice(4))); }
    if (advertised) { result.evidence.push('Advertised Bose-assigned service 0xFEBE.'); result.fields.push(field('Bose service', '0xFEBE')); }
    if (named) result.evidence.push(`Broadcast name: ${device.name}`);
    result.fields.push(field('Documented reference model', 'QuietComfort Ultra Headphones (Gen 1)'));
    result.limitations.push('Bose company, service and name matches do not establish a model or BMAP payload layout. Manufacturer data remains uninterpreted.',
      'QC Ultra Gen 1 command templates are unavailable for SoundLink Max.',
      'Saved captures are decoded locally. No connection, subscription, pairing, authentication or device execution is implemented.');
    if (device.payloadTruncated) result.limitations.push('The advertisement was truncated; manufacturer bytes are incomplete.');
    return result;
  }
  function parse(value) {
    const data = bytes(value), packets = [], failures = [];
    for (let offset = 0; offset < data.length;) {
      if (data.length - offset < 4) { failures.push(`Incomplete BMAP header at byte ${offset}.`); break; }
      const length = data[offset + 3], end = offset + 4 + length;
      if (end > data.length) { failures.push(`Frame at byte ${offset} declares ${length} payload bytes; ${data.length - offset - 4} remain.`); break; }
      const flags = data[offset + 2];
      packets.push({ block: data[offset], function: data[offset + 1], operator: flags & 15, device: flags >> 6, port: flags >> 4 & 3, payload: data.slice(offset + 4, end), hex: hex(data.slice(offset, end)) });
      offset = end;
    }
    return { packets, errors: failures, hex: hex(data) };
  }
  function modelEvidence(value) {
    const parsed = parse(value);
    return !parsed.errors.length && parsed.packets.some(packet => packet.block === 0 && packet.function === 3 && packet.operator === 3 && !packet.device && !packet.port && packet.payload.length === 3 && packet.payload[0] === 0x40 && packet.payload[1] === 0x66);
  }
  function reassemble(values) {
    if (!Array.isArray(values) || !values.length || values.length > 16) throw new Error('Provide 1 to 16 BLE segments in capture order.');
    const segments = values.map(bytes), last = segments[0][0] >> 4;
    if (segments.length !== last + 1) throw new Error('Incomplete BLE segment set.');
    const data = [];
    for (const [index, segment] of segments.entries()) {
      if (segment.length < 2 || segment.length > 20 || segment[0] !== (last << 4 | index)) throw new Error('BLE segment headers, order or lengths are inconsistent.');
      if (index < last && segment.length !== 20) throw new Error('Nonfinal BLE segments must carry 19 BMAP bytes.');
      data.push(...segment.slice(1));
    }
    return hex(data);
  }
  function packetFields(packet, reference) {
    const payload = packet.payload, fields = [];
    if (packet.operator === 4) { if (payload.length) fields.push(field('BMAP error', `${errors[payload[0]] || 'Unmapped'} (0x${hex(payload.slice(0, 1))})`)); return fields; }
    if (packet.operator !== 3) return fields;
    if (packet.block === 0 && packet.function === 3 && payload.length === 3) fields.push(field('Product ID', `0x${hex(payload.slice(0, 2))}`), field('Product variant index', payload[2]));
    if (!reference) return fields;
    if (packet.block === 1 && packet.function === 2 && payload.length) {
      const data = payload[0] === 0 ? payload.slice(1) : payload;
      try {
        const name = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\0+$/, '');
        if (name && !/[\u0000-\u001f\u007f]/.test(name)) fields.push(field('Reported device name', name));
      } catch {}
    }
    if (packet.block === 2 && packet.function === 2 && payload.length && payload.length % 4 === 0) {
      for (let offset = 0; offset < payload.length; offset += 4) {
        const component = payload[offset + 3];
        fields.push(field(`Component ${component} battery`, payload[offset] <= 100 ? `${payload[offset]}%` : `Unrecognized (${payload[offset]})`), field(`Component ${component} battery auxiliary HEX`, hex(payload.slice(offset + 1, offset + 3))));
      }
    }
    if (packet.block === 1 && packet.function === 4 && payload.length) fields.push(field('Standby timer', payload[0] === 0 ? 'Disabled' : `${payload[0]} minutes`));
    if (packet.block === 0x1f && packet.function === 3 && payload.length === 1) fields.push(field('Audio mode index', payload[0]));
    if (packet.block === 5 && packet.function === 5 && payload.length === 2) fields.push(field('Volume scale byte', payload[0]), field('Volume position byte', payload[1]));
    return fields;
  }
  function inspect(value, context = {}) {
    const parsed = parse(value), reference = context.model === 'qc-ultra-1' || context.identityHex && modelEvidence(context.identityHex) || parsed.packets.some(packet => packet.block === 0 && packet.function === 3 && packet.operator === 3 && !packet.device && !packet.port && packet.payload.length === 3 && hex(packet.payload.slice(0, 2)) === '4066');
    const fields = [field('Captured BMAP HEX', parsed.hex), field('Applied payload layout', reference ? 'QC Ultra Gen 1 reference' : 'Envelope fields only; model unconfirmed')];
    for (const [index, packet] of parsed.packets.entries()) {
      const prefix = `Frame ${index + 1}`;
      fields.push(field(`${prefix} address`, `${hex([packet.block])}/${hex([packet.function])}`), field(`${prefix} operator`, operators[packet.operator] || `Unmapped (${packet.operator})`), field(`${prefix} device / port`, `${packet.device} / ${packet.port}`), field(`${prefix} payload length`, packet.payload.length), field(`${prefix} payload HEX`, hex(packet.payload)));
      fields.push(...packetFields(packet, reference && !packet.device && !packet.port).map(item => ({ ...item, label: `${prefix} ${item.label}` })));
    }
    fields.push(...parsed.errors.map((message, index) => field(`Frame error ${index + 1}`, message)));
    return fields;
  }
  function decode(characteristic, value, context = {}) {
    const id = typeof characteristic === 'string' ? characteristic.toLowerCase() : '';
    if (![characteristics.secure, characteristics.unsecure].includes(id)) return [];
    const fields = [field('Captured characteristic variant', id === characteristics.secure ? 'Secure-labelled BMAP characteristic' : 'Unsecure-labelled BMAP characteristic'), field('Captured BLE segment HEX', hex(bytes(value)))];
    try { return [...fields, ...inspect(reassemble([value]), context)]; }
    catch (error) { return [...fields, field('BLE frame error', error.message)]; }
  }
  function decodeStatus(value) {
    if (!object(value) || !['bmap', 'ble-segments'].includes(value.format)) throw new Error('Use a BMAP capture object with format bmap or ble-segments.');
    if (value.model !== undefined && !['unconfirmed', 'qc-ultra-1'].includes(value.model)) throw new Error('Unsupported Bose reference model.');
    if (value.format === 'bmap') return inspect(value.hex, value);
    const raw = Array.isArray(value.segments) ? value.segments.map(bytes).map(hex).join(' / ') : '';
    try { return [field('Captured BLE segments HEX', raw), ...inspect(reassemble(value.segments), value)]; }
    catch (error) { return [field('Captured BLE segments HEX', raw), field('BLE frame error', error.message)]; }
  }
  const inputs = () => [
    { id: 'identityHex', label: 'Captured raw BMAP product-ID response (QC Ultra Gen1 0x4066)', type: 'text', default: '' },
    { id: 'characteristic', label: 'Observed BMAP characteristic', type: 'select', options: [{ value: characteristics.unsecure, label: 'Unsecure-labelled UUID' }, { value: characteristics.secure, label: 'Secure-labelled UUID' }], default: characteristics.unsecure }
  ];
  const definitions = [
    ['product-id', 'Query product ID', '00030100'], ['name', 'Query device name', '01020100'], ['battery', 'Query battery status', '02020100'],
    ['standby', 'Query standby timer', '01040100'], ['current-mode', 'Query audio mode', '1f030100'],
    ['set-standby', 'Set standby timer', null, { id: 'minutes', label: 'Standby minutes', type: 'select', options: [0, 5, 10, 20, 30, 60, 120].map(value => ({ value: String(value), label: String(value) })), default: '20' }],
    ['select-mode', 'Select captured audio mode', null, { id: 'mode', label: 'Mode index from a captured supported-mode response', type: 'number', min: 0, max: 255, step: 1, default: 0 }],
    ['power-off', 'Power off headphones', '0704050100']
  ];
  const commands = definitions.map(([id, label, , input]) => ({ id, label: `QC Ultra Gen1: ${label}`, description: 'Reference preview requires captured QC Ultra Gen1 product identity and FEBE service evidence. No device command is sent.', inputs: [...inputs(), ...(input ? [input] : [])] }));
  function buildCommand(id, values = {}) {
    const definition = definitions.find(item => item[0] === id), command = commands.find(item => item.id === id);
    if (!definition || !object(values)) throw new Error('Unsupported Bose reference command.');
    if (maxName(values.device)) throw new Error('QC Ultra Gen 1 command templates are unavailable for SoundLink Max.');
    if (!identify(values.device) || !(values.device.services || []).some(item => uuid(typeof item === 'string' ? item : item?.uuid) === 'febe')) throw new Error('Select a Bose candidate with captured FEBE service evidence.');
    if (!modelEvidence(values.identityHex)) throw new Error('Provide the captured BMAP product-ID Status response for QC Ultra Gen1 (0x4066).');
    if (![characteristics.secure, characteristics.unsecure].includes(values.characteristic)) throw new Error('Choose the observed BMAP characteristic UUID.');
    if (Object.keys(values).some(key => key !== 'device' && !command.inputs.some(input => input.id === key))) throw new Error('Unrecognized Bose command input.');
    let packet = definition[2];
    if (id === 'set-standby') {
      const minutes = typeof values.minutes === 'number' ? String(values.minutes) : values.minutes;
      if (!['0', '5', '10', '20', '30', '60', '120'].includes(minutes)) throw new Error('Choose a documented standby duration.');
      packet = `01040201${hex([Number(minutes)])}`;
    }
    if (id === 'select-mode') {
      const mode = typeof values.mode === 'string' && /^(?:0|[1-9]\d{0,2})$/.test(values.mode) ? Number(values.mode) : values.mode;
      if (!Number.isInteger(mode) || mode < 0 || mode > 255) throw new Error('Use a captured mode index from 0 to 255.');
      packet = `1f030502${hex([mode])}00`;
    }
    return { summary: command.label, transport: 'BMAP over BLE (external reference)', execution: 'reference-preview', hex: packet,
      service, characteristic: values.characteristic, framing: { bmapHex: packet, bleSegments: [`00${packet}`], writeType: 'Without response', segmentDataBytes: 19 },
      compatibility: { model: 'QuietComfort Ultra Headphones (Gen 1)', productId: '0x4066', evidence: values.identityHex, hardwareValidatedHere: false },
      prerequisites: ['Use an authorized external client and confirm the product ID, FEBE service, characteristic and its discovered properties on the same device.',
        'Both source characteristic variants use a one-byte BLE segmentation header. Secure/unsecure labels identify distinct UUIDs; no authentication or encryption implementation is supplied.',
        'The external client must satisfy device link-security requirements and collect complete response notifications. GET requests still require characteristic writes.'],
      warnings: ['This preview has no execution method or sendable recipe steps.',
        'Battery auxiliary bytes, charging state, ANC settings and firmware operations are not inferred.', ...(id === 'select-mode' ? ['Mode indices depend on the device; use an index from its captured mode response.'] : [])], sources: sources.map(source => ({ ...source })) };
  }
  return { identify, parse, reassemble, inspect, decode, decodeStatus, characteristics, service, sources, commands, buildCommand,
    statusLabel: 'BMAP capture JSON', captureLabel: 'BMAP characteristic HEX', captureExample: '{"format":"bmap","model":"unconfirmed","hex":"00030303406601"}' };
})();
if (typeof module !== 'undefined') module.exports = NanoBoseProtocol;
