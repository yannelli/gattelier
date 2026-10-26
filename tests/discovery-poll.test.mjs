import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url), { needsStatePoll } = require('../web/app.js');
test('scan transfers reuse recent board state without delaying actions or connection discovery', () => {
  const state = { ble: { scanning: true, advertisementStream: true, busy: false } };
  assert.equal(needsStatePoll(state, true, false, 1500), false);
  assert.equal(needsStatePoll(state, true, false, 2000), true);
  assert.equal(needsStatePoll(state, false, false, 0), true);
  assert.equal(needsStatePoll(state, true, true, 0), true);
  for (const ble of [{ busy: true }, { scanning: false }, { advertisementStream: false }]) {
    assert.equal(needsStatePoll({ ble: { ...state.ble, ...ble } }, true, false, 0), true);
  }
});
test('fast scan transfers keep status polling and rendering bounded, including background collection', async () => {
  let time = 10000, states = 0, transfers = 0, renders = 0;
  const timers = [], board = { uptime: 10, ble: { scanning: true, advertisementStream: true }, devices: [], services: [] };
  const context = vm.createContext({ module: { exports: {} }, require: createRequire(new URL('../web/app.js', import.meta.url)), AbortController,
    Date: { now: () => time }, clearTimeout() {}, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    NanoPWA: { reportConnection() {}, pollDelay: () => 30000 },
    fakeStore: { ingest() {}, getPreference: () => true },
    fakeStream: { async poll() { transfers++; }, status: () => ({ delay: 50, supported: true }) },
    fakeRequest: async () => { states++; return board; }, renderCount: () => { renders++; } });
  vm.runInContext(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext('document = {hidden: false}; scanStore = fakeStore; scanStream = fakeStream; request = fakeRequest; render = () => {lastRender = Date.now(); renderCount();};', context);
  await vm.runInContext('poll()', context);
  time += 50; await vm.runInContext('poll({streamOnly:true})', context);
  assert.equal(states, 1); assert.equal(transfers, 2); assert.equal(renders, 1);
  time += 500; await vm.runInContext('poll({streamOnly:true})', context);
  assert.equal(states, 1); assert.equal(renders, 2);
  time += 1500; await vm.runInContext('poll({streamOnly:true})', context);
  assert.equal(states, 2); assert.equal(renders, 3);
  time += 1000; await vm.runInContext('document.hidden = true; tick()', context);
  assert.equal(transfers, 5); assert.equal(renders, 3); assert.equal(timers.at(-1).delay, 1000);
  await vm.runInContext('poll()', context); assert.equal(states, 3);
});

function pollingFixture() {
  const board = { wifi: {}, ble: { connected: true, busy: true, operation: 'discovering', advertisementStream: true }, devices: [], services: [] };
  const reports = [], handlers = {};
  let offline = 0, transfers = 0, connected = true;
  const context = vm.createContext({ module: { exports: {} }, require: createRequire(new URL('../web/app.js', import.meta.url)), AbortController, setTimeout, clearTimeout,
    NanoPWA: { reportConnection: value => reports.push(value) },
    NanoAPI: { transport: () => 'serial', serialStatus: () => ({ connected, error: '' }) },
    board, handlers, fakeStore: { ingest() {}, setOffline() { offline++; } },
    fakeStream: { async poll() { transfers++; }, status: () => ({ supported: true }) },
    fakeRequest: async () => { throw new DOMException('Request timed out.', 'AbortError'); } });
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  vm.runInContext('document = {hidden: false, addEventListener(type, callback) { handlers[type] = callback; }}; scanStore = fakeStore; scanStream = fakeStream; state = board; online = true; request = fakeRequest; render = () => {};', context);
  vm.runInContext(source.split('\n').find(line => line.includes("document.addEventListener('nanoscope:state'")), context);
  return { context, board, handlers, reports, offline: () => offline, transfers: () => transfers, disconnect: () => { connected = false; } };
}

test('USB caller timeout preserves established availability and the next state clears its notice', async () => {
  const f = pollingFixture();
  await vm.runInContext('poll()', f.context);
  assert.equal(vm.runInContext('online', f.context), true);
  assert.equal(f.offline(), 0);
  assert.deepEqual(f.reports, [true]);
  assert.match(vm.runInContext('transportError', f.context), /refresh is delayed/);
  f.handlers['nanoscope:state']({ detail: f.board });
  assert.equal(vm.runInContext('transportError', f.context), '');
  f.disconnect();
  await vm.runInContext('poll()', f.context);
  assert.equal(vm.runInContext('online', f.context), false);
  assert.equal(f.offline(), 1);
});

test('USB timeout does not establish availability before a successful board response', async () => {
  const f = pollingFixture();
  vm.runInContext('online = false;', f.context);
  await vm.runInContext('poll()', f.context);
  assert.equal(vm.runInContext('online', f.context), false);
});

test('advertisement polling pauses during BLE operations and resumes with scanning', async () => {
  const f = pollingFixture();
  vm.runInContext('request = async () => board;', f.context);
  for (const ble of [
    { scanning: true, busy: true, connected: false },
    { scanning: true, busy: false, connected: true },
    { scanning: false, busy: false, connected: false },
  ]) {
    Object.assign(f.board.ble, ble);
    await vm.runInContext('poll()', f.context);
    assert.equal(f.transfers(), 0);
  }
  Object.assign(f.board.ble, { scanning: true, busy: false, connected: false });
  await vm.runInContext('poll()', f.context);
  assert.equal(f.transfers(), 1);
});
