import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import schlage from '../web/schlage-protocol.js';

const source = readFileSync(new URL('../web/schlage.js', import.meta.url), 'utf8');
const lock = { address: '02:00:00:00:00:01', addressType: 0, name: 'SCHLAGE0012287A' };
const other = { ...lock, address: '02:00:00:00:00:02' };
const characteristic = (uuid, handle, properties = ['read'], value = '') => ({ uuid, handle, properties, valueHex: Buffer.from(value).toString('hex') });
const initial = (target = lock, attempt = 7) => ({ ble: { ...target, connected: true, busy: false, connectionAttempt: attempt }, services: [
  { uuid: '180a', characteristics: [characteristic('2a24', 11, ['read'], 'BE489WB'), characteristic('2a29', 12, ['read'], 'Schlage'), characteristic('2a19', 13), characteristic('2a25', 14, ['write'])] },
  { uuid: schlage.transport, characteristics: [characteristic(schlage.tx, 21, ['indicate']), characteristic(schlage.rx, 22)] }
] });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = () => new Promise(setImmediate);

function harness({ action, ensure, state = initial() } = {}) {
  let selected = lock, origin = 'http://board-a.local', mode = 'http', onState, exported;
  const events = new Map(), globalEvents = new Map(), calls = [], connections = [], storage = new Map();
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.ownText = ''; this.value = ''; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.ownText = ''; this.children = children; }
    setAttribute() {}
    addEventListener(type, callback) { this.listeners[type] = callback; }
    click() { return this.disabled ? undefined : this.listeners.click?.(); }
  }
  const container = new Element('section'), lab = {
    getState: () => state,
    onState(callback) { onState = callback; callback(state, true); },
    async action(path, body) {
      calls.push({ path, ...JSON.parse(JSON.stringify(body)), origin, mode, attempt: state.ble.connectionAttempt });
      return action ? action(path, body) : state;
    }
  };
  const context = { NanoSchlage: schlage, NanoAPI: { origin: () => origin, transport: () => mode }, NanoConnection: {
    snapshot: () => ({ selected }),
    describe: target => ({ enabled: Boolean(target), connected: Boolean(state.ble.connected && schlage.same(target, state.ble)) }),
    ensure(target) { connections.push(target); return ensure ? ensure(target) : Promise.resolve(state); }
  }, document: { createElement: tag => new Element(tag), addEventListener: (type, callback) => events.set(type, callback) },
    addEventListener: (type, callback) => globalEvents.set(type, callback),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Blob, URL: { createObjectURL(blob) { exported = blob; return 'blob:fixture'; }, revokeObjectURL() {} }, setTimeout: callback => callback(),
    fetch() { throw new Error('Hardware access is forbidden.'); }
  };
  vm.runInNewContext(source + '\nthis.app = NanoSchlageApp;', context);
  const app = context.app.mount(container, lab, { selected: () => selected });
  const all = () => { const nodes = []; const visit = node => { nodes.push(node); node.children.forEach(visit); }; visit(container); return nodes; };
  return { app, container, calls, connections, storage,
    button: label => all().find(node => node.tag === 'button' && node.ownText === label),
    status: () => all().find(node => node.className === 'protocol-message').textContent,
    location: () => all().find(node => node.tag === 'input'),
    exported: async () => JSON.parse(await exported.text()),
    get state() { return state; },
    update(value) { state = value; onState(state, true); },
    select(target) { selected = target; events.get('nanoscope:selection')(); },
    endpoint(value = origin, transport = mode) { origin = value; mode = transport; globalEvents.get('nanoscope:api-change')?.(); onState(state, true); }
  };
}

test('viewing and exporting cached identity stay local and scoped to lock, address type and endpoint', async () => {
  const h = harness();
  assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
  h.location().value = 'Front door'; h.button('Save to inventory').click();
  h.update({ ble: {}, services: [] });
  assert.match(h.container.textContent, /Saved snapshot/); assert.match(h.container.textContent, /BE489WB/);
  assert.match(h.container.textContent, /handle 21/);
  for (const target of [other, { ...lock, addressType: 1 }]) {
    h.select(target); assert.doesNotMatch(h.container.textContent, /BE489WB|handle 21|Saved snapshot/); assert.equal(h.location().value, '');
  }
  h.select(lock); assert.equal(h.location().value, 'Front door');
  h.endpoint('http://board-b.local'); assert.doesNotMatch(h.container.textContent, /BE489WB|handle 21|Saved snapshot/);
  h.endpoint('http://board-a.local'); assert.match(h.container.textContent, /BE489WB/);
  h.button('Export snapshot').click();
  const snapshot = await h.exported();
  assert.equal(snapshot.identity.model, 'BE489WB'); assert.equal(snapshot.label, 'Front door');
  assert.equal(snapshot.scope, 'http://board-a.local:02:00:00:00:00:01/0');
  assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
});

test('identity reads retain the Device Information read allowlist', async () => {
  const h = harness(); await h.button('Read identity').click();
  assert.deepEqual(h.calls.map(({ path, handle }) => ({ path, handle })), [{ path: 'read', handle: 11 }, { path: 'read', handle: 12 }]);
  assert.equal(h.status(), 'Read 2 identity fields.'); assert.equal(h.button('Read identity').disabled, false);
});

test('pending connection results cannot read after lock, address type, endpoint or transport changes', async () => {
  for (const change of [
    h => h.select(other), h => h.select({ ...lock, addressType: 1 }),
    h => { h.select(other); h.select(lock); },
    h => h.endpoint('http://board-b.local'),
    h => { h.endpoint('http://board-b.local'); h.endpoint('http://board-a.local'); },
    h => h.endpoint('http://board-a.local', 'serial'), h => h.endpoint()
  ]) {
    const pending = deferred(), h = harness({ ensure: () => pending.promise });
    const operation = h.button('Read identity').click(); change(h); pending.resolve(initial()); await operation;
    assert.deepEqual(h.calls, []); assert.equal(h.status(), ''); assert.equal(h.button('Read identity').disabled, false);
  }
});

test('old connection errors stay cleared after leaving and returning to a lock or endpoint', async () => {
  for (const change of [h => { h.select(other); h.select(lock); }, h => h.endpoint(), h => { h.endpoint('http://board-b.local'); h.endpoint('http://board-a.local'); }]) {
    const pending = deferred(), h = harness({ ensure: () => pending.promise });
    const operation = h.button('Read identity').click(); change(h); pending.reject(new Error('Old connection failed.')); await operation;
    assert.equal(h.status(), ''); assert.deepEqual(h.calls, []);
  }
  const h = harness({ ensure: () => Promise.reject(new Error('Encryption required.')) });
  await h.button('Read identity').click(); assert.equal(h.status(), 'Encryption required.'); assert.equal(h.button('Read identity').disabled, false);
});

test('reconnection stops old handles and discards pending read completions and errors', async () => {
  for (const reject of [false, true]) {
    const pending = deferred(), h = harness({ action: () => pending.promise });
    const operation = h.button('Read identity').click(); await flush();
    const next = initial(lock, 8); next.services[0].characteristics.forEach(item => { item.handle += 100; }); h.update(next);
    if (reject) pending.reject(new Error('Old read failed.')); else pending.resolve(initial());
    await operation;
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].handle, 11); assert.equal(h.status(), '');
    assert.equal(h.button('Read identity').disabled, false);
  }
});

test('a final pending read cannot report success after the connection changes', async () => {
  const pending = deferred(); let reads = 0;
  const h = harness({ action: () => ++reads === 1 ? Promise.resolve(initial()) : pending.promise });
  const operation = h.button('Read identity').click(); await flush(); assert.equal(h.calls.length, 2);
  h.update(initial(lock, 8)); pending.resolve(initial()); await operation;
  assert.equal(h.status(), ''); assert.equal(h.button('Read identity').disabled, false);
});

test('an old read finishing cannot clear the busy state or message of a newer read', async () => {
  const oldRead = deferred(), newRead = deferred(); let reads = 0;
  const h = harness({ action: () => ++reads === 1 ? oldRead.promise : newRead.promise });
  const oldOperation = h.button('Read identity').click(); await flush();
  h.select(other); h.update(initial(other, 8));
  const newOperation = h.button('Read identity').click(); await flush();
  oldRead.reject(new Error('Old read failed.')); await oldOperation;
  assert.equal(h.status(), 'Reading identity…'); assert.equal(h.button('Read identity').disabled, true);
  newRead.resolve(initial(other, 8)); await newOperation;
  assert.equal(h.status(), 'Read 2 identity fields.'); assert.equal(h.button('Read identity').disabled, false);
  assert.equal(h.calls.length, 3);
});

test('transport handles and properties update when service UUIDs and identity stay unchanged', async () => {
  const h = harness(); assert.match(h.container.textContent, /handle 21 · indicate/);
  const next = initial(); next.services[1].characteristics[0] = characteristic(schlage.tx, 31, ['notify']); h.update(next);
  assert.match(h.container.textContent, /handle 31 · notify/); assert.doesNotMatch(h.container.textContent, /handle 21/);
  h.button('Save to inventory').click(); h.update({ ble: {}, services: [] });
  assert.match(h.container.textContent, /handle 31 · notify/);
  h.button('Export snapshot').click();
  assert.equal((await h.exported()).services[1].characteristics[0].handle, 31);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.connections, []);
});
