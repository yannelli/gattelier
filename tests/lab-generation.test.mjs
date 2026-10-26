import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ready = { ble: { busy: false, connected: false }, devices: [], services: [] };
const target = { address: 'AA:BB:CC:DD:EE:FF', addressType: 0 };
const busy = { ...ready, ble: { ...target, busy: true, connected: false, operation: 'discovering', connectionAttempt: 42 } };
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(respond) {
  const calls = [], events = [], ingested = [], traffic = [], timers = new Map(), handlers = {};
  let nextTimer = 0, captureId = 0;
  const context = vm.createContext({ console, AbortController,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    NanoPackets: { createCapture() { const id = ++captureId; return {
      snapshot: () => ({ nextSeq: 0 }), ingest(body) { ingested.push({ id, body }); return { events: body.events || [], meta: {} }; },
    }; } },
    NanoConsole: { update() {}, mount() {} }, NanoTraffic: { mount() {}, connection: value => traffic.push(value), refresh() {} },
    document: { hidden: false, getElementById() {}, addEventListener() {}, dispatchEvent: event => events.push(event) },
    addEventListener: (type, callback) => { handlers[type] = callback; },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    NanoAPI: { async fetch(path, options) { calls.push({ path, options }); return await respond(path, options); } },
  });
  vm.runInContext(readFileSync(new URL('../web/lab.js', import.meta.url), 'utf8'), context);
  const lab = context.NanoLab;
  lab.init(); lab.update(ready, true);
  return { lab, calls, events, ingested, traffic, timers, change: () => handlers['nanoscope:api-change'](),
    runTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Missing ${delay}ms timer`);
      timers.delete(entry[0]); entry[1].callback();
    } };
}

test('transport change stops sleeping actions without clearing a newer action busy state', async () => {
  const write = deferred();
  let reads = 0;
  const f = fixture(path => path === 'write' ? write.promise : path === 'state' ? response(++reads === 1 ? busy : ready) : response({}, path === 'connect' ? 202 : 200));
  const old = f.lab.action('connect', target);
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await flush();
  f.change(); f.lab.update(ready, true);
  const current = f.lab.action('write', { handle: 8, hex: '00' });
  const start = f.calls.length, eventStart = f.events.length;
  f.runTimer(120);
  await rejected;
  assert.equal(f.calls.length, start);
  assert.equal(f.lab.isActing(), true);
  assert.equal(f.events.slice(eventStart).filter(event => event.type === 'nanoscope:busy').length, 0);
  write.resolve(response({}, 202));
  await current;
  assert.equal(f.lab.isActing(), false);
});

test('transport change rejects cancellation waiting for the old connect acceptance', async () => {
  const accepted = deferred();
  const f = fixture(path => path === 'connect' ? accepted.promise : response({}));
  const old = assert.rejects(f.lab.action('connect', target), { name: 'AbortError' });
  const cancel = assert.rejects(f.lab.action('cancel-connect', target), { name: 'AbortError' });
  f.change();
  accepted.resolve(response({ ...target, connectionAttempt: 42 }, 202));
  await Promise.all([old, cancel]);
  assert.equal(f.calls.some(call => call.path === 'cancel-connect' || call.path === 'state'), false);
  assert.equal(f.events.some(event => event.type === 'nanoscope:state'), false);
});

test('old cancellation response cannot query or publish state after transport change', async () => {
  const cancellation = deferred();
  const f = fixture(path => path === 'cancel-connect' ? cancellation.promise : response({}));
  f.lab.update(busy, true);
  const rejected = assert.rejects(f.lab.action('cancel-connect', { ...target, connectionAttempt: 42 }), { name: 'AbortError' });
  f.change();
  cancellation.resolve(response({}, 202));
  await rejected;
  assert.equal(f.calls.some(call => call.path === 'state'), false);
  assert.equal(f.events.some(event => event.type === 'nanoscope:state'), false);
});

test('old event response cannot enter the new capture or release its pending request', async () => {
  const old = deferred(), current = deferred();
  let requests = 0;
  const f = fixture(() => (++requests === 1 ? old.promise : current.promise));
  f.change();
  old.resolve(response({ events: [{ seq: 99 }] }));
  await flush();
  assert.equal(f.ingested.length, 0);
  assert.equal(f.traffic.length, 0);
  f.lab.setFastCapture(true);
  assert.equal([...f.timers.values()].some(timer => timer.delay === 0), false);
  current.resolve(response({ events: [{ seq: 1 }] }));
  await flush();
  assert.equal(f.ingested.length, 1);
  assert.equal(f.ingested[0].id, 2);
  assert.equal(f.ingested[0].body.events[0].seq, 1);
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 100).length, 1);
});
