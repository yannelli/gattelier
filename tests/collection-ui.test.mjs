import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/collection.js', import.meta.url), 'utf8');
const fields = { mode: 'passive', address: '', interval: '160', window: '80', period: '0', duration: '10' };
const ready = (extra = {}) => ({ usb: { mode: 'workbench' }, collection: {
  enabled: false, active: false, storageReady: true, persistenceReady: true, configSaved: true, savedEnabled: false,
  intervalMs: 160, windowMs: 80, periodMs: 0, burstMs: 10000, address: '', status: 'stopped', recordCount: 10, bootId: 123, bytes: 1024, ...extra,
} });
const response = result => ({ response: { ok: true, status: 200 }, result });
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(initial = ready()) {
  const controls = new Map(), apiChanges = [], timers = new Map(), calls = [], downloads = [];
  let current = initial, board = 'A', listener, nextTimer = 0;
  let reply = path => response(path === '/api/state' ? current : current.collection);
  let exportReply = () => ({ ok: true, blob: async () => 'log' });
  const get = id => {
    if (!controls.has(id)) {
      let value = fields[id] || '';
      controls.set(id, {
        get value() { return value; }, set value(next) { value = String(next); },
        checked: false, textContent: '', attributes: {}, handlers: {}, classes: new Set(),
        classList: { toggle(name, enabled) { if (enabled) get(id).classes.add(name); else get(id).classes.delete(name); } },
        addEventListener(type, callback) { this.handlers[type] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
      });
    }
    return controls.get(id);
  };
  get('form').reset = () => { for (const [id, value] of Object.entries(fields)) get(id).value = value; };
  apiChanges.push(() => listener({ ble: {}, services: [], devices: [] }, false));
  const context = vm.createContext({
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    addEventListener(type, callback) { if (type === 'nanoscope:api-change') apiChanges.push(callback); },
    document: { createElement: () => ({ click() { downloads.push(this.download); } }) },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    NanoAPI: {
      requestJson(path, body) { calls.push({ board, path, body }); return reply(path, body, board); },
      fetch(path) { calls.push({ board, path }); return exportReply(); },
    },
  });
  vm.runInContext(source + '\nglobalThis.collection = NanoCollection;', context);
  context.collection.mount({ querySelector: selector => get(selector.slice('#collection-'.length)) }, {
    onState(callback) { listener = callback; callback(current, true); },
  });
  return {
    get, calls, downloads,
    respond(callback) { reply = callback; }, exportResponse(callback) { exportReply = callback; },
    update(next, available = true) { current = next; listener(next, available); },
    change(next = ready(), target = 'B') { board = target; current = next; for (const callback of apiChanges) callback(); if (next) listener(next, true); },
    fire(id, type = 'click') { return get(id).handlers[type]({ preventDefault() {} }); },
    runTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Missing ${delay}ms timer`); timers.delete(entry[0]); entry[1].callback();
    },
  };
}

test('API changes reset drafts, destructive confirmations, and board facts before reconnecting', () => {
  const f = fixture(ready({ storageReady: false, error: 'Old storage error' }));
  f.get('interval').value = '320'; f.get('address').value = 'aa:bb:cc:dd:ee:ff'; f.fire('form', 'input');
  f.get('init-confirm').checked = f.get('clear-confirm').checked = true;
  f.change(null);
  assert.equal(f.get('interval').value, '160'); assert.equal(f.get('address').value, '');
  assert.equal(f.get('apply').hidden, true); assert.equal(f.get('state').textContent, 'Board unavailable');
  assert.equal(f.get('count').textContent, '0'); assert.equal(f.get('capacity').value, '0');
  assert.equal(f.get('storage').textContent, 'Checking…'); assert.equal(f.get('saved').textContent, 'Checking…');
  assert.equal(f.get('init-area').hidden, true); assert.equal(f.get('message').textContent, '');
  assert.equal(f.get('message').classes.has('error'), false);
  assert.equal(f.get('init-confirm').checked, false); assert.equal(f.get('clear-confirm').checked, false);
  assert.equal(f.get('export').getAttribute('aria-disabled'), 'true');
  f.update(ready({ intervalMs: 640, recordCount: 99 }));
  assert.equal(f.get('interval').value, '640'); assert.equal(f.get('count').textContent, '99');
  assert.equal(f.get('clear').disabled, true);
  f.fire('init'); f.fire('clear');
  assert.equal(f.calls.length, 0);
});

test('ordinary offline and reconnect updates preserve drafts and confirmations', async () => {
  const f = fixture();
  f.get('interval').value = '320'; f.fire('form', 'input');
  f.get('init-confirm').checked = f.get('clear-confirm').checked = true;
  f.update({ ble: {}, services: [], devices: [] }, false);
  assert.equal(f.get('state').textContent, 'Board unavailable'); assert.equal(f.get('apply').disabled, true);
  f.update(ready({ intervalMs: 640 }));
  assert.equal(f.get('interval').value, '320'); assert.equal(f.get('apply').hidden, false);
  assert.equal(f.get('init-confirm').checked, true); assert.equal(f.get('clear-confirm').checked, true);
  f.fire('form', 'submit'); await flush();
  assert.equal(f.calls[0].body.intervalMs, 320); assert.equal(f.calls[0].board, 'A');
  assert.equal(f.get('apply').hidden, true); assert.equal(f.get('init-confirm').checked, false);
  assert.equal(f.get('clear-confirm').checked, false); assert.equal(f.get('message').textContent, 'Collection settings applied.');
});

for (const failed of [false, true]) {
  test(`late operation ${failed ? 'failure' : 'success'} preserves the new board and its pending operation`, async () => {
    const old = deferred(), current = deferred();
    const f = fixture(ready({ enabled: true, status: 'collecting' }));
    f.respond((path, body, board) => board === 'A' ? old.promise : current.promise);
    const previous = f.fire('stop');
    f.change(ready({ enabled: true, status: 'scheduled', recordCount: 99 }));
    assert.equal(f.get('stop').disabled, false);
    f.get('interval').value = '640'; f.fire('form', 'input'); f.get('clear-confirm').checked = true;
    const next = f.fire('stop');
    if (failed) old.reject(new Error('Old stop failed')); else old.resolve(response(ready().collection));
    await previous;
    assert.equal(f.get('state').textContent, 'Waiting for next burst'); assert.equal(f.get('count').textContent, '99');
    assert.equal(f.get('message').textContent, 'Applying collection settings…'); assert.equal(f.get('stop').disabled, true);
    assert.equal(f.get('interval').value, '640'); assert.equal(f.get('apply').hidden, false); assert.equal(f.get('clear-confirm').checked, true);
    current.resolve(response(ready({ recordCount: 100 }).collection)); await next;
    assert.equal(f.get('count').textContent, '100'); assert.equal(f.get('message').textContent, 'Collection stopped.');
    assert.deepEqual(f.calls.map(call => call.board), ['A', 'B']);
  });

  test(`late refresh ${failed ? 'failure' : 'success'} preserves the new board and its pending refresh`, async () => {
    const old = deferred(), current = deferred(), f = fixture();
    f.respond((path, body, board) => board === 'A' ? old.promise : current.promise);
    const previous = f.fire('refresh'); f.change(ready({ recordCount: 99 }));
    assert.equal(f.get('refresh').disabled, false);
    const next = f.fire('refresh');
    f.update(ready({ recordCount: 99 }));
    if (failed) old.reject(new Error('Old refresh failed')); else old.resolve(response(ready().collection));
    await previous;
    assert.equal(f.get('count').textContent, '99'); assert.equal(f.get('message').textContent, '');
    assert.equal(f.get('refresh').disabled, true);
    current.resolve(response(ready({ recordCount: 100 }).collection)); await next;
    assert.equal(f.get('count').textContent, '100'); assert.equal(f.get('refresh').disabled, false);
  });
}

test('a sleeping verifier makes no follow-up request after API change and preserves a new verification', async () => {
  const f = fixture(ready({ enabled: true, status: 'collecting' }));
  const previous = f.fire('verify'); await flush();
  assert.match(f.get('verification').textContent, /Watching for new records/);
  f.change(ready({ recordCount: 99 }));
  assert.equal(f.get('verification').textContent, ''); assert.equal(f.get('verify').disabled, false);
  const current = deferred(); f.respond(() => current.promise);
  const next = f.fire('verify');
  f.runTimer(2500); await previous;
  assert.deepEqual(f.calls.map(call => call.board), ['A', 'B']);
  assert.equal(f.get('verification').textContent, 'Checking the board, saved settings, and log storage…');
  assert.equal(f.get('verify').disabled, true); assert.equal(f.get('count').textContent, '99');
  current.resolve(response(ready({ recordCount: 99 }))); await next;
  assert.equal(f.get('verify').disabled, false); assert.match(f.get('verification').textContent, /Collection is stopped/);
});

test('a sleeping verifier stops across API changes even after switching back', async () => {
  const f = fixture(ready({ enabled: true, status: 'collecting' }));
  const previous = f.fire('verify'); await flush();
  f.change(); f.change(ready({ enabled: true, status: 'collecting', recordCount: 99 }), 'A');
  f.runTimer(2500); await previous;
  assert.equal(f.calls.length, 1); assert.equal(f.get('verification').textContent, '');
  assert.equal(f.get('count').textContent, '99');
});

for (const phase of ['initial', 'observation']) {
  test(`late ${phase} verification response cannot replace the new board`, async () => {
    const f = fixture(ready({ enabled: true, status: 'collecting' })), old = deferred();
    if (phase === 'initial') f.respond(() => old.promise);
    const previous = f.fire('verify'); await flush();
    if (phase === 'observation') { f.respond(() => old.promise); f.runTimer(2500); await flush(); }
    f.change(ready({ recordCount: 99 }));
    old.resolve(response(ready({ enabled: true, status: 'collecting', recordCount: 11 }))); await previous;
    assert.equal(f.get('state').textContent, 'Stopped'); assert.equal(f.get('count').textContent, '99');
    assert.equal(f.get('verification').textContent, ''); assert.equal(f.get('verify').disabled, false);
    assert.equal(f.calls.every(call => call.board === 'A'), true);
  });
}

test('verification follows the same board through ordinary offline and reconnect updates', async () => {
  const before = ready({ enabled: true, status: 'collecting' }), f = fixture(before);
  const checking = f.fire('verify'); await flush();
  f.update(before, false); f.update(ready({ enabled: true, status: 'collecting', recordCount: 13 }));
  f.runTimer(2500); await checking;
  assert.equal(f.get('verification').textContent, 'Setup verified. 3 new records saved during the check.');
  assert.equal(f.get('verify').disabled, false); assert.deepEqual(f.calls.map(call => call.board), ['A', 'A']);
});

for (const phase of ['response', 'blob', 'error']) {
  test(`late export ${phase} cannot download or update the new board`, async () => {
    const old = deferred(), f = fixture();
    f.exportResponse(() => phase === 'response' ? old.promise : phase === 'error'
      ? { ok: false, status: 500, json: () => old.promise } : { ok: true, blob: () => old.promise });
    const exporting = f.fire('export'); await flush();
    f.change(ready({ recordCount: 99 }));
    old.resolve(phase === 'response' ? { ok: true, blob: async () => 'old log' } : phase === 'error' ? { error: 'Old export failed' } : 'old log');
    await exporting;
    assert.deepEqual(f.downloads, []); assert.equal(f.get('message').textContent, '');
    assert.equal(f.get('count').textContent, '99');
  });
}

test('same-board export downloads the collection log', async () => {
  const f = fixture(); await f.fire('export');
  assert.deepEqual(f.downloads, ['nanoscope-collection.ndjson']);
});
