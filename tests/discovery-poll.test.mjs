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
