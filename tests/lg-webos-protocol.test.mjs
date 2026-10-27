import test from 'node:test';
import assert from 'node:assert/strict';
import protocol from '../web/lg-webos-protocol.js';

const tv = { name: 'LG TV', manufacturer: 'c40001020304', services: ['0xFEB9'] };
const fields = value => Object.fromEntries(value.map(item => [item.label, item.value]));
const response = payload => ({ id: 'saved-1', type: 'response', payload: { returnValue: true, ...payload } });
const build = (id, values = {}) => protocol.buildCommand(id, { device: tv, ...values });

test('manufacturer and FEB9 establish vendor evidence without a TV identity', () => {
  for (const device of [{ manufacturer: 'c40001020304' }, { services: ['feb9'] }, { serviceData: [{ uuid: '0000feb9-0000-1000-8000-00805f9b34fb', hex: '00' }] }]) {
    const result = protocol.identify(device);
    assert.equal(result.title, 'LG Electronics BLE broadcast');
    assert.equal(result.category, 'vendor');
    assert.equal(fields(result.fields)['TV model'], undefined);
    assert.equal(fields(result.fields).Volume, undefined);
    assert.ok(result.limitations.some(value => value.includes('not the TV model')));
  }
  assert.equal(fields(protocol.identify({ manufacturer: 'c40001020304' }).fields)['Manufacturer payload HEX'], '01020304');
});

test('TV names remain candidates and company/service evidence has separate confidence', () => {
  assert.equal(protocol.identify({ name: 'LG TV' }).confidence, 'Name candidate');
  assert.equal(protocol.identify({ name: 'LG webOS TV' }).confidence, 'Name candidate');
  assert.equal(protocol.identify(tv).confidence, 'Service match');
  assert.equal(protocol.identify({ name: 'LG TV', manufacturer: 'c400' }).confidence, 'Manufacturer match');
  assert.equal(protocol.identify(tv).title, 'LG webOS TV candidate');
  for (const device of [null, {}, [], { name: 'LG dishwasher' }, { manufacturer: '00c4' }, { manufacturer: 'c400x' }, { services: ['feb8'] }]) assert.equal(protocol.identify(device), null);
  assert.ok(protocol.identify({ ...tv, payloadTruncated: true }).limitations.some(value => value.includes('incomplete')));
});

test('saved system/software responses preserve model versus software model distinctions', () => {
  const data = { modelName: 'TEST-TV', product_name: 'webOS', model_name: 'TEST_SOFTWARE_ID', major_ver: '05', minor_ver: '01.00' };
  assert.deepEqual(fields(protocol.decodeStatus(response(data))), { 'TV model': 'TEST-TV', 'Software product': 'webOS', 'Software model ID': 'TEST_SOFTWARE_ID', 'Firmware major version': '05', 'Firmware minor version': '01.00' });
  assert.deepEqual(protocol.decodeStatus(data), protocol.decodeStatus(response(data)));
});

test('flat and nested audio fields expose integer volume and boolean mute', () => {
  for (const payload of [{ volume: 12, muted: true }, { volume: 12, mute: true }, { volumeStatus: { volume: 12, muteStatus: true } }]) assert.deepEqual(fields(protocol.decodeStatus(response(payload))), { Volume: '12', Muted: 'Yes' });
  assert.equal(fields(protocol.decodeStatus({ volume: 0, mute: false })).Muted, 'No');
  assert.equal(fields(protocol.decodeStatus({ volume: 100 })).Volume, '100');
});

test('foreground app, installed apps, launch points and external inputs retain exact IDs', () => {
  assert.equal(fields(protocol.decodeStatus(response({ appId: 'com.webos.app.hdmi1' })))['Foreground app ID'], 'com.webos.app.hdmi1');
  assert.deepEqual(fields(protocol.decodeStatus(response({ apps: [{ id: 'com.example.test', title: 'Test app' }] }))), { 'Installed app count': '1', 'Installed app 1': 'Test app (com.example.test)' });
  assert.deepEqual(fields(protocol.decodeStatus({ launchPoints: [] })), { 'Launch point count': '0' });
  const inputs = fields(protocol.decodeStatus(response({ devices: [{ id: 'HDMI_1', label: 'HDMI 1', connected: false }] })));
  assert.equal(inputs['External input 1'], 'HDMI 1 (HDMI_1)');
  assert.equal(inputs['External input 1 connected'], 'No');
});

test('errors remain errors even when the failed payload includes status-looking fields', () => {
  assert.deepEqual(protocol.decodeStatus({ type: 'error', error: '403 insufficient permissions' }), [{ label: 'webOS error', value: '403 insufficient permissions' }]);
  assert.deepEqual(fields(protocol.decodeStatus(response({ returnValue: false, errorCode: 403, errorText: 'Denied', volume: 50 }))), { 'webOS result': 'Failed', 'webOS error code': '403', 'webOS error': 'Denied' });
});

test('malformed saved JSON and unsupported response shapes reject without coercion', () => {
  for (const value of [null, [], 'json', {}, { type: 'request', payload: {} }, { type: 'registered', payload: { 'client-key': 'secret' } }, { type: 'response', payload: [] }, { returnValue: 'true', volume: 1 }, { modelName: 4 }, { modelName: 'bad\nname' }, { volume: '12' }, { volume: 101 }, { volume: -1 }, { volume: 1.5 }, { volumeStatus: null }, { muted: 1 }, { mute: false, muted: true }, { apps: {} }, { apps: [null] }, { apps: [{ title: 'Missing ID' }] }, { devices: [{ id: 'HDMI_1', connected: 1 }] }, { apps: Array(513).fill({}) }, { returnValue: false, errorCode: {} }, { type: 'error', error: 403 }]) assert.throws(() => protocol.decodeStatus(value));
});

test('status previews contain complete SSAP request envelopes with external registration prerequisites', () => {
  const cases = { 'system-info': 'system/getSystemInfo', 'software-info': 'com.webos.service.update/getCurrentSWInformation', 'audio-status': 'audio/getStatus', 'volume-status': 'audio/getVolume', 'current-app': 'com.webos.applicationManager/getForegroundAppInfo', apps: 'com.webos.applicationManager/listApps', 'launch-points': 'com.webos.applicationManager/listLaunchPoints', inputs: 'tv/getExternalInputList', 'pointer-socket': 'com.webos.service.networkinput/getPointerInputSocket' };
  for (const [id, uri] of Object.entries(cases)) {
    const plan = build(id);
    assert.deepEqual(plan.request, { id: 'gattelier-1', type: 'request', uri: `ssap://${uri}`, payload: {} });
    assert.match(plan.transport, /LAN WebSocket/);
    assert.equal(plan.steps, undefined);
    assert.equal(plan.connection.requiresRegistration, true);
    assert.ok(plan.prerequisites.some(value => value.includes('client-key')));
    assert.ok(plan.connection.endpoints.every(value => value.includes('<TV-LAN-host>')));
  }
});

test('write previews encode source-backed volume, mute, input, launch and power messages', () => {
  for (const [id, values, uri, payload] of [
    ['volume', { volume: '0' }, 'audio/setVolume', { volume: 0 }], ['volume', { volume: 100 }, 'audio/setVolume', { volume: 100 }],
    ['mute', { muted: 'false' }, 'audio/setMute', { mute: false }], ['mute', { muted: true }, 'audio/setMute', { mute: true }],
    ['input', { inputId: 'HDMI_1' }, 'tv/switchInput', { inputId: 'HDMI_1' }],
    ['launch-app', { appId: 'com.example.app' }, 'system.launcher/launch', { id: 'com.example.app' }],
    ['volume-up', {}, 'audio/volumeUp', {}], ['volume-down', {}, 'audio/volumeDown', {}], ['power-off', {}, 'system/turnOff', {}]
  ]) assert.deepEqual(build(id, values).request, { id: 'gattelier-1', type: 'request', uri: `ssap://${uri}`, payload });
  assert.ok(build('power-off').warnings.some(value => value.includes('waking')));
});

test('registration and remote keys preserve distinct main and pointer socket protocols', () => {
  const registration = build('register').request;
  assert.equal(registration.type, 'register'); assert.equal(registration.id, 'register_0');
  assert.equal(registration.payload.pairingType, 'PROMPT'); assert.equal(registration.payload.forcePairing, false);
  assert.equal(registration.payload.manifest.manifestVersion, 1);
  assert.ok(registration.payload.manifest.permissions.includes('CONTROL_AUDIO'));
  assert.equal(registration.payload['client-key'], undefined);
  const key = build('remote-key', { key: 'HOME' });
  assert.equal(key.request.uri, 'ssap://com.webos.service.networkinput/getPointerInputSocket');
  assert.equal(key.followUp.message, 'type:button\nname:HOME\n\n');
  assert.match(key.followUp.endpoint, /socketPath/);
  registration.payload.manifest.permissions.push('TEST');
  assert.equal(build('register').request.payload.manifest.permissions.includes('TEST'), false);
});

test('unsupported operations, vendor-only targets and malformed command inputs are rejected', () => {
  for (const id of ['power-on', 'ble-write', 'unlock', '__proto__']) assert.throws(() => build(id));
  for (const device of [{ manufacturer: 'c4000102' }, { services: ['feb9'] }, {}]) assert.throws(() => protocol.buildCommand('volume-status', { device }));
  for (const value of ['01', '', '-1', '100.5', 101, Infinity, true]) assert.throws(() => build('volume', { volume: value }));
  for (const value of ['on', 1, null]) assert.throws(() => build('mute', { muted: value }));
  for (const key of ['POWER', 'HOME\nname:POWER', 'UNKNOWN']) assert.throws(() => build('remote-key', { key }));
  assert.throws(() => build('launch-app', { appId: 'com.example.app\n' }));
  assert.throws(() => build('volume-status', { host: '192.0.2.1' }));
});

test('builders and saved decoders perform no network operations', () => {
  const previousFetch = globalThis.fetch, previousSocket = globalThis.WebSocket;
  const forbidden = () => { throw new Error('Unexpected network operation'); };
  globalThis.fetch = forbidden; globalThis.WebSocket = forbidden;
  try {
    for (const command of protocol.commands) {
      const inputs = Object.fromEntries(command.inputs.map(input => [input.id, input.id === 'appId' ? 'com.example.app' : input.id === 'inputId' ? 'HDMI_1' : input.default]));
      assert.equal(build(command.id, inputs).execution, 'external-template');
    }
    assert.equal(protocol.decodeStatus(response({ volume: 4 }))[0].value, '4');
  } finally { globalThis.fetch = previousFetch; globalThis.WebSocket = previousSocket; }
  assert.equal(protocol.statusLabel, 'webOS response JSON');
  assert.ok(protocol.sources.every(source => /\/(?:blob|src)\/[0-9a-f]{40}\//.test(source.url)));
});
