import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import protocol from '../web/plaud-protocol.js';
import recorders from '../web/recorders.js';
import packets from '../web/packets.js';

const source = readFileSync(new URL('../web/plaud.js', import.meta.url), 'utf8');
const advertisement = Buffer.alloc(22); advertisement.writeUInt16LE(881, 3); advertisement[2] = 2; advertisement[5] = 4; advertisement[10] = 8;
Buffer.from('01020304aabbccdd', 'hex').copy(advertisement, 11); advertisement.writeUInt16LE(20, 20);
const device = { address: 'aa:bb:cc:dd:ee:01', addressType: 0, manufacturer: advertisement.toString('hex') };
const saved = { serial: '01020304aabbccdd', userId: 'example', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----', signature: Buffer.alloc(256, 7).toString('base64') };
const initial = () => ({ ble: { ...device, connected: true, busy: false, connectionAttempt: 1 }, devices: [device], services: [{ uuid: '1910', characteristics: [{ uuid: '2bb1', handle: 4 }, { uuid: '2bb0', handle: 6 }] }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let state = initial(), selected = device, seq = 0;
  const nodes = new Map(), listeners = new Map(), states = new Set(), events = new Set(), actions = [], captures = [], downloads = [];
  const listen = (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); };
  const fire = name => { for (const callback of listeners.get(name) || []) callback(); };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.classList = { add() {}, remove() {} }; this.value = ''; this.text = ''; }
    set innerHTML(value) { for (const match of value.matchAll(/id="(plaud-[^"]+)"/g)) nodes.set(match[1], new Element('div')); }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(item => item.textContent).join(''); }
    set disabled(value) { this.disabledValue = Boolean(value); }
    get disabled() { return this.disabledValue || false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    setAttribute() {}
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelector(id) { return nodes.get(id.slice(1)); }
    querySelectorAll() { return this.children.flatMap(item => [...(item.tag === 'button' ? [item] : []), ...item.querySelectorAll()]); }
    click() { if (this.disabled) return; if (this.tag === 'a') downloads.push(this.download); return this.listeners.click?.(); }
  }
  const emit = (frames, extra = {}, meta = {}) => {
    const batch = frames.map(bytes => ({ ...state.ble, address: device.address, seq: ++seq, kind: 'notification', handle: 6, hex: packets.hex(bytes), ...extra }));
    for (const callback of events) callback(batch, { bootId: 'board-1', cursor: seq, ...meta });
  };
  const reply = bytes => {
    if (bytes[0] === 0x10 && bytes[1] === 0xfe && bytes[3] === bytes[2] - 1) emit(protocol.chunks(0xfe12, new Uint8Array(256)));
    if (bytes[0] === 1 && bytes[1] === 1) emit([Uint8Array.of(1, 1, 0, 0)]);
    if (bytes[0] === 1 && bytes[1] === 26) {
      const packet = new Uint8Array(21); packet.set([1, 26, 0]); const data = new DataView(packet.buffer);
      data.setUint32(3, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(3, true), true);
      data.setUint16(7, 1, true); data.setUint32(11, 17, true); data.setUint32(15, 3, true); emit([packet]);
    }
    if (bytes[0] === 1 && bytes[1] === 28) {
      const header = Uint8Array.of(1, 28, 0, 17, 0, 0, 0, 0), data = Uint8Array.of(2, 17, 0, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3), end = Uint8Array.of(2, 17, 0, 0, 0, 255, 255, 255, 255, 1); emit([header, data, end]);
    }
  };
  const lab = {
    onState(callback) { states.add(callback); callback(state, true); }, onEvents(callback) { events.add(callback); },
    setFastCapture: value => captures.push(value),
    async action(kind, body) {
      actions.push({ kind, ...body }); if (await options.action?.(kind, body, api) === false) return state;
      if (kind === 'write') reply(packets.bytes(body.hex)); return state;
    }
  };
  const context = { Uint8Array, DataView, TextEncoder, atob, setTimeout, clearTimeout, Blob,
    NanoPackets: packets, NanoRecorders: recorders, NanoCredentials: { getPlaud: () => saved, status: () => ({ persistent: true }) },
    NanoPlaudProtocol: { ...protocol, Session: class { seal(value) { return value; } open(value) { return value; } }, decryptRecording: () => Uint8Array.of(79, 103, 103) },
    NanoConnection: { snapshot: () => ({ selected, state, pending: false }), ensure: () => options.ensure?.(api) || Promise.resolve(state) },
    addEventListener: listen, document: { createElement: tag => new Element(tag), addEventListener: listen },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} }
  };
  vm.runInNewContext(source + '\nthis.plaud = NanoPlaud;', context);
  const api = { actions, captures, downloads, emit, fire, get: name => nodes.get(`plaud-${name}`), state: () => state,
    update(next, online = true) { state = next; for (const callback of states) callback(state, online); },
    select(next) { selected = next; fire('nanoscope:selection'); },
    auth: () => nodes.get('plaud-authenticate').click(), list: () => nodes.get('plaud-list').click(),
    download: () => nodes.get('plaud-files').querySelectorAll()[0].click()
  };
  context.plaud.mount(new Element('section'), lab); return api;
}

test('PLAUD UI authenticates and downloads through mocked transport replies', async () => {
  const f = fixture(); assert.deepEqual(f.actions, []);
  await f.auth(); assert.equal(f.get('authenticate').textContent, 'Authenticated'); assert.equal(f.get('list').disabled, false);
  await f.list(); assert.match(f.get('files').textContent, /Recording 17/);
  await f.download(); assert.equal(f.get('save').hidden, false); assert.match(f.get('status').textContent, /Recording verified/);
  f.update({ ...f.state(), ble: { ...f.state().ble, connectionAttempt: 2 } });
  assert.equal(f.get('authenticate').textContent, 'Authenticate'); assert.equal(f.get('list').disabled, true);
  assert.equal(f.get('save').hidden, false);
});

test('an idle PLAUD panel leaves another app capture setting alone', () => {
  const f = fixture();
  f.select({ ...device, address: 'aa:bb:cc:dd:ee:02' }); f.fire('nanoscope:api-change'); f.update(initial());
  assert.deepEqual(f.captures, []); assert.deepEqual(f.actions, []);
});

test('PLAUD selection and connection address casing preserve the session', async () => {
  const f = fixture(); await f.auth();
  f.select({ ...device, address: device.address.toUpperCase() });
  f.update({ ...f.state(), ble: { ...f.state().ble, address: device.address.toUpperCase() } });
  assert.equal(f.get('authenticate').textContent, 'Authenticated');
  await f.list(); assert.match(f.get('files').textContent, /Recording 17/);
});

for (const prior of [{ ...device, connected: false }, { ...device, address: 'aa:bb:cc:dd:ee:02', connected: true }]) {
  test(`PLAUD accepts ensure from ${JSON.stringify(prior)}`, async () => {
    const pending = deferred(), f = fixture({ ensure: () => pending.promise });
    f.update({ ...initial(), ble: { ...prior, busy: false, connectionAttempt: 1 } });
    const operation = f.auth();
    f.update({ ...initial(), ble: { ...device, connected: false, busy: true, operation: 'connecting', connectionAttempt: 2 } });
    const ready = initial(); ready.ble.connectionAttempt = 2;
    f.update({ ...ready, ble: { ...ready.ble, busy: true, operation: 'discovering' } });
    f.update(ready); pending.resolve(ready); await operation;
    assert.equal(f.get('authenticate').textContent, 'Authenticated'); assert.equal(f.get('list').disabled, false);
  });
}

const changes = [
  ['API', f => { const value = f.state(); f.fire('nanoscope:api-change'); f.update(value); }],
  ['attempt', f => f.update({ ...f.state(), ble: { ...f.state().ble, connectionAttempt: 2 } })],
  ['address type', f => { f.select({ ...device, addressType: 1 }); f.update({ ...f.state(), ble: { ...f.state().ble, addressType: 1 } }); }],
  ['selection away and back', f => { f.select({ ...device, address: 'aa:bb:cc:dd:ee:02' }); f.select(device); }]
];
for (const stage of ['ensure', 'subscribe', 'signature', 'list', 'download']) for (const [label, change] of changes) {
  test(`PLAUD cancels stale ${stage} after ${label} and preserves a newer operation`, async () => {
    for (const reject of [false, true]) {
      const pending = deferred(), entered = deferred(), next = deferred(), newEntered = deferred(); let paused = false, pauseNew = false;
      const f = fixture({ ensure: api => {
        if (paused && stage === 'ensure') { entered.resolve(); return pending.promise; }
        return Promise.resolve(api.state());
      }, action: (kind, body) => {
        if (pauseNew && kind === 'subscribe') { newEntered.resolve(); return next.promise.then(() => false); }
        const bytes = kind === 'write' ? packets.bytes(body.hex) : [];
        const matches = stage === 'subscribe' ? kind === 'subscribe' : kind === 'write' && (stage === 'signature' ? bytes[0] === 0x10 && bytes[1] === 0xfe : bytes[0] === 1 && bytes[1] === (stage === 'list' ? 26 : 28));
        if (paused && matches) { entered.resolve(); return pending.promise.then(() => false); }
      } });
      if (stage === 'list' || stage === 'download') await f.auth();
      if (stage === 'download') await f.list();
      paused = true;
      const previous = stage === 'list' ? f.list() : stage === 'download' ? f.download() : f.auth();
      await entered.promise; change(f); paused = false; pauseNew = true;
      assert.equal(f.get('authenticate').disabled, false);
      const latest = f.auth(); await newEntered.promise;
      const count = f.actions.length;
      if (reject) pending.reject(new Error('Old recorder failure.')); else pending.resolve(initial());
      await previous; await settle();
      assert.equal(f.actions.length, count);
      assert.equal(f.get('authenticate').disabled, true);
      assert.equal(f.get('status').textContent, 'Subscribing and authenticating the device signature…');
      assert.equal(f.captures.at(-1), true);
      pauseNew = false; next.resolve(); await latest;
      assert.equal(f.get('authenticate').textContent, 'Authenticated');
      assert.equal(f.get('list').disabled, false);
      assert.equal(f.actions.some(item => item.kind === 'write' && packets.bytes(item.hex)[0] === 1 && packets.bytes(item.hex)[1] === 29), false);
    }
  });
}

test('PLAUD ignores replies carrying a different address type or connection attempt', async () => {
  let blocked = true;
  const entered = deferred(), pending = deferred(), f = fixture({ action: (kind, body) => {
    if (blocked && kind === 'write' && packets.bytes(body.hex)[0] === 0x10) { entered.resolve(); return pending.promise; }
  } });
  const operation = f.auth(); await entered.promise;
  const wrapped = protocol.chunks(0xfe12, new Uint8Array(256));
  f.emit(wrapped, { addressType: 1 }); f.emit(wrapped, { connectionAttempt: 0 }); await settle();
  assert.equal(f.get('status').textContent, 'Subscribing and authenticating the device signature…');
  blocked = false; pending.resolve(); await operation;
  assert.equal(f.get('authenticate').textContent, 'Authenticated');
});
