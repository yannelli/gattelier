import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const model = require('../web/recipe-model.js');
const { createRunner } = require('../web/recipes.js');
const packets = require('../web/packets.js');
const address = 'aa:bb:cc:dd:ee:ff';
const recipe = steps => ({ version: 1, name: 'Test recipe', steps });
const step = (action, extra = {}) => ({ action, uuid: '2a19', ...extra });
const state = () => ({ ble: { connected: true, busy: false, address, addressType: 0, connectionAttempt: 1, mtu: 23 }, services: [{ uuid: '180f', characteristics: [{ uuid: '2a19', handle: 12, properties: ['read', 'write', 'write-no-response', 'notify'] }] }] });

function fixture(onAction = () => {}) {
  let current = state(), sequence = 0, bootId = 'boot-1', active = false;
  const eventListeners = [], stateListeners = [], actions = [], updates = [], fast = [];
  const emit = (events = [], meta = {}) => {
    const batch = events.map(event => ({ address, uuid: '2a19', handle: 12, success: true, ...event, seq: ++sequence }));
    eventListeners.forEach(listener => listener(batch, { bootId, cursor: sequence, nextSeq: sequence, dropped: 0, gaps: 0, ...meta }));
  };
  const setState = next => { current = next; stateListeners.forEach(listener => listener(current, true)); };
  const lab = {
    getState: () => current, isActing: () => active,
    onState: listener => { stateListeners.push(listener); listener(current, true); }, onEvents: listener => eventListeners.push(listener),
    setFastCapture: enabled => { fast.push(enabled); if (enabled) queueMicrotask(() => emit()); },
    async action(action, body) { active = true; actions.push({ action, body }); try { await onAction(action, body, { emit, setState }); return current; } finally { active = false; } }
  };
  const runner = createRunner(lab, { onUpdate: update => updates.push(update) });
  return { runner, actions, updates, fast, emit, setState, reboot: () => { bootId = 'boot-2'; emit([], { reboot: true }); } };
}

test('recipe validation normalizes UUIDs, target address and per-action defaults', () => {
  const normalized = model.validate({ ...recipe([step('read'), step('write', { hex: 'AbCD' }), step('subscribe'), step('wait')]), address: address.toUpperCase() });
  assert.equal(normalized.address, address);
  assert.equal(normalized.steps[0].uuid, '00002a19-0000-1000-8000-00805f9b34fb');
  assert.equal(normalized.steps[0].timeoutMs, 10000);
  assert.equal(normalized.steps[1].response, true); assert.equal(normalized.steps[1].hex, 'abcd');
  assert.equal(normalized.steps[2].mode, 'notify'); assert.equal(normalized.steps[3].prefix, '');
  assert.equal(model.example().steps[0].action, 'read');
});

test('recipe schema rejects unsupported keys, actions, targets, sizes and malformed bytes', () => {
  const invalid = [
    { ...recipe([step('read')]), version: 2 }, recipe([]), recipe(Array.from({ length: 33 }, () => step('read'))),
    { ...recipe([step('read')]), name: ' ' }, { ...recipe([step('read')]), address: 'wrong' },
    recipe([step('connect')]), recipe([step('constructor')]), recipe([step('read', { hex: 'aa' })]),
    recipe([step('write', { hex: 'a' })]), recipe([step('write', { hex: 'zz' })]), recipe([step('write', { hex: 'ab '.repeat(3) })]),
    recipe([step('write', { hex: 'aa'.repeat(513) })]), recipe([step('write', { hex: '', response: 'true' })]),
    recipe([step('wait', { timeoutMs: 99 })]), recipe([step('wait', { timeoutMs: 30001 })]),
    recipe([step('subscribe', { mode: 'both' })]), recipe([step('read', { instance: 0 })]),
    recipe([step('read', { service: '180f', instance: -1 })]), recipe([step('read', { uuid: '00002a19-1234' })])
  ];
  for (const input of invalid) assert.throws(() => model.validate(input));
  assert.throws(() => model.validate({ ...recipe([step('read')]), name: 'x'.repeat(65537) }), /64 KiB/);
});

test('fresh resolution checks ambiguity, custom UUIDs, properties and MTU', () => {
  const current = state();
  const normalized = action => model.validate(recipe([action])).steps[0];
  assert.equal(model.resolve(current, normalized(step('read'))).handle, 12);
  assert.throws(() => model.resolve(current, normalized(step('subscribe', { mode: 'indicate' }))), /support/);
  assert.throws(() => model.resolve(current, normalized(step('write', { hex: 'aa'.repeat(21), response: false }))), /MTU/);
  const custom = '00002a19-1234-1000-8000-00805f9b34fb';
  assert.throws(() => model.resolve(current, normalized(step('read', { uuid: custom }))), /unavailable/);
  current.services[0].characteristics.push({ uuid: '0x2a19', handle: 20, properties: ['read'] });
  assert.throws(() => model.resolve(current, normalized(step('read', { service: '180f' }))), /ambiguous/);
  assert.equal(model.resolve(current, normalized(step('read', { service: '180f', instance: 1 }))).handle, 20);
  assert.throws(() => model.resolve(current, normalized(step('read', { service: '180f', instance: 2 }))), /unavailable/);
});

test('recognized authentication payloads stay out of saved and exported recipes', () => {
  assert.equal(model.canStore(model.validate(recipe([step('write', { hex: '41505026534b26616263' })])), packets.sensitive), false);
  assert.equal(model.canStore(model.validate(recipe([step('write', { uuid: '2bb1', hex: '10fe0300abcd' })])), packets.sensitive), false);
  assert.equal(model.canStore(model.validate(recipe([step('wait', { prefix: '41505026534b26' })])), packets.sensitive), false);
  assert.equal(model.canStore(model.validate(recipe([step('write', { hex: '0102' })])), packets.sensitive), true);
});

test('runner consumes fast write replies in order and reports read values', async () => {
  const f = fixture(async (action, body, { emit }) => {
    if (action === 'write') emit([{ kind: 'notification', hex: 'aabb' }, { kind: 'notification', hex: 'ccdd' }]);
    if (action === 'read') emit([{ kind: 'read', hex: '64' }]);
  });
  await f.runner.execute(recipe([step('subscribe'), step('write', { hex: '01' }), step('wait', { prefix: 'aa' }), step('wait', { prefix: 'cc' }), step('read')]));
  assert.deepEqual(f.actions.map(item => item.action), ['subscribe', 'write', 'read']);
  assert.deepEqual(f.updates.filter(item => item.status === 'Complete').map(item => item.result), ['Subscription notify', '1 bytes sent with response', 'aabb', 'ccdd', '64']);
  assert.deepEqual(f.fast, [true, false]);
});

test('recipe reads ignore retained packets from another address type or connection attempt', async () => {
  for (const scope of [{ addressType: 1 }, { connectionAttempt: 0 }]) {
    const f = fixture(async (action, _body, { emit }) => {
      if (action === 'read') emit([
        { kind: 'disconnect', ...scope },
        { kind: 'read', hex: 'ff', success: false, message: 'Old read failed.', ...scope },
        { kind: 'read', hex: '64', addressType: 0, connectionAttempt: 1 }
      ]);
    });
    await f.runner.execute(recipe([step('read')]));
    assert.equal(f.updates.find(item => item.status === 'Complete').result, '64');
  }
});

test('notification waits reject stale, wrong-UUID and already consumed replies', async () => {
  const f = fixture(async (action, body, { emit }) => {
    if (action === 'write') emit([{ kind: 'notification', hex: 'aa', uuid: '2a20' }, { kind: 'notification', hex: 'bb' }]);
  });
  f.emit([{ kind: 'notification', hex: 'cc' }]);
  await assert.rejects(f.runner.execute(recipe([step('write', { hex: '01' }), step('wait', { prefix: 'bb' }), step('wait', { prefix: 'bb', timeoutMs: 100 })])), /timed out/);
  assert.equal(f.updates.filter(item => item.status === 'Complete' && item.action === 'wait').length, 1);
});

test('cancellation during an in-flight action prevents later commands', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const f = fixture(async action => { if (action === 'write') { started(); await new Promise(resolve => { release = resolve; }); } });
  const task = f.runner.execute(recipe([step('write', { hex: '01' }), step('read')]));
  await began; f.runner.cancel();
  await assert.rejects(task, /Cancelled/); release();
  assert.equal(f.actions.length, 1); assert.equal(f.runner.running(), false); assert.deepEqual(f.fast, [true, false]);
});

test('replacement connections with the same address stop remaining recipe steps', async () => {
  for (const change of [{ addressType: 1 }, { connectionAttempt: 2 }]) {
    const f = fixture(async (action, body, { emit, setState }) => {
      if (action === 'write') setState({ ...state(), ble: { ...state().ble, ...change } });
      if (action === 'read') emit([{ kind: 'read', hex: '64' }]);
    });
    await assert.rejects(f.runner.execute(recipe([step('write', { hex: '01' }), step('read')])), /connection changed/);
    assert.deepEqual(f.actions.map(item => item.action), ['write']);
    assert.equal(f.runner.running(), false); assert.deepEqual(f.fast, [true, false]);
  }
});

test('capture gaps, truncated packets and disconnects stop remaining steps', async () => {
  for (const reason of ['gap', 'truncated', 'disconnect', 'reboot']) {
    const f = fixture(async (action, body, { emit, setState }) => {
      if (action !== 'write') return;
      if (reason === 'gap') emit([], { dropped: 1 });
      if (reason === 'truncated') emit([{ kind: 'notification', hex: 'aa', truncated: true }]);
      if (reason === 'disconnect') setState({ ...state(), ble: { connected: false, address: '' } });
      if (reason === 'reboot') f.reboot();
    });
    await assert.rejects(f.runner.execute(recipe([step('write', { hex: '01' }), step('read')])), /gap|truncated|connection changed|restarted/);
    assert.equal(f.actions.length, 1);
  }
});

test('target mismatch prevents commands and runtime authentication write results are redacted', async () => {
  const f = fixture();
  await assert.rejects(f.runner.execute({ ...recipe([step('read')]), address: '00:00:00:00:00:01' }), /does not match/);
  assert.equal(f.actions.length, 0);
  const g = fixture(async (action, body, { emit }) => emit([{ kind: 'read', hex: '41505026534b26616263' }]));
  await g.runner.execute(recipe([step('read')]));
  assert.equal(g.updates.find(item => item.status === 'Complete').result, 'Read payload redacted');
});

test('recipes retain an optional Bluetooth address type bound to their target address', () => {
  for (const addressType of [0, 1, 2, 3]) {
    const value = model.validate({ ...recipe([step('read')]), address, addressType });
    assert.equal(value.addressType, addressType);
    assert.equal(model.validate(JSON.parse(JSON.stringify(value))).addressType, addressType);
  }
  for (const addressType of [-1, 4, 0.5, '0', true, null, NaN]) assert.throws(() => model.validate({ ...recipe([step('read')]), address, addressType }), /address type/);
  assert.throws(() => model.validate({ ...recipe([step('read')]), addressType: 0 }), /requires a target address/);
});

test('typed recipe targets reject another address type before capture or commands', async () => {
  const f = fixture(); f.setState({ ...state(), ble: { ...state().ble, addressType: 1 } });
  await assert.rejects(f.runner.execute({ ...recipe([step('write', { hex: '01' })]), address, addressType: 0 }), /address type/);
  assert.deepEqual(f.actions, []); assert.deepEqual(f.fast, []);
});

test('matching typed targets, address-only recipes, and portable recipes remain executable', async () => {
  for (const target of [{ address, addressType: 1 }, { address }, {}]) {
    const f = fixture(async (_action, _body, { emit }) => emit([{ kind: 'read', hex: '64' }]));
    f.setState({ ...state(), ble: { ...state().ble, addressType: 1 } });
    await f.runner.execute({ ...recipe([step('read')]), ...target });
    assert.equal(f.actions.length, 1); assert.equal(f.updates.at(-1).status, 'Recipe complete');
  }
});

test('a read step ignores read results buffered before its command started', async () => {
  for (const old of [{ hex: '11' }, { hex: '', success: false, message: 'An earlier read failed' }]) {
    const f = fixture(async (action, _body, { emit }) => {
      if (action === 'write') emit([{ kind: 'read', ...old }]);
      if (action === 'read') emit([{ kind: 'read', hex: '22' }]);
    });
    await f.runner.execute(recipe([step('write', { hex: '01' }), step('read')]));
    assert.equal(f.updates.find(item => item.status === 'Complete' && item.action === 'read').result, '22');
  }
});
