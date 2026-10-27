'use strict';

const NanoLGWebOSProtocol = (() => {
  const aio = 'https://github.com/home-assistant-libs/aiowebostv/blob/1241a74ea57d60d0658fac894dd820a13dc8b786/aiowebostv/';
  const sig = 'https://bitbucket.org/bluetooth-SIG/public/src/e7f76d7c5e2edced4872a352ff4a300610ac8212/assigned_numbers/';
  const sources = [
    { title: 'webOS SSAP endpoints', url: aio + 'endpoints.py' },
    { title: 'webOS request envelopes, status and pointer input', url: aio + 'webos_client.py' },
    { title: 'webOS prompt registration and permissions', url: aio + 'handshake.py' },
    { title: 'ConnectSDK app and input-list fields', url: 'https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/2f7ebbc7eb909321ff41b2c6bcdf6b0881427579/src/com/connectsdk/service/WebOSTVService.java' },
    { title: 'webOS system and software response fields', url: 'https://github.com/snabb/webostv/blob/acc4a154f9a3d11c93a99066cdae4af62672e42e/mmisc.go' },
    { title: 'webOS flat audio response fields', url: 'https://github.com/snabb/webostv/blob/acc4a154f9a3d11c93a99066cdae4af62672e42e/maudio.go' },
    { title: 'webOS nested volume and mute normalization', url: 'https://github.com/hobbyquaker/lgtv2/blob/80ef796846730cb4331f33be38221de7485afc55/index.js#L251' },
    { title: 'PyWebOSTV controls and input socket framing', url: 'https://github.com/supersaiyanmode/PyWebOSTV/blob/55cbd0303fd3211c4e898ae1728b934a4ca5d2aa/pywebostv/controls.py' },
    { title: 'Bluetooth SIG company identifiers', url: sig + 'company_identifiers/company_identifiers.yaml' },
    { title: 'Bluetooth SIG member service UUIDs', url: sig + 'uuids/member_uuids.yaml' }
  ];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const field = (label, value) => ({ label, value: String(value) });
  const uuid = value => typeof value === 'string' ? value.toLowerCase().replace(/^0x/, '').replace(/^0000([\da-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1') : '';
  function text(value, label, max = 256) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be nonempty text without control characters.`);
    return value;
  }
  function number(value, label, max = 100) {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${label} must be an integer from 0 to ${max}.`);
    return value;
  }
  function bool(value, label) {
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
    return value;
  }
  const tvName = device => typeof device?.name === 'string' && /^(?:\[LG\]\s*)?(?:LG[ _-]+(?:webOS[ _-]+)?TV|LG[ _-]+webOS|webOS[ _-]+TV)\b/i.test(device.name.trim());
  function identify(device) {
    if (!object(device)) return null;
    const manufacturer = typeof device.manufacturer === 'string' && device.manufacturer.length <= 3300 && /^(?:[\da-f]{2}){2,}$/i.test(device.manufacturer) ? device.manufacturer.toLowerCase() : '';
    const company = manufacturer.startsWith('c400'), service = [...(Array.isArray(device.services) ? device.services : []), ...(Array.isArray(device.serviceData) ? device.serviceData : [])].some(item => uuid(typeof item === 'string' ? item : item?.uuid) === 'feb9');
    const television = tvName(device);
    if (!company && !service && !television) return null;
    const result = { title: television ? 'LG webOS TV candidate' : 'LG Electronics BLE broadcast', category: television ? 'appliance' : 'vendor',
      confidence: service ? 'Service match' : company ? 'Manufacturer match' : 'Name candidate', evidence: [], fields: [], limitations: [], sources: sources.map(source => ({ ...source })) };
    if (company) { result.evidence.push('Manufacturer company 0x00C4 is assigned to LG Electronics.'); result.fields.push(field('Bluetooth company', 'LG Electronics (0x00C4)'), field('Manufacturer payload HEX', manufacturer.slice(4))); }
    if (service) { result.evidence.push('Service 0xFEB9 is assigned to LG Electronics.'); result.fields.push(field('Assigned LG service', '0xFEB9')); }
    if (television) { result.evidence.push(`Broadcast name: ${device.name}`); result.fields.push(field('TV name candidate', device.name), field('webOS control transport', 'LAN WebSocket / SSAP')); }
    result.limitations.push('Company 0x00C4 and service 0xFEB9 identify LG as the vendor, not the TV model, webOS support, power state or a BLE control protocol.',
      'A TV name is an unauthenticated candidate. Confirm webOS and the TV LAN host in an external client before using a prepared request.',
      'LAN controls require webOS registration, TV approval and the granted permissions. Manufacturer payload fields remain uninterpreted.');
    if (device.payloadTruncated) result.limitations.push('The advertisement was truncated; the displayed manufacturer payload is incomplete.');
    return result;
  }
  function decodeStatus(response) {
    if (!object(response)) throw new Error('Expected a saved webOS response object.');
    if (response.type === 'error') return [field('webOS error', text(response.error, 'webOS error', 2048))];
    if (response.type !== undefined && response.type !== 'response') throw new Error('Expected a webOS response or error envelope.');
    const data = response.type === 'response' ? response.payload : response;
    if (!object(data)) throw new Error('webOS response payload must be an object.');
    for (const key of ['returnValue', 'subscribed', 'subscription']) if (Object.hasOwn(data, key)) bool(data[key], key);
    if (data.returnValue === false) {
      const fields = [field('webOS result', 'Failed')];
      if (Object.hasOwn(data, 'errorCode')) {
        if (!(typeof data.errorCode === 'string' || Number.isInteger(data.errorCode))) throw new Error('Invalid webOS error code.');
        fields.push(field('webOS error code', text(String(data.errorCode), 'Error code')));
      }
      if (Object.hasOwn(data, 'errorText')) fields.push(field('webOS error', text(data.errorText, 'Error text', 2048)));
      return fields;
    }
    const fields = [];
    for (const [key, label] of [['modelName', 'TV model'], ['product_name', 'Software product'], ['model_name', 'Software model ID'], ['major_ver', 'Firmware major version'], ['minor_ver', 'Firmware minor version'], ['appId', 'Foreground app ID']]) {
      if (Object.hasOwn(data, key)) fields.push(field(label, text(data[key], label)));
    }
    const audio = Object.hasOwn(data, 'volumeStatus') ? data.volumeStatus : data;
    if (!object(audio)) throw new Error('Volume status must be an object.');
    if (Object.hasOwn(audio, 'volume')) fields.push(field('Volume', number(audio.volume, 'Volume')));
    const muteKeys = audio === data ? ['mute', 'muted'] : ['muteStatus'];
    const muteValues = muteKeys.filter(key => Object.hasOwn(audio, key)).map(key => bool(audio[key], 'Mute state'));
    if (new Set(muteValues).size > 1) throw new Error('Saved mute fields conflict.');
    if (muteValues.length) fields.push(field('Muted', muteValues[0] ? 'Yes' : 'No'));
    for (const [key, label] of [['apps', 'Installed app'], ['launchPoints', 'Launch point'], ['devices', 'External input']]) {
      if (!Object.hasOwn(data, key)) continue;
      const entries = data[key];
      if (!Array.isArray(entries) || entries.length > 512) throw new Error(`${label} list must contain at most 512 entries.`);
      fields.push(field(`${label} count`, entries.length));
      for (const [index, entry] of entries.entries()) {
        if (!object(entry)) throw new Error(`${label} entry must be an object.`);
        const id = text(entry.id, `${label} ID`), nameKey = key === 'devices' ? 'label' : 'title';
        const name = Object.hasOwn(entry, nameKey) ? text(entry[nameKey], `${label} name`) : id;
        fields.push(field(`${label} ${index + 1}`, name === id ? id : `${name} (${id})`));
        if (key === 'devices' && Object.hasOwn(entry, 'connected')) fields.push(field(`${label} ${index + 1} connected`, bool(entry.connected, 'Input connected') ? 'Yes' : 'No'));
      }
    }
    if (!fields.length) throw new Error('No supported webOS identity, audio, app or input fields were found.');
    return fields;
  }
  const select = (id, label, options, selected) => ({ id, label, type: 'select', options: options.map(value => ({ value, label: value })), default: selected });
  const keys = ['LEFT', 'RIGHT', 'UP', 'DOWN', 'ENTER', 'BACK', 'HOME', 'MENU', 'INFO', 'EXIT', 'VOLUMEUP', 'VOLUMEDOWN', 'PLAY', 'PAUSE', 'STOP'];
  const definitions = [
    ['system-info', 'Request system identity', 'system/getSystemInfo'],
    ['software-info', 'Request software identity', 'com.webos.service.update/getCurrentSWInformation'],
    ['audio-status', 'Request audio status', 'audio/getStatus'], ['volume-status', 'Request volume', 'audio/getVolume'],
    ['current-app', 'Request foreground app', 'com.webos.applicationManager/getForegroundAppInfo'],
    ['apps', 'Request installed apps', 'com.webos.applicationManager/listApps'], ['launch-points', 'Request launch points', 'com.webos.applicationManager/listLaunchPoints'],
    ['inputs', 'Request external inputs', 'tv/getExternalInputList'], ['pointer-socket', 'Request pointer input socket', 'com.webos.service.networkinput/getPointerInputSocket'],
    ['volume-up', 'Increase volume', 'audio/volumeUp'], ['volume-down', 'Decrease volume', 'audio/volumeDown'], ['power-off', 'Turn TV off', 'system/turnOff'],
    ['volume', 'Set volume', 'audio/setVolume', [{ id: 'volume', label: 'Volume (0 to 100)', type: 'number', min: 0, max: 100, step: 1, default: 10 }]],
    ['mute', 'Set mute', 'audio/setMute', [select('muted', 'Muted', ['true', 'false'], 'true')]],
    ['input', 'Switch external input', 'tv/switchInput', [{ id: 'inputId', label: 'Input ID from saved input list', type: 'text', default: '' }]],
    ['launch-app', 'Launch installed app', 'system.launcher/launch', [{ id: 'appId', label: 'App ID from saved app list', type: 'text', default: '' }]],
    ['remote-key', 'Press remote key', 'com.webos.service.networkinput/getPointerInputSocket', [select('key', 'Remote key', keys, 'HOME')]],
    ['register', 'Prepare first registration', null]
  ];
  const commands = definitions.map(([id, label, , inputs = []]) => ({ id, label, inputs, description: 'Prepare an external LAN WebSocket message for a confirmed webOS TV. This preview sends no request.' }));
  const permissions = ['CONTROL_AUDIO', 'CONTROL_INPUT_TV', 'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'LAUNCH', 'READ_INSTALLED_APPS', 'READ_INPUT_DEVICE_LIST', 'READ_RUNNING_APPS', 'READ_UPDATE_INFO'];
  function registration() { return { id: 'register_0', type: 'register', payload: { forcePairing: false, pairingType: 'PROMPT', manifest: { appVersion: '1.0', manifestVersion: 1, permissions: [...permissions] } } }; }
  function buildCommand(id, values = {}) {
    const definition = definitions.find(item => item[0] === id), command = commands.find(item => item.id === id);
    if (!definition || !object(values)) throw new Error('Unsupported webOS command.');
    if (!tvName(values.device)) throw new Error('Select an LG TV name candidate before preparing webOS LAN messages.');
    const allowed = new Set(['device', ...command.inputs.map(input => input.id)]);
    if (Object.keys(values).some(key => !allowed.has(key))) throw new Error('Unrecognized webOS command input.');
    const payload = {};
    if (id === 'volume') {
      const value = typeof values.volume === 'string' && /^(?:0|[1-9]\d?|100)$/.test(values.volume) ? Number(values.volume) : values.volume;
      payload.volume = number(value, 'Volume');
    }
    if (id === 'mute') {
      if (![true, false, 'true', 'false'].includes(values.muted)) throw new Error('Choose true or false for mute.');
      payload.mute = values.muted === true || values.muted === 'true';
    }
    for (const [operation, input, key] of [['input', 'inputId', 'inputId'], ['launch-app', 'appId', 'id']]) if (id === operation) {
      const value = text(values[input], input);
      if (!/^[a-z\d][a-z\d._:-]*$/i.test(value)) throw new Error('Use the exact ID from a saved TV response.');
      payload[key] = value;
    }
    if (id === 'remote-key' && !keys.includes(values.key)) throw new Error('Choose a supported remote key.');
    const request = id === 'register' ? registration() : { id: 'gattelier-1', type: 'request', uri: `ssap://${definition[2]}`, payload };
    const plan = { summary: `${command.label}: external webOS LAN preview`, transport: 'LAN WebSocket / webOS SSAP', execution: 'external-template', request,
      connection: { endpoints: ['wss://<TV-LAN-host>:3001/', 'ws://<TV-LAN-host>:3000/'], requiresRegistration: true },
      prerequisites: ['Confirm the TV supports webOS SSAP and obtain its LAN host separately; a BLE address is not a LAN endpoint.',
        'An external client sends a register envelope with its permission manifest. Accept the TV prompt, then retain the client-key returned in the registered response.',
        'For reconnects, the external client supplies its saved client-key in the register payload. The key is secret. A registered connection and granted permissions are required for requests.',
        'Firmware and TV settings determine transport and permission availability. Use unique request IDs within the external session.'],
      warnings: ['This preview opens no connection and sends no BLE or LAN command.'], sources: sources.map(source => ({ ...source })) };
    if (id !== 'register') plan.registrationPreview = registration();
    if (id === 'remote-key') plan.followUp = { transport: 'Separate LAN WebSocket', endpoint: 'Use socketPath from the pointer-input response.', message: `type:button\nname:${values.key}\n\n` };
    if (id === 'power-off') plan.warnings.push('Power-off requires the TV to be on. The WebSocket connection closes during shutdown; waking the TV is outside this preview.');
    return plan;
  }
  return { identify, decodeStatus, statusLabel: 'webOS response JSON', sources, commands, buildCommand };
})();
if (typeof module !== 'undefined') module.exports = NanoLGWebOSProtocol;
