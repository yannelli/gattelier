'use strict';

const NanoVeSyncProtocol = (() => {
  const revision = '58eee3bdbfbaac98d64cd0dd4fd66e1f1c24ab8e';
  const upstream = `https://github.com/webdjoe/pyvesync/blob/${revision}/src/pyvesync/`;
  const sources = [
    { title: 'Core 200S model capabilities', url: `${upstream}device_map.py#L817-L835` },
    { title: 'Core purifier commands and status', url: `${upstream}devices/vesyncpurifier.py#L118-L363` },
    { title: 'VeSync cloud request envelope', url: `${upstream}utils/device_mixins.py#L120-L202` },
    { title: 'Core 200S request fixtures', url: `https://github.com/webdjoe/pyvesync/blob/${revision}/src/tests/api/vesyncpurifier/Core200S.yaml` },
    { title: 'Bluetooth company identifiers', url: 'https://bitbucket.org/bluetooth-SIG/public/src/main/assigned_numbers/company_identifiers/company_identifiers.yaml' },
    { title: 'Bluetooth standard GATT characteristics', url: 'https://www.bluetooth.com/specifications/assigned-numbers/' }
  ];
  const limitations = [
    'Power, fan and light controls use the authenticated VeSync cloud API. Prepared requests require the account and cloud device context.',
    'The manufacturer payload after company ID 0x06D0 has no decoded operating-state fields here.',
    'FFF0/FFF1/FFF2 and the observed F000FFE0 service do not establish a Core 200S control protocol. No vendor BLE command is generated.',
    'Core 200S has manual and sleep modes with fan speeds 1 to 3. This decoder does not report PM2.5, humidity or air-quality measurements.'
  ];
  function hexBytes(hex, maximum = 512) {
    if (typeof hex !== 'string' || hex.length % 2 || hex.length > maximum * 2 || !/^[\da-f]*$/i.test(hex)) throw new Error('Expected complete hexadecimal bytes.');
    return Uint8Array.from(hex.match(/../g) || [], value => parseInt(value, 16));
  }
  const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const field = (label, value) => ({ label, value });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  function identify(device) {
    if (!object(device)) return null;
    const name = typeof device.name === 'string' ? device.name.trim() : '';
    if (!/^(?:Core[ _-]?200S|LAP-C201S-AUSR|LAP-C202S-WUSR)$/i.test(name)) return null;
    let manufacturer;
    try { manufacturer = hexBytes(device.manufacturer || ''); } catch { return null; }
    if (manufacturer.length === 1 || manufacturer.length > 1 && (manufacturer[0] !== 0xd0 || manufacturer[1] !== 6)) return null;
    const fields = [field('Product', 'Levoit Core 200S air purifier'), field('Control transport', 'VeSync cloud over Wi-Fi'), field('Fan speeds', '1, 2, 3'), field('Modes', 'Manual, sleep')];
    const evidence = [`Advertised model name: ${name}`];
    if (manufacturer.length >= 2) {
      fields.push(field('Bluetooth company', 'Etekcity Corporation (0x06D0)'), field('Vendor payload', hex(manufacturer.slice(2)) || 'Empty'));
      evidence.push('Manufacturer data contains Bluetooth company ID 0x06D0.');
    }
    return { category: 'appliance', title: 'Levoit Core 200S', confidence: manufacturer.length >= 2 ? 'high' : 'medium', evidence, fields, limitations: limitations.slice(), sources: sources.map(source => ({ ...source })) };
  }
  function decode(uuid, value) {
    const id = String(uuid || '').toLowerCase().replace(/^0x/, '').replace(/^0000([\da-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
    const labels = { '2a00': 'Device name', '2a24': 'Model number', '2a25': 'Serial number', '2a26': 'Firmware revision', '2a27': 'Hardware revision', '2a28': 'Software revision', '2a29': 'Manufacturer name' };
    if (id !== '2a19' && !Object.hasOwn(labels, id)) return [];
    const bytes = hexBytes(value, 248);
    if (id === '2a19') {
      if (bytes.length !== 1 || bytes[0] > 100) throw new Error('Battery level must contain one byte from 0 to 100.');
      return [field('Battery level', `${bytes[0]}%`)];
    }
    if (!bytes.length) throw new Error('Device information text is empty.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0+$/, ''); } catch { throw new Error('Device information text contains invalid UTF-8.'); }
    if (!text || /[\x00-\x1f\x7f]/.test(text)) throw new Error('Device information text contains control characters.');
    return [field(labels[id], text)];
  }
  function integer(value, label, min = 0, max = 0xffffffff) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is outside its supported range.`);
    return value;
  }
  function decodeStatus(response) {
    if (!object(response)) throw new Error('Expected a Core 200S status object.');
    let status = response;
    for (let depth = 0; Object.hasOwn(status, 'code'); depth++) {
      if (depth >= 2 || status.code !== 0 || !object(status.result)) throw new Error('VeSync status response is unsuccessful or malformed.');
      status = status.result;
    }
    const fields = [];
    for (const [key, label] of [['enabled', 'Power'], ['display', 'Display'], ['child_lock', 'Child lock']]) {
      if (!Object.hasOwn(status, key) || key !== 'enabled' && status[key] === null) continue;
      if (typeof status[key] !== 'boolean') throw new Error(`${label} must be a boolean.`);
      fields.push(field(label, status[key] ? 'On' : 'Off'));
    }
    for (const [key, label, max] of [['level', 'Fan speed', 3], ['levelNew', 'Selected fan speed', 3], ['filter_life', 'Filter life', 100], ['device_error_code', 'Device error code', 0xffffffff]]) {
      if (!Object.hasOwn(status, key) || key === 'levelNew' && status[key] === null) continue;
      const number = integer(status[key], label, 0, max); fields.push(field(label, key === 'filter_life' ? `${number}%` : String(number)));
    }
    for (const [key, label, options] of [['mode', 'Mode', ['manual', 'sleep']], ['night_light', 'Night light', ['on', 'dim', 'off']]]) {
      if (!Object.hasOwn(status, key) || key === 'night_light' && status[key] === null) continue;
      if (!options.includes(status[key])) throw new Error(`${label} is unsupported for Core 200S.`);
      fields.push(field(label, status[key]));
    }
    if (status.configuration !== undefined && status.configuration !== null) {
      if (!object(status.configuration)) throw new Error('Core 200S configuration must be an object.');
      for (const [key, label] of [['display', 'Configured display'], ['display_forever', 'Display stays on']]) {
        if (!Object.hasOwn(status.configuration, key)) continue;
        if (typeof status.configuration[key] !== 'boolean') throw new Error(`${label} must be a boolean.`);
        fields.push(field(label, status.configuration[key] ? 'On' : 'Off'));
      }
    }
    if (status.extension !== undefined && status.extension !== null) {
      if (!object(status.extension)) throw new Error('Core purifier extension must be an object.');
      if (Object.hasOwn(status.extension, 'timer_remain')) fields.push(field('Timer remaining', `${integer(status.extension.timer_remain, 'Timer remaining')} s`));
      if (Object.hasOwn(status.extension, 'schedule_count')) fields.push(field('Schedules', String(integer(status.extension.schedule_count, 'Schedule count'))));
    }
    if (Object.hasOwn(status, 'timers')) {
      if (status.timers !== null && (!Array.isArray(status.timers) || status.timers.length > 32)) throw new Error('Expected at most 32 purifier timers.');
      for (const timer of status.timers || []) {
        if (!object(timer) || timer.action !== 'off') throw new Error('Core 200S timer action must be off.');
        const id = integer(timer.id, 'Timer ID'), total = integer(timer.total, 'Timer duration'), remain = integer(timer.remain, 'Timer remaining', 0, total);
        fields.push(field(`Timer ${id}`, `Off in ${remain} s (${total} s total)`));
      }
      if (!status.timers?.length) fields.push(field('Timer', 'None'));
    }
    if (!fields.length) throw new Error('No supported Core 200S status fields were found.');
    return fields;
  }
  const select = (id, label, options, selected) => ({ id, label, type: 'select', options: options.map(value => ({ value, label: value })), default: selected });
  const region = () => select('region', 'VeSync account region', ['us', 'eu'], 'us');
  const state = label => select('state', label, ['on', 'off'], 'on');
  const speed = () => ({ id: 'speed', label: 'Fan speed', type: 'number', min: 1, max: 3, step: 1, default: 1 });
  const commands = [
    { id: 'status', label: 'Request status', description: 'Prepare a VeSync cloud getPurifierStatus request.', inputs: [region()] },
    { id: 'timer-status', label: 'Request timer status', description: 'Prepare a VeSync cloud getTimer request.', inputs: [region()] },
    { id: 'power', label: 'Set power', description: 'Prepare a VeSync cloud power request for Core 200S.', inputs: [state('Power'), region()] },
    { id: 'fan-speed', label: 'Set fan speed', description: 'Set speed 1 to 3 in manual mode through the VeSync cloud.', inputs: [speed(), region()] },
    { id: 'mode', label: 'Set mode', description: 'Choose sleep or manual mode. Manual mode sends the selected fan speed.', inputs: [select('mode', 'Mode', ['manual', 'sleep'], 'sleep'), speed(), region()] },
    { id: 'display', label: 'Set display', description: 'Prepare a VeSync cloud display request.', inputs: [state('Display'), region()] },
    { id: 'child-lock', label: 'Set child lock', description: 'Prepare a VeSync cloud child-lock request.', inputs: [state('Child lock'), region()] },
    { id: 'night-light', label: 'Set night light', description: 'Choose on, dim or off through the VeSync cloud.', inputs: [select('mode', 'Night light', ['on', 'dim', 'off'], 'off'), region()] }
  ];
  function buildCommand(id, values = {}) {
    const command = commands.find(item => item.id === id);
    if (!command) throw new Error('Unsupported Core 200S command.');
    if (!object(values) || Object.keys(values).some(key => !command.inputs.some(input => input.id === key))) throw new Error('Unrecognized command input. Account credentials belong in the external authenticated client.');
    const selected = {};
    for (const input of command.inputs) {
      const value = values[input.id] === undefined ? input.default : values[input.id];
      if (input.type === 'select') {
        if (!input.options.some(option => option.value === value)) throw new Error(`Invalid ${input.label.toLowerCase()}.`);
        selected[input.id] = value;
      } else {
        const number = typeof value === 'string' && /^[1-3]$/.test(value) ? Number(value) : value;
        selected[input.id] = integer(number, input.label, input.min, input.max);
      }
    }
    const enabled = selected.state === 'on'; let method, data;
    if (id === 'status') { method = 'getPurifierStatus'; data = {}; }
    if (id === 'timer-status') { method = 'getTimer'; data = {}; }
    if (id === 'power') { method = 'setSwitch'; data = { enabled, id: 0 }; }
    if (id === 'fan-speed' || id === 'mode' && selected.mode === 'manual') { method = 'setLevel'; data = { id: 0, level: selected.speed, type: 'wind' }; }
    if (id === 'mode' && selected.mode === 'sleep') { method = 'setPurifierMode'; data = { mode: 'sleep' }; }
    if (id === 'display') { method = 'setDisplay'; data = { state: enabled }; }
    if (id === 'child-lock') { method = 'setChildLock'; data = { child_lock: enabled }; }
    if (id === 'night-light') { method = 'setNightLight'; data = { night_light: selected.mode }; }
    return {
      summary: `${command.label}: Core 200S external VeSync cloud request`, transport: 'vesync-cloud', execution: 'external-template',
      warnings: ['This request template does not contact the board or appliance.', 'Complete the account and cloud-device context in an authenticated external client. The BLE address is not the VeSync cloud device ID.', ...(method === 'setLevel' ? ['Setting fan speed selects manual mode and turns the purifier on.'] : [])],
      request: { method: 'POST', url: `https://smartapi.vesync.${selected.region === 'eu' ? 'eu' : 'com'}/cloud/v2/deviceManaged/bypassV2`, headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: { method: 'bypassV2', payload: { method, source: 'APP', data } }, requiredContext: ['acceptLanguage', 'appVersion', 'phoneBrand', 'phoneOS', 'accountID', 'cid', 'deviceId', 'configModule', 'configModel', 'debugMode', 'traceId', 'timeZone', 'token', 'userCountryCode'] }
    };
  }
  return { identify, decode, decodeStatus, sources, commands, buildCommand, revision };
})();
if (typeof module !== 'undefined') module.exports = NanoVeSyncProtocol;
