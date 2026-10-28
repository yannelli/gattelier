import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import p from '../web/pocket-protocol.js';

const source = readFileSync(new URL('../web/pocket.js', import.meta.url), 'utf8');
const device = { address: 'aa:bb:cc:dd:ee:01', addressType: 0, name: 'PKT01_fixture' };
const other = { ...device, address: 'aa:bb:cc:dd:ee:02' }, secret = 'abcdefghijklmnop';
const ready = (ble = {}) => ({ ble: { ...device, connected: true, busy: false, connectionAttempt: 7, ...ble }, services: [
  { uuid: p.uuid('a0'), characteristics: ['a2', 'a3', 'a1'].map((part, index) => ({ uuid: p.uuid(part), handle: index + 11 })) }
] });
const flush = () => new Promise(setImmediate);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const replies = text => text.startsWith('APP&SK&') ? ['MCU&SK&OK'] : ({
  'APP&LIST_DIRS': ['MCU&DIRS&2026-10-25', 'MCU&DIRS_SUM&1'],
  'APP&LIST&2026-10-25': ['MCU&F&2026-10-25&recording&45', 'MCU&LIST&1'],
  'APP&FW': ['MCU&FW&1.0'], 'APP&SPACE': ['MCU&SPA&1024'],
  'APP&U&2026-10-25&recording': ['MCU&U&3']
}[text] || []);

function fixture(initial = ready()) {
  let state = initial, selected = device, onState, onEvents, timerId = 0, origin = 'board-a', transport = 'serial';
  let ensure = async () => state, action = async () => state, respond = replies;
  const elements = [], events = new Map(), globals = new Map(), calls = [], connections = [], fast = [], timers = new Map(), saved = [], exports = [], downloads = [];
  const credentials = new Map([[device.address, secret], [other.address, secret]]);
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.text = ''; this.value = ''; this.disabled = false; }
    set disabled(value) { this.isDisabled = Boolean(value); }
    get disabled() { return this.isDisabled; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.text = ''; if (this.tag === 'select') this.value = children[0]?.value || ''; }
    setAttribute() {}
    insertAdjacentHTML() {}
    addEventListener(type, callback) { this.listeners[type] = callback; }
    click() { if (this.tag === 'a') downloads.push(this.download); if (!this.disabled) return this.listeners.click?.(); }
  }
  const createElement = tag => { const node = new Element(tag); elements.push(node); return node; };
  const reply = (messages, call = calls.findLast(item => item.path === 'write'), overrides = {}, audio = '') => {
    const base = { ...call.ble, ...overrides };
    const batch = [{ ...base, kind: 'write', handle: call.handle, hex: call.hex, message: '' },
      { ...base, kind: 'notification', handle: 12, hex: p.encode(messages.join('')) }];
    if (audio) batch.push({ ...base, kind: 'notification', handle: 13, hex: audio });
    onEvents(batch, { bootId: 1, dropped: 0 });
  };
  const lab = {
    getState: () => state,
    onState(callback) { onState = callback; callback(state, true); },
    onEvents(callback) { onEvents = callback; },
    setFastCapture(value) { fast.push(value); },
    async action(path, body) {
      const call = { path, ...body, ble: { ...state.ble } }; calls.push(call);
      const result = action(path, body);
      if (path === 'write') { const messages = respond(Buffer.from(body.hex, 'hex').toString()); if (messages) queueMicrotask(() => reply(messages, call)); }
      return result;
    }
  };
  const context = {
    PocketProtocol: p, NanoConnection: { snapshot: () => ({ state, selected }), ensure(target) { connections.push(target); return ensure(target); } },
    NanoAPI: { scope: () => transport === 'serial' ? 'usb' : origin, origin: () => origin, transport: () => transport },
    NanoRecorders: { identify: target => target ? { product: 'Pocket Recorder' } : null },
    NanoCredentials: { getPocket: address => credentials.get(address.toLowerCase()), savePocket(address, value) { saved.push({ address, value }); credentials.set(address.toLowerCase(), value); return {}; } },
    document: { createElement, addEventListener: (type, callback) => events.set(type, callback) },
    addEventListener: (type, callback) => globals.set(type, callback),
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id),
    Blob, URL: { createObjectURL(blob) { exports.push(blob); return 'blob:fixture'; }, revokeObjectURL() {} },
    fetch() { throw new Error('Hardware and network access are forbidden.'); }
  };
  vm.runInNewContext(source + '\nthis.app = NanoPocket;', context);
  const root = createElement('section'); context.app.mount(root, lab);
  const all = (node = root) => [node, ...node.children.flatMap(child => all(child))];
  const button = label => all().find(node => node.tag === 'button' && node.textContent === label);
  return {
    calls, connections, fast, timers, saved, exports, downloads, reply, root, button,
    unlock: elements.find(node => node.tag === 'button'),
    status: elements.find(node => node.className === 'hint'), progress: elements.find(node => node.className === 'pocket-progress'),
    files: elements.find(node => node.className === 'pocket-files'), dates: elements.find(node => node.tag === 'select'),
    ensureWith(callback) { ensure = callback; }, actionWith(callback) { action = callback; }, respondWith(callback) { respond = callback; },
    update(next, online = true) { state = next; onState(next, online); },
    select(next, notify = true) { selected = next; if (notify) events.get('nanoscope:selection')(); },
    apiChange(next = origin, mode = transport) { origin = next; transport = mode; globals.get('nanoscope:api-change')(); },
    async click(label) { const node = label === 'unlock' ? this.unlock : button(label); assert.ok(node && !node.disabled, label); node.click(); await flush(); },
    async tick(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); } await flush(); }
  };
}
async function recordings(h) { await h.click('unlock'); await h.click('List recording dates'); await h.click('List recordings'); }
const changes = [
  ['address type', h => h.update(ready({ addressType: 1 }))],
  ['connection attempt', h => h.update(ready({ connectionAttempt: 8 }))],
  ['selection type', h => h.select({ ...device, addressType: 1 })],
  ['selection away/back', h => { h.select(other); h.select(device); }],
  ['same USB scope', h => h.apiChange()],
  ['API away/back', h => { h.apiChange('board-b', 'http'); h.apiChange('board-a', 'serial'); }],
  ['disconnect', h => h.update(ready({ connected: false }))],
  ['offline', h => h.update(ready(), false)]
];

test('mount stays idle; explicit authentication, listing and device reads use PocketProtocol', async () => {
  const h = fixture(); assert.deepEqual([h.calls, h.connections, h.fast], [[], [], []]);
  await recordings(h); await h.click('Read device info');
  assert.equal(h.files.children.length, 1); assert.equal(h.dates.value, '2026-10-25');
  assert.equal(h.status.textContent, 'MCU&FW&1.0 · MCU&SPA&1024');
  assert.deepEqual(h.calls.filter(call => call.path === 'write').map(call => Buffer.from(call.hex, 'hex').toString()),
    [`APP&SK&${secret}`, 'APP&LIST_DIRS', 'APP&LIST&2026-10-25', 'APP&FW', 'APP&SPACE']);
  assert.deepEqual(h.saved, [{ address: device.address, value: secret }]); assert.equal(h.timers.size, 0);
});

test('session replacements clear authentication, waiters, dates and files before late responses', async () => {
  for (const [, change] of changes) {
    const h = fixture(); await recordings(h); h.respondWith(() => null); await h.click('Read device info');
    const old = h.calls.at(-1); change(h); const status = h.status.textContent;
    h.reply(['MCU&FW&old'], old); await flush();
    assert.equal(h.files.children.length, 0); assert.equal(h.dates.value, '');
    assert.equal(h.button('Read device info').disabled, true); assert.equal(h.timers.size, 0);
    assert.equal(h.status.textContent, status); assert.equal(h.calls.at(-1), old);
  }
});

test('selection and API changes discard pending ensure results and errors', async () => {
  for (const failed of [false, true]) for (const [, change] of changes) {
    const h = fixture(), pending = deferred(); h.ensureWith(() => pending.promise);
    await h.click('unlock'); change(h); const status = h.status.textContent;
    if (failed) pending.reject(new Error('Old ensure failed.')); else pending.resolve(ready());
    await flush(); assert.deepEqual(h.calls, []); assert.deepEqual(h.saved, []); assert.equal(h.status.textContent, status);
  }
});

test('old ensure, subscribe and write completions cannot affect a new authentication', async () => {
  for (const stage of ['ensure', 'subscribe', 'write']) for (const failed of [false, true]) {
    const h = fixture(), old = deferred(); h.respondWith(() => null);
    if (stage === 'ensure') h.ensureWith(() => old.promise);
    else h.actionWith(path => path === stage ? old.promise : Promise.resolve(ready()));
    await h.click('unlock'); h.apiChange(); h.update(ready({ connectionAttempt: 8 }));
    h.ensureWith(async () => ready({ connectionAttempt: 8 })); h.actionWith(async () => ready({ connectionAttempt: 8 }));
    await h.click('unlock'); const count = h.calls.length, fastCount = h.fast.length;
    if (failed) old.reject(new Error('Old operation failed.')); else old.resolve(ready());
    await flush(); assert.equal(h.calls.length, count); assert.equal(h.status.textContent, 'Working…');
    assert.equal(h.unlock.disabled, true); assert.equal(h.fast.length, fastCount);
    h.reply(['MCU&SK&OK']); await flush();
    assert.equal(h.unlock.textContent, 'Authenticated'); assert.equal(h.saved.length, 1); assert.equal(h.timers.size, 0);
  }
});

test('a response resolved just before selection changes cannot start a follow-up or publish success', async () => {
  for (const notify of [false, true]) {
    const h = fixture(); await h.click('unlock'); h.respondWith(() => null); await h.click('Read device info');
    h.reply(['MCU&FW&old']); h.select({ ...device, addressType: 1 }, notify); await flush();
    assert.equal(h.calls.filter(call => call.path === 'write').length, 2);
    assert.doesNotMatch(h.status.textContent, /old|Working/); assert.equal(h.button('Read device info').disabled, true);
  }
});

test('silent selection changes stop pending ensure and authentication responses before saving a key', async () => {
  for (const stage of ['ensure', 'response']) {
    const h = fixture(), pending = deferred();
    if (stage === 'ensure') h.ensureWith(() => pending.promise); else h.respondWith(() => null);
    await h.click('unlock'); h.select({ ...device, addressType: 1 }, false);
    if (stage === 'ensure') pending.resolve(ready()); else h.reply(['MCU&SK&OK']);
    await flush(); assert.deepEqual(h.saved, []); assert.equal(h.timers.size, 0);
    assert.equal(h.calls.length, stage === 'ensure' ? 0 : 2); assert.doesNotMatch(h.status.textContent, /Authenticated|Working/);
  }
});

test('event address types and attempts must match the active authentication', async () => {
  const h = fixture(); h.respondWith(() => null); await h.click('unlock');
  for (const overrides of [{ addressType: 1 }, { connectionAttempt: 6 }, { address: other.address }]) {
    h.reply(['MCU&SK&OK'], undefined, overrides); await flush();
    assert.equal(h.status.textContent, 'Working…'); assert.deepEqual(h.saved, []);
  }
  h.reply(['MCU&SK&OK']); await flush(); assert.equal(h.unlock.textContent, 'Authenticated');
});

test('ordinary updates and equivalent selections preserve authentication and pending responses', async () => {
  const h = fixture(); await h.click('unlock'); h.respondWith(() => null); await h.click('Read device info');
  h.select({ ...device, address: device.address.toUpperCase() }); h.update(ready({ busy: true }));
  h.reply(['MCU&FW&1.0']); await flush(); h.update(ready()); h.reply(['MCU&SPA&1024']); await flush();
  assert.equal(h.status.textContent, 'MCU&FW&1.0 · MCU&SPA&1024'); assert.equal(h.unlock.textContent, 'Authenticated');
});

test('ensure establishes the selected Pocket from a disconnected or different connected device', async () => {
  for (const initial of [ready({ connected: false }), ready(other), ready({ addressType: 1 })]) {
    const h = fixture(initial);
    h.ensureWith(async target => {
      h.select({ ...target }); h.update(ready({ ...initial.ble, connected: false }));
      h.update(ready({ connected: false, connectionAttempt: 8, busy: true }));
      h.update(ready({ connectionAttempt: 8, busy: true })); h.update(ready({ connectionAttempt: 8 }));
      return ready({ connectionAttempt: 8 });
    });
    await h.click('unlock'); await h.click('Read device info');
    assert.equal(h.unlock.textContent, 'Authenticated'); assert.equal(h.status.textContent, 'MCU&FW&1.0 · MCU&SPA&1024');
  }
});

test('incomplete transfers clear after replacement and late audio and polling stay stopped', async () => {
  for (const [, change] of changes) {
    const h = fixture(); await recordings(h); await h.click('Download');
    const old = h.calls.at(-1); assert.ok(h.timers.size); change(h); const status = h.status.textContent;
    h.reply(['MCU&U&3'], old, {}, '494433'); await h.tick(100);
    assert.equal(h.progress.textContent, ''); assert.equal(h.button('Save MP3').hidden, true);
    assert.equal(h.status.textContent, status); assert.equal(h.timers.size, 0); assert.equal(h.fast.at(-1), false);
  }
});

test('a stale audio subscription cannot start capture or send a download command', async () => {
  const h = fixture(), pending = deferred(); await recordings(h);
  h.actionWith(path => path === 'subscribe' ? pending.promise : Promise.resolve(ready()));
  await h.click('Download'); const count = h.calls.length; h.apiChange(); pending.resolve(ready()); await flush();
  assert.equal(h.calls.length, count); assert.equal(h.fast.includes(true), false); assert.equal(h.progress.textContent, '');
});

test('an old transfer poll cannot clear a new transfer or its busy state', async () => {
  const h = fixture(); await recordings(h); await h.click('Download');
  h.apiChange(); h.update(ready({ connectionAttempt: 8 })); await recordings(h); await h.click('Download');
  const fastCount = h.fast.length; await h.tick(100);
  assert.equal(h.status.textContent, 'Working…'); assert.equal(h.unlock.disabled, true);
  assert.equal(h.fast.length, fastCount); assert.equal(h.progress.textContent, '0 / 3 bytes');
  h.reply(['MCU&U&3'], undefined, {}, '494433'); await h.tick(100);
  assert.equal(h.button('Save MP3').hidden, false); assert.equal(h.fast.at(-1), false);
});

test('completed MP3 bytes and filename remain downloadable after session replacements', async () => {
  const h = fixture(); await recordings(h); await h.click('Download');
  h.reply(['MCU&U&3'], undefined, {}, '494433'); await h.tick(100);
  assert.equal(h.button('Save MP3').hidden, false);
  for (const [, change] of changes) change(h);
  await h.click('Save MP3'); assert.equal(await h.exports[0].text(), 'ID3');
  assert.equal(h.exports[0].type, 'audio/mpeg'); assert.deepEqual(h.downloads, ['2026-10-25_recording.mp3']);
});
