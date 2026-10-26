'use strict';

const NanoResMedFIG = (() => {
  const base = 'https://github.com/m-kozlowski/airbreak-plus/blob/d6474221a1940970c1eaa3878618a9dd1813dba9/';
  const sources = [
    { title: 'Air11 BLE FIG framing and authenticated sessions', url: base + 'docs/as11/bluetooth_protocol.md' },
    { title: 'Reference FIG codec and AES envelope', url: base + 'python/lib/resmed_fig.py' },
    { title: 'Air11 JSON-RPC methods and permissions', url: base + 'docs/as11/rpc_protocol.md' },
    { title: 'Air11 identification and state selectors', url: base + 'docs/as11/rpc_get_inputs.md' },
    { title: 'Air11 NCP binary record envelope', url: base + 'docs/as11/ncp_protocol.md' },
  ];
  const service = '0000fd56-0000-1000-8000-00805f9b34fb';
  const characteristics = { tx: 'a6220002-35f1-4b20-afae-cb089d2044aa', rx: 'a6220003-35f1-4b20-afae-cb089d2044aa', status: 'a6220003-35f1-4b20-afae-cb089d2044aa' };
  const sync = [0xbe, 0xba, 0xfe, 0xca], maxCapture = 262144;
  const lanes = { 0x390: ['Device to host', 'Plaintext NCP'], 0x391: ['Host to device', 'Plaintext NCP'], 0x392: ['Device to host', 'Plaintext JSON'], 0x393: ['Host to device', 'Plaintext JSON'], 0x394: ['Device to host', 'Encrypted NCP'], 0x395: ['Host to device', 'Encrypted NCP'], 0x396: ['Device to host', 'Encrypted JSON'], 0x397: ['Host to device', 'Encrypted JSON'] };
  const methods = { 4: 'GetDateTime', 6: 'GetVersion', 0x43: 'Get', 0x44: 'Set', 0x48: 'StartKeyExchange', 0x49: 'ConfirmKeyExchange', 0x4a: 'RequestSession', 0x4b: 'CheckSessionIntegrity' };
  const sessionRequirement = 'Air11 application RPC requires a completed custom SRP pairing or clientId/masterPairKey resumption and a fresh AES-256 session derived from the device nonce.';
  const field = (label, value) => ({ label, value: typeof value === 'string' ? value : JSON.stringify(value) });
  const hex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
  const code = value => `0x${value.toString(16).padStart(4, '0')}`;
  function bytes(value) {
    if (value instanceof Uint8Array && value.length <= maxCapture) return value.slice();
    if (typeof value !== 'string') throw new Error('Enter FIG capture HEX bytes.');
    const compact = value.replace(/\s/g, '');
    if (compact.length > maxCapture * 2 || !/^(?:[0-9a-f]{2})*$/i.test(compact)) throw new Error('FIG capture must contain complete hexadecimal bytes, at most 262144 bytes.');
    return Uint8Array.from(compact.match(/../g) || [], byte => parseInt(byte, 16));
  }
  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function identify(device) {
    if (!device || typeof device !== 'object') return null;
    const matches = (Array.isArray(device.services) ? device.services : []).some(item => ['fd56', '0xfd56', service].includes(String(typeof item === 'string' ? item : item?.uuid).toLowerCase()));
    const named = typeof device.name === 'string' && device.name.startsWith('ResMed');
    if (!matches && !named) return null;
    return { category: 'medical', protocol: 'resmed-fig', title: 'ResMed Air11 FIG candidate', confidence: matches ? 'Service match' : 'Name candidate',
      evidence: [matches ? 'Advertised FD56 service matches the documented Air11 FIG transport.' : 'Advertised name begins with the documented ResMed prefix.'],
      fields: [field('Inspection mode', 'Capture inspection'), field('Transport service', '0xFD56')],
      limitations: ['The service or name does not establish the device model or firmware.', sessionRequirement, 'Encrypted capture payloads remain opaque. This adapter does not pair, connect, send requests, or decrypt sessions.'], sources: sources.map(item => ({ ...item })) };
  }
  function decodePlaintext(value) {
    const text = typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(bytes(value));
    if (text.length > maxCapture) throw new Error('Plaintext JSON exceeds the capture limit.');
    const message = JSON.parse(text);
    if (!message || typeof message !== 'object' || Array.isArray(message) || !['1.0', '1.1', '2.0'].includes(message.jsonrpc)) throw new Error('Unsupported JSON-RPC envelope.');
    const hasID = Object.hasOwn(message, 'id'), hasResult = Object.hasOwn(message, 'result'), hasError = Object.hasOwn(message, 'error');
    if (hasID && message.id !== null && !['string', 'number'].includes(typeof message.id) || Object.hasOwn(message, 'method') && (hasResult || hasError)) throw new Error('Invalid JSON-RPC message ID or mixed request/reply envelope.');
    const role = typeof message.method === 'string' && !hasResult && !hasError ? hasID ? 'Request' : 'Notification' : hasID && hasResult !== hasError ? hasError ? 'Error reply' : 'Reply' : null;
    if (!role) throw new Error('Ambiguous JSON-RPC request/reply envelope.');
    const fields = [field('RPC role', role), field('RPC contract', message.jsonrpc)];
    if (hasID) fields.push(field('RPC message ID', message.id));
    if (message.method) fields.push(field('RPC method', message.method));
    if (Object.hasOwn(message, 'params')) fields.push(field('RPC parameters', message.params));
    if (hasError) fields.push(field('RPC error', message.error));
    if (hasResult) {
      const result = message.result;
      fields.push(field('RPC result', result));
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        for (const name of ['FGState', 'DeviceControl', 'dateTime', 'IdentificationProfiles']) if (Object.hasOwn(result, name)) fields.push(field(name, result[name]));
        for (const name of ['FlowGenerator', 'BluetoothModule', 'CellularModule', 'AlarmModule']) {
          const profiles = result[name]?.IdentificationProfiles;
          if (profiles) for (const section of ['Software', 'Hardware', 'Product']) if (profiles[section]) fields.push(field(`${name} ${section}`, profiles[section]));
        }
        if (result.FlowGenerator?.RPC) fields.push(field('Advertised RPC capabilities', result.FlowGenerator.RPC));
      }
    }
    return { role, message, fields };
  }
  function decodeNCP(data) {
    const records = [], issues = [];
    for (let offset = 0; offset < data.length;) {
      if (data.length - offset < 4) { issues.push('Incomplete NCP record header.'); break; }
      const length = data[offset] | data[offset + 1] << 8;
      if (length < 2 || offset + length + 2 > data.length) { issues.push(`Invalid or incomplete NCP record length ${length}.`); break; }
      const command = data[offset + 2], tag = data[offset + 3], body = data.subarray(offset + 4, offset + length + 2);
      const role = command === 0xfd ? 'Error reply' : command >= 0x80 ? 'Reply' : 'Request';
      const method = methods[role === 'Reply' ? command - 0x80 : command];
      records.push({ length, command: code(command), role, tag, method: method || 'Unknown command', suppressReply: role === 'Request' && tag === 255, bodyHex: hex(body) });
      offset += length + 2;
    }
    return { records, issues };
  }
  function describe(vcid, payload) {
    const lane = lanes[vcid], encoding = lane?.[1] || 'Unknown VCID';
    const result = { vcid: code(vcid), direction: lane?.[0] || 'Unknown', encoding, payloadLength: payload.length, payloadHex: hex(payload), complete: true, issues: [], fields: [] };
    if (!lane) result.issues.push('Unknown VCID; payload retained as opaque HEX.');
    else if (encoding.startsWith('Encrypted')) {
      result.encrypted = true;
      result.issues.push('Session key is absent; encrypted payload retained as opaque HEX. FIG CRC verifies framing, not session authentication.');
      if (payload.length < 32 || (payload.length - 16) % 16) result.issues.push('Encrypted payload length does not fit a 16-byte IV followed by AES-CBC blocks.');
      else { result.ivHex = hex(payload.subarray(0, 16)); result.ciphertextHex = hex(payload.subarray(16)); }
    } else if (encoding === 'Plaintext JSON') {
      try {
        const rpc = decodePlaintext(payload); result.rpc = rpc.message; result.role = rpc.role; result.fields = rpc.fields;
        if (rpc.role === 'Request' && !['StartKeyExchange', 'ConfirmKeyExchange', 'RequestSession', 'CheckSessionIntegrity'].includes(rpc.message.method)) result.issues.push('Ordinary application JSON-RPC requires an encrypted session; this captured plaintext request does not establish accepted access.');
      } catch (error) { result.issues.push(`Plaintext JSON decode failed: ${error.message}`); }
    } else { const ncp = decodeNCP(payload); result.records = ncp.records; result.issues.push(...ncp.issues); }
    return result;
  }
  function createDecoder() {
    let pending = new Uint8Array(0);
    function feed(value) {
      const chunk = bytes(value);
      if (pending.length + chunk.length > maxCapture) throw new Error('Combined FIG capture exceeds 262144 bytes.');
      const data = new Uint8Array(pending.length + chunk.length); data.set(pending); data.set(chunk, pending.length);
      const frames = [], issues = []; let offset = 0;
      const matches = index => sync.every((byte, part) => data[index + part] === byte);
      while (offset < data.length) {
        let found = offset;
        while (found + 4 <= data.length && !matches(found)) found++;
        if (found + 4 > data.length) {
          let retained = Math.min(3, data.length - offset);
          while (retained && !Array.from(data.subarray(data.length - retained)).every((byte, part) => byte === sync[part])) retained--;
          const discarded = data.length - retained - offset;
          if (discarded) issues.push(`Discarded ${discarded} bytes without a FIG sync word.`);
          offset = data.length - retained; break;
        }
        if (found > offset) issues.push(`Discarded ${found - offset} bytes before FIG sync.`);
        offset = found;
        if (data.length - offset < 16) break;
        const view = new DataView(data.buffer, data.byteOffset + offset, 16), length = view.getUint16(6, true);
        if (crc32(data.subarray(offset + 4, offset + 12)) !== view.getUint32(12, true)) { issues.push('FIG header CRC32 mismatch; sync rejected.'); offset += 4; continue; }
        if (data.length - offset < 16 + length) break;
        const payload = data.subarray(offset + 16, offset + 16 + length);
        if (crc32(payload) !== view.getUint32(8, true)) { issues.push('FIG payload CRC32 mismatch; packet rejected.'); offset += 4; continue; }
        frames.push(describe(view.getUint16(4, true), payload)); offset += 16 + length;
      }
      pending = data.slice(offset);
      return { frames, issues, complete: pending.length === 0, pendingBytes: pending.length, pendingHex: hex(pending), expectedBytes: pending.length >= 16 ? 16 + (pending[6] | pending[7] << 8) : pending.length ? 16 : 0 };
    }
    return { feed, reset: () => { pending = new Uint8Array(0); } };
  }
  const inspect = value => createDecoder().feed(value);
  function decode(uuid, value) {
    if (![characteristics.tx, characteristics.rx].includes(String(uuid).toLowerCase())) return [];
    const report = inspect(value), fields = [field('Complete FIG frames', report.frames.length), field('Capture completeness', report.complete ? 'Complete' : 'Fragment; more captured bytes required')];
    for (const [index, frame] of report.frames.entries()) {
      const prefix = `Frame ${index + 1}`;
      fields.push(field(`${prefix} VCID`, frame.vcid), field(`${prefix} direction`, frame.direction), field(`${prefix} encoding`, frame.encoding), field(`${prefix} payload bytes`, frame.payloadLength), field(`${prefix} CRC32`, 'Header and payload verified'), field(`${prefix} payload HEX`, frame.payloadHex));
      for (const item of frame.fields) fields.push(field(`${prefix} ${item.label}`, item.value));
      if (frame.records) fields.push(field(`${prefix} NCP records`, frame.records));
      if (frame.issues.length) fields.push(field(`${prefix} evidence`, frame.issues.join(' ')));
    }
    if (report.pendingBytes) fields.push(field('Incomplete prefix HEX', report.pendingHex), field('Retained fragment bytes', report.pendingBytes), field('Expected complete frame bytes', report.expectedBytes));
    if (report.issues.length) fields.push(field('Capture evidence', report.issues.join(' ')));
    return fields;
  }
  const requestID = { id: 'rpcId', label: 'Request message ID', type: 'number', default: '1', min: 1, max: 2147483647, step: 1 };
  const commands = [
    { id: 'get-version', label: 'Preview version and capabilities request', method: 'GetVersion', version: '2.0' },
    { id: 'get-identity', label: 'Preview identification request', method: 'Get', version: '1.0', params: ['IdentificationProfiles'] },
    { id: 'get-state', label: 'Preview device-state request', method: 'Get', version: '1.0', params: ['DeviceControl'] },
    { id: 'get-date-time', label: 'Preview clock request', method: 'GetDateTime', version: '1.0' },
    { id: 'set-date-time', label: 'Preview clock change (service permission)', method: 'SetDateTime', version: '1.1', writable: true },
  ].map(item => ({ ...item, description: item.writable ? 'Offline JSON template. Stock BLE denies this service-only method. No request is sent.' : 'Offline application JSON template. An authenticated encrypted Air11 session is required to send it.', inputs: [requestID, ...(item.writable ? [{ id: 'dateTime', label: 'UTC timestamp (ISO 8601)', type: 'text', default: '' }] : [])] }));
  function buildCommand(id, values = {}) {
    const command = commands.find(item => item.id === id);
    if (!command) throw new Error('Unsupported Air11 preview operation.');
    if (values.device && !identify(values.device)) throw new Error('Select an FD56 or ResMed candidate first.');
    const rpcId = values.rpcId ?? 1;
    if (!/^[1-9]\d*$/.test(String(rpcId)) || !Number.isSafeInteger(Number(rpcId)) || Number(rpcId) > 2147483647) throw new Error('Request message ID must be an integer from 1 to 2147483647.');
    const request = { jsonrpc: command.version, method: command.method, id: Number(rpcId) };
    if (command.params) request.params = [...command.params];
    if (command.writable) {
      if (typeof values.dateTime !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(values.dateTime) || !Number.isFinite(Date.parse(values.dateTime)) || new Date(values.dateTime).toISOString() !== values.dateTime.replace(/Z$/, values.dateTime.includes('.') ? 'Z' : '.000Z')) throw new Error('Enter a valid UTC timestamp, for example 2026-08-12T14:25:31.000Z.');
      request.params = { dateTime: values.dateTime };
    }
    const json = new TextEncoder().encode(JSON.stringify(request)), padded = new Uint8Array(Math.ceil((json.length + 2) / 16) * 16);
    padded[0] = json.length & 255; padded[1] = json.length >> 8; padded.set(json, 2);
    return { summary: command.label, transport: 'Offline Air11 FIG application template', offlineOnly: true, requiresAuthentication: true, stockBLEPermitted: !command.writable, request,
      applicationPayloadHex: hex(json), plaintextLengthPrefixedHex: hex(padded), frameTemplate: { syncHex: 'bebafeca', requestVCID: '0x0397', replyVCID: '0x0396', payload: 'fresh 16-byte IV || AES-256-CBC(length-prefixed JSON and zero padding)', headerBytes: 16, integrity: 'IEEE CRC32 of encrypted payload and header bytes 4 through 11' },
      warnings: [sessionRequirement, 'Application plaintext is a local preview. No encrypted FIG frame or executable GATT recipe was generated.', ...(command.writable ? ['SetDateTime requires service-channel permission; stock BLE rejects it. The firmware clock uses whole-second resolution.'] : [])], sources: sources.map(item => ({ ...item })) };
  }
  return { identify, inspect, createDecoder, decode, decodePlaintext, buildCommand, commands, sources, service, characteristics, manufacturer: false, captureLabel: 'FIG capture HEX' };
})();
if (typeof module !== 'undefined') module.exports = NanoResMedFIG;
