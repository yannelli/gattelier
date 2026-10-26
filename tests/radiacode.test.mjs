import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), p = require('../web/radiacode-protocol.js'), { createClient, mount } = require('../web/radiacode.js');
const address = '02:00:00:00:00:01', device = { address, addressType: 0 }, measurementHex = '0000000a000000000048410ad7233d0c001700050001010003140000007b000000000020409a102e220200';
const firmwareHex = '010004000142080004000154';
const u32 = number => { const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, number, true); return result; };
const concat = (...parts) => Uint8Array.from(parts.flatMap(part => Array.from(part)));
const virtual = data => concat(u32(1), u32(data.length), data);
const framed = (request, data) => concat(u32(data.length + 4), request.slice(4, 8), data);

function fixture(onRequest = () => false, timeoutMs = 100) {
  let state = { ble: { connected: true, address, mtu: 23 }, services: [{ uuid: 'private', characteristics: [{ uuid: p.WRITE, handle: 4, properties: ['write-no-response'] }, { uuid: p.NOTIFY, handle: 6, properties: ['notify'] }] }] };
  let seq = 0, requestBytes = new Uint8Array(); const eventListeners = new Set(), stateListeners = new Set(), actions = [], requests = [], connects = [];
  const emit = (events = [], meta = {}) => { const batch = events.map(event => ({ address, handle: 6, kind: 'notification', success: true, ...event, seq: ++seq })); for (const listener of eventListeners) listener(batch, { bootId: 'boot-1', cursor: seq, nextSeq: seq, gaps: 0, ...meta }); };
  const notify = (request, data, extra = {}) => { const response = framed(request, data); emit([{ hex: p.hex(response.slice(0, 2)), ...extra }, { hex: p.hex(response.slice(2)), ...extra }]); };
  const setState = next => { state = next; for (const listener of stateListeners) listener(state, true); };
  const lab = {
    getState: () => state, isActing: () => false,
    onEvents(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onState(listener) { stateListeners.add(listener); listener(state, true); return () => stateListeners.delete(listener); },
    setFastCapture(enabled) { if (enabled) queueMicrotask(() => emit()); },
    async action(action, body) {
      actions.push({ action, body });
      if (action === 'write') {
        requestBytes = concat(requestBytes, p.bytes(body.hex));
        if (requestBytes.length >= 4 && requestBytes.length === new DataView(requestBytes.buffer).getUint32(0, true) + 4) {
          const request = requestBytes; requestBytes = new Uint8Array(); requests.push(request);
          if (await onRequest(request, { emit, notify, setState, state })) return state;
          const code = new DataView(request.buffer).getUint16(4, true);
          const data = code === 7 ? new Uint8Array() : code === 10 ? p.bytes(firmwareHex) : code === 5 ? u32(5) : virtual(request[8] === 8 ? new TextEncoder().encode('RC123') : p.bytes(measurementHex));
          notify(request, data);
        }
      }
      return state;
    }
  };
  const connection = { async ensure(selected) { connects.push(selected); return state; }, snapshot: () => ({ state, online: true, pending: false }) };
  return { client: createClient(lab, { connection, timeoutMs }), lab, connection, actions, requests, connects, emit, setState, getState: () => state };
}

test('read-only RadiaCode requests match independent protocol vectors', () => {
  assert.equal(p.hex(p.request('exchange', 0)), '080000000700008001ff12ff');
  assert.equal(p.hex(p.request('version', 1)), '040000000a000081');
  assert.equal(p.hex(p.request('serial', 2)), '080000002608008208000000');
  assert.equal(p.hex(p.request('status', 31)), '040000000500009f');
  for (const kind of ['set-time', 'reset', 'constructor', 'write']) assert.throws(() => p.request(kind, 0), /Unsupported/);
  assert.throws(() => p.request('status', 32), /sequence/);
});

test('response assembly handles split length headers and enforces request echoes', () => {
  const request = p.request('status', 0), data = framed(request, u32(5)), assembler = new p.Assembler();
  assert.deepEqual(assembler.append(data.slice(0, 2)), []);
  assert.deepEqual(assembler.append(data.slice(2, 7)), []);
  const [frame] = assembler.append(data.slice(7)); assert.equal(p.status(p.response(frame, request)), 5);
  assert.throws(() => p.response(frame, p.request('status', 1)), /sequence/);
  assert.throws(() => new p.Assembler().append('ffffffff'), /length/);
  assert.throws(() => new p.Assembler().append('03000000'), /length/);
});

test('firmware and virtual strings reject truncation and malformed payloads', () => {
  assert.deepEqual(p.version(firmwareHex), { boot: { major: 4, minor: 1, date: 'B' }, firmware: { major: 4, minor: 8, date: 'T' } });
  assert.equal(p.ascii(p.virtualString('01000000050000005243313233')), 'RC123');
  assert.equal(p.ascii(p.virtualString('0100000005000000524331323300')), 'RC123');
  assert.throws(() => p.virtualString('0000000000000000'), /rejected/);
  assert.throws(() => p.virtualString('01000000050000005243'), /length/);
  assert.throws(() => p.version(firmwareHex.slice(0, -2)), /truncated/);
  assert.throws(() => p.version(`${firmwareHex}00`), /trailing/);
  assert.throws(() => p.ascii(Uint8Array.of(255)), /ASCII/);
});

test('buffered records decode counts, raw dose units, temperature and charge without clock changes', () => {
  const records = p.measurements(measurementHex);
  assert.equal(records.length, 2); assert.equal(records[0].type, 'live'); assert.equal(records[0].countRate, 12.5);
  assert.ok(Math.abs(records[0].doseRate - 0.04) < 1e-7); assert.equal(records[0].countErrorPercent, 1.2);
  assert.equal(records[0].timestampOffsetMs, 100); assert.equal(records[1].dose, 2.5); assert.equal(records[1].temperatureC, 22.5); assert.equal(records[1].batteryPercent, 87.5);
  assert.throws(() => p.measurements(measurementHex.slice(0, -2)), /truncated/);
  const gap = p.bytes(measurementHex); gap[22] = 4; assert.throws(() => p.measurements(gap), /sequence gap/);
  assert.throws(() => p.measurements('00000a00000000'), /Unsupported/);
});

test('client is idle until explicit reads and reuses one session for identity, status and measurements', async () => {
  const f = fixture(); assert.equal(f.actions.length, 0);
  const identity = await f.client.read('identity', device); assert.equal(identity.serial, 'RC123');
  const status = await f.client.read('status', device); assert.equal(status.flags, 5);
  const measurements = await f.client.read('measurements', device); assert.equal(measurements.records.length, 2);
  assert.deepEqual(f.requests.map(request => new DataView(request.buffer).getUint16(4, true)), [7, 10, 0x826, 5, 0x826]);
  assert.deepEqual(f.requests.map(request => request[7]), [128, 129, 130, 131, 132]);
  assert.ok(f.actions.filter(action => action.action === 'write').every(action => !action.body.response));
  assert.ok(f.connects.every(selected => selected === device)); f.client.destroy();
});

test('foreign-device traffic is ignored and wrong sequence responses stop the transfer', async () => {
  const f = fixture((request, context) => { context.notify(request, new Uint8Array(), { address: '11:22:33:44:55:66' }); return false; });
  assert.equal((await f.client.read('status', device)).flags, 5); f.client.destroy();
  const wrong = fixture((request, context) => { const other = request.slice(); other[7]++; context.notify(other, new Uint8Array()); return true; });
  await assert.rejects(wrong.client.read('status', device), /sequence/); wrong.client.destroy();
});

test('capture gaps, truncated packets and disconnects abort the read', async () => {
  for (const disrupt of [
    context => context.emit([], { gaps: 1 }),
    context => context.emit([{ hex: '0000', truncated: true }]),
    context => context.setState({ ...context.state, ble: { connected: false } })
  ]) {
    const f = fixture((request, context) => { disrupt(context); return true; });
    await assert.rejects(f.client.read('status', device), /gap|incomplete|changed/); f.client.destroy();
  }
});

test('timeouts require reconnecting and do not replay stale commands', async () => {
  const f = fixture(() => true, 15);
  await assert.rejects(f.client.read('status', device), /timed out/); const count = f.actions.length;
  await assert.rejects(f.client.read('status', device), /Reconnect/); assert.equal(f.actions.length, count); f.client.destroy();
});

test('reader renders readable measurements, retains identity and clears results on selection changes', async t => {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.text = ''; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
  }
  const events = {}, previous = global.document;
  global.document = { createElement: tag => new Element(tag), addEventListener: (name, listener) => { events[name] = listener; }, removeEventListener: name => { delete events[name]; } };
  const find = (root, className) => root.className?.split(' ').includes(className) ? root : root.children.map(child => find(child, className)).find(Boolean);
  const f = fixture(), root = new Element('div'); let selected = { ...device, name: 'RadiaCode 103' };
  const reader = mount(root, f.lab, { connection: f.connection, getDevice: () => selected });
  t.after(() => { reader.destroy(); f.client.destroy(); if (previous === undefined) delete global.document; else global.document = previous; });
  assert.equal(f.actions.length, 0);
  assert.match(find(root, 'radiacode-device').textContent, /RadiaCode 103.*Connected/);
  await reader.read('identity');
  await reader.read('measurements');
  assert.match(find(root, 'radiacode-result-identity').textContent, /RC123/);
  const measurements = find(root, 'radiacode-result-measurements');
  assert.match(measurements.textContent, /Count rate 12.5 cps/);
  assert.match(measurements.textContent, /Dose rate 0.04/);
  assert.match(measurements.textContent, /Device temperature 22.5 °C/);
  assert.match(measurements.textContent, /Battery level 87.5 %/);
  assert.match(measurements.textContent, /Dose values use device units/);
  assert.equal(find(root, 'radiacode-empty').hidden, true);
  assert.equal(find(root, 'radiacode-status').attributes.role, 'status');
  selected = { address: '11:22:33:44:55:66' }; events['nanoscope:selection']();
  assert.equal(find(root, 'radiacode-results').children.length, 0);
  assert.equal(find(root, 'radiacode-empty').hidden, false);
});
