import test from 'node:test';
import assert from 'node:assert/strict';
import protocol from '../web/vesync-protocol.js';

const advertisement = { name: 'Core200S', manufacturer: 'd006010200000000000123020202' };
const encode = text => Buffer.from(text).toString('hex');
const values = fields => Object.fromEntries(fields.map(field => [field.label, field.value]));
const detail = { enabled: true, filter_life: 83, mode: 'manual', level: 2, display: false, child_lock: true, night_light: 'dim', configuration: { display: false, display_forever: false }, device_error_code: 0 };
const envelope = result => ({ code: 0, result: { code: 0, result } });

test('observed Core200S advertisement identifies a purifier without inventing operating state', () => {
  const result = protocol.identify(advertisement);
  assert.equal(result.title, 'Levoit Core 200S'); assert.equal(result.category, 'appliance'); assert.equal(result.confidence, 'high');
  const fields = values(result.fields);
  assert.equal(fields['Bluetooth company'], 'Etekcity Corporation (0x06D0)');
  assert.equal(fields['Vendor payload'], '010200000000000123020202');
  assert.equal(fields['Modes'], 'Manual, sleep'); assert.equal(fields['Fan speeds'], '1, 2, 3');
  assert.equal(Object.hasOwn(fields, 'Power'), false); assert.equal(Object.hasOwn(fields, 'Humidity'), false);
  assert.ok(result.limitations.some(text => text.includes('No vendor BLE command')));
  assert.ok(result.sources.some(source => source.url.includes(protocol.revision)));
});

test('matching accepts casing and documented regional aliases, and separates other VeSync products', () => {
  for (const name of ['Core200s', 'CORE200S', 'Core 200S', 'LAP-C201S-AUSR', 'LAP-C202S-WUSR']) assert.ok(protocol.identify({ ...advertisement, name }));
  for (const name of ['Etekcity', 'ESF-551', 'Core300S', 'Vital200S', 'LV600S', 'Dual200S', 'Levoit', 'Core200S fake']) assert.equal(protocol.identify({ ...advertisement, name }), null);
  assert.equal(protocol.identify({ manufacturer: advertisement.manufacturer }), null);
  assert.equal(protocol.identify({ ...advertisement, manufacturer: '4c0001' }), null);
  assert.equal(protocol.identify({ ...advertisement, manufacturer: 'd0' }), null);
  assert.equal(protocol.identify({ ...advertisement, manufacturer: 'd0060' }), null);
  assert.equal(protocol.identify({ ...advertisement, manufacturer: 'd006zz' }), null);
  assert.equal(protocol.identify({ name: 'Core200S' }).confidence, 'medium');
});

test('native GATT decoding is restricted to standard identity and battery fields', () => {
  assert.deepEqual(protocol.decode('00002a24-0000-1000-8000-00805f9b34fb', encode('Core200S')), [{ label: 'Model number', value: 'Core200S' }]);
  assert.deepEqual(protocol.decode('0x2a29', encode('Levoit\0')), [{ label: 'Manufacturer name', value: 'Levoit' }]);
  assert.deepEqual(protocol.decode('2a19', '64'), [{ label: 'Battery level', value: '100%' }]);
  for (const uuid of ['fff1', 'fff2', 'f000ffe2-0451-4000-b000-000000000000']) assert.deepEqual(protocol.decode(uuid, 'a5010203'), []);
  for (const hex of ['65', '', '0102', 'zz', '0']) assert.throws(() => protocol.decode('2a19', hex));
  for (const hex of ['ff', '410042', '1b', '']) assert.throws(() => protocol.decode('2a24', hex));
});

test('pasted bypassV2 details decode exact Core200S status fields', () => {
  const parsed = values(protocol.decodeStatus(envelope(detail)));
  assert.deepEqual(parsed, { Power: 'On', Display: 'Off', 'Child lock': 'On', 'Fan speed': '2', 'Filter life': '83%', 'Device error code': '0', Mode: 'manual', 'Night light': 'dim', 'Configured display': 'Off', 'Display stays on': 'Off' });
  assert.deepEqual(protocol.decodeStatus(detail), protocol.decodeStatus(envelope(detail)));
  assert.equal(values(protocol.decodeStatus({ ...detail, enabled: false, level: 0 }))['Fan speed'], '0');
  const extra = protocol.decodeStatus({ ...detail, air_quality_value: 42, humidity: 50, unknown: 'ignored' });
  assert.equal(extra.some(field => /PM2|Humidity|Air quality/.test(field.label)), false);
});

test('timers and optional Core response extension fields use seconds and reject inconsistent durations', () => {
  assert.deepEqual(protocol.decodeStatus(envelope({ timers: [{ id: 7, remain: 900, total: 3600, action: 'off' }] })), [{ label: 'Timer 7', value: 'Off in 900 s (3600 s total)' }]);
  assert.deepEqual(protocol.decodeStatus({ timers: null }), [{ label: 'Timer', value: 'None' }]);
  const parsed = values(protocol.decodeStatus({ extension: { timer_remain: 120, schedule_count: 2 } }));
  assert.equal(parsed['Timer remaining'], '120 s'); assert.equal(parsed.Schedules, '2');
  for (const timers of [[{ id: 1, remain: 11, total: 10, action: 'off' }], [{ id: 1, remain: 1, total: 10, action: 'on' }], [null], Array(33).fill({})]) assert.throws(() => protocol.decodeStatus({ timers }));
});

test('status decoding rejects failed envelopes, wrong types, unsupported modes and out-of-range values', () => {
  for (const input of [null, [], 'json', {}, { code: 1, result: detail }, { code: 0, result: { code: 3, result: detail } }, { code: 0, result: [] }, { enabled: 1 }, { ...detail, enabled: null }, { display: 'on' }, { child_lock: 0 }, { level: 4 }, { level: -1 }, { level: 1.5 }, { ...detail, level: null }, { levelNew: 4 }, { filter_life: 101 }, { filter_life: '80' }, { ...detail, filter_life: null }, { mode: 'auto' }, { night_light: true }, { night_light: 'bright' }, { device_error_code: Infinity }, { configuration: [] }, { configuration: { display: 1 } }, { extension: { timer_remain: -1 } }]) assert.throws(() => protocol.decodeStatus(input));
});

test('cloud builders match published Core200S request fixtures without producing BLE writes', () => {
  const cases = [
    ['status', {}, 'getPurifierStatus', {}],
    ['timer-status', {}, 'getTimer', {}],
    ['power', { state: 'on' }, 'setSwitch', { enabled: true, id: 0 }],
    ['power', { state: 'off' }, 'setSwitch', { enabled: false, id: 0 }],
    ['fan-speed', { speed: 3 }, 'setLevel', { id: 0, level: 3, type: 'wind' }],
    ['mode', { mode: 'manual', speed: 2 }, 'setLevel', { id: 0, level: 2, type: 'wind' }],
    ['mode', { mode: 'sleep' }, 'setPurifierMode', { mode: 'sleep' }],
    ['child-lock', { state: 'off' }, 'setChildLock', { child_lock: false }],
    ['display', { state: 'on' }, 'setDisplay', { state: true }],
    ['night-light', { mode: 'dim' }, 'setNightLight', { night_light: 'dim' }]
  ];
  for (const [id, input, method, data] of cases) {
    const plan = protocol.buildCommand(id, input);
    assert.equal(plan.transport, 'vesync-cloud'); assert.equal(plan.execution, 'external-template');
    assert.equal(plan.request.method, 'POST'); assert.equal(plan.request.url, 'https://smartapi.vesync.com/cloud/v2/deviceManaged/bypassV2');
    assert.deepEqual(plan.request.body, { method: 'bypassV2', payload: { method, source: 'APP', data } });
    assert.equal(plan.steps, undefined); assert.equal(plan.request.body.token, undefined); assert.equal(plan.request.body.accountID, undefined);
    assert.ok(plan.request.requiredContext.includes('token')); assert.ok(plan.request.requiredContext.includes('cid'));
  }
  assert.equal(protocol.buildCommand('power', { region: 'eu' }).request.url, 'https://smartapi.vesync.eu/cloud/v2/deviceManaged/bypassV2');
  assert.ok(protocol.buildCommand('fan-speed', { speed: 2 }).warnings.some(text => text.includes('turns the purifier on')));
});

test('command input validation rejects unsupported model options and credential material', () => {
  for (const [id, input] of [['unknown', {}], ['constructor', {}], ['power', { state: true }], ['power', { state: 'toggle' }], ['power', { region: 'cn' }], ['power', { token: undefined }], ['power', { password: undefined }], ['power', null], ['power', []], ['fan-speed', { speed: 4 }], ['fan-speed', { speed: 0 }], ['fan-speed', { speed: 2.5 }], ['fan-speed', { speed: '2.0' }], ['fan-speed', { speed: NaN }], ['mode', { mode: 'auto' }], ['night-light', { mode: 'warm' }]]) assert.throws(() => protocol.buildCommand(id, input));
  assert.equal(protocol.buildCommand('fan-speed', { speed: '2' }).request.body.payload.data.level, 2);
  const first = protocol.buildCommand('power'); first.request.body.payload.data.enabled = false;
  assert.equal(protocol.buildCommand('power').request.body.payload.data.enabled, true);
});
