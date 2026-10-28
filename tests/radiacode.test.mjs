import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), p = require('../web/radiacode-protocol.js'), { createClient, createPoller, mount } = require('../web/radiacode.js');
const address = '02:00:00:00:00:01', device = { address, addressType: 0 }, measurementHex = '0000000a000000000048410ad7233d0c001700050001010003140000007b000000000020409a102e220200';
const firmwareHex = '010004000142080004000154';
const u32 = number => { const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, number, true); return result; };
const concat = (...parts) => Uint8Array.from(parts.flatMap(part => Array.from(part)));
const virtual = data => concat(u32(1), u32(data.length), data);
const framed = (request, data) => concat(u32(data.length + 4), request.slice(4, 8), data);
const f32 = number => { const result = new Uint8Array(4); new DataView(result.buffer).setFloat32(0, number, true); return result; };
const spectrumHeader = concat(u32(60), f32(0.5), f32(3), f32(0.25));
const spectrumData = concat(spectrumHeader, u32(10), u32(30), u32(0));

function fixture(onRequest = () => false, timeoutMs = 100) {
  let state = { ble: { connected: true, address, addressType: 0, connectionAttempt: 1, mtu: 23 }, services: [{ uuid: 'private', characteristics: [{ uuid: p.WRITE, handle: 4, properties: ['write-no-response'] }, { uuid: p.NOTIFY, handle: 6, properties: ['notify'] }] }] };
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
          const data = code === 7 ? new Uint8Array() : code === 10 ? p.bytes(firmwareHex) : code === 5 ? u32(5) : code === 0x825 ? u32(1) : virtual(request[8] === 8 ? new TextEncoder().encode('RC123') : request[8] === 2 ? new TextEncoder().encode('SpecFormatVersion=0\r\n') : request[9] === 2 ? spectrumData : p.bytes(measurementHex));
          notify(request, data);
        }
      }
      return state;
    }
  };
  const connection = { async ensure(selected) { connects.push(selected); return state; }, snapshot: () => ({ state, online: true, pending: false }) };
  return { client: createClient(lab, { connection, timeoutMs }), lab, connection, actions, requests, connects, emit, setState, getState: () => state };
}

test('RadiaCode requests match independent protocol vectors and keep dose reset explicit', () => {
  assert.equal(p.hex(p.request('exchange', 0)), '080000000700008001ff12ff');
  assert.equal(p.hex(p.request('version', 1)), '040000000a000081');
  assert.equal(p.hex(p.request('serial', 2)), '080000002608008208000000');
  assert.equal(p.hex(p.request('status', 31)), '040000000500009f');
  assert.equal(p.hex(p.request('configuration', 0)), '080000002608008002000000');
  assert.equal(p.hex(p.request('spectrum', 0)), '080000002608008000020000');
  assert.equal(p.hex(p.request('resetDose', 0)), '080000002508008007800000');
  for (const kind of ['set-time', 'reset', 'constructor', 'write']) assert.throws(() => p.request(kind, 0), /Unsupported/);
  assert.throws(() => p.request('status', 32), /sequence/);
});

test('spectrum format follows device configuration and decodes uint32 counts with quadratic keV calibration', () => {
  assert.equal(p.spectrumFormat(new TextEncoder().encode('Other=2\r\nSpecFormatVersion=1\r\n')), 1);
  assert.equal(p.spectrumFormat(new TextEncoder().encode('Other=2')), 0);
  assert.throws(() => p.spectrumFormat(new TextEncoder().encode('SpecFormatVersion=2')), /Unsupported/);
  const spectrum = p.spectrum(spectrumData, 0);
  assert.deepEqual(spectrum.counts, [10, 30, 0]); assert.deepEqual(spectrum.energiesKeV, [0.5, 3.75, 7.5]);
  assert.equal(spectrum.durationSeconds, 60); assert.equal(spectrum.totalCounts, 40);
  assert.throws(() => p.spectrum(spectrumData.slice(0, -1), 0), /truncated/);
  assert.throws(() => p.spectrum(spectrumData.slice(0, 15), 0), /header/);
  assert.throws(() => p.spectrum(spectrumData, 2), /Unsupported/);
  const invalid = spectrumData.slice(); new DataView(invalid.buffer).setFloat32(4, NaN, true); assert.throws(() => p.spectrum(invalid, 0), /calibration/);
});

test('compressed spectrum supports absolute, signed delta and zero blocks and rejects malformed counts', () => {
  const encoded = p.bytes('21000a14220005ff13002c011400ffffff1500000001002000');
  assert.deepEqual(p.spectrum(concat(spectrumHeader, encoded), 1).counts, [10, 20, 25, 24, 324, 323, 65859, 0, 0]);
  assert.throws(() => p.spectrum(concat(spectrumHeader, p.bytes('1100011200fe')), 1), /count/);
  assert.throws(() => p.spectrum(concat(spectrumHeader, p.bytes('1600')), 1), /compression/);
  assert.deepEqual(p.spectrum(concat(spectrumHeader, p.bytes('00000000'), encoded), 1).counts, [10, 20, 25, 24, 324, 323, 65859, 0, 0]);
  assert.throws(() => p.spectrum(concat(spectrumHeader, p.bytes('150001')), 1), /truncated/);
});

test('spectrum reads configuration once per connection and reset requires confirmation and acknowledgement', async () => {
  const f = fixture(); await assert.rejects(f.client.resetDose(device), /Confirm/); assert.equal(f.actions.length, 0);
  assert.equal((await f.client.read('spectrum', device)).totalCounts, 40); await f.client.read('spectrum', device);
  assert.equal(f.requests.filter(request => request[8] === 2).length, 1);
  await assert.rejects(f.client.read('resetDose', device), /Unsupported/);
  assert.equal((await f.client.resetDose(device, true)).kind, 'resetDose');
  assert.equal(new DataView(f.requests.at(-1).buffer).getUint16(4, true), 0x825); f.client.destroy();
  assert.throws(() => p.acknowledge(u32(0)), /rejected/); assert.throws(() => p.acknowledge(new Uint8Array()), /four bytes/);
  const rejected = fixture((request, context) => { if (request[4] !== 0x25) return false; context.notify(request, u32(0)); return true; });
  await assert.rejects(rejected.client.resetDose(device, true), /rejected/); rejected.client.destroy();
});

test('unsupported firmware and spectrum format stop before spectrum reads or dose writes', async () => {
  const old = fixture((request, context) => { if (request[4] !== 10) return false; context.notify(request, p.bytes('010004000142070004000154')); return true; });
  await assert.rejects(old.client.read('spectrum', device), /4.8/); await assert.rejects(old.client.resetDose(device, true), /4.8/);
  assert.equal(old.requests.length, 2); old.client.destroy();
  const unknown = fixture((request, context) => { if (request[8] !== 2) return false; context.notify(request, virtual(new TextEncoder().encode('SpecFormatVersion=2'))); return true; });
  await assert.rejects(unknown.client.read('spectrum', device), /Unsupported/);
  assert.equal(unknown.requests.some(request => request[9] === 2), false); unknown.client.destroy();
});

test('stopping before connection setup finishes prevents initialization and writes', async () => {
  const f = fixture(), operation = f.client.read('spectrum', device); f.client.stop();
  await assert.rejects(operation, /stopped/); assert.equal(f.actions.length, 0); f.client.destroy();
});

test('live polling serializes reads and cancels timers and late results on stop', async () => {
  let scheduled, cancelled = false, finish; const calls = [], results = [];
  const poller = createPoller({ read: async kind => { calls.push(kind); return { kind }; }, onResult: result => results.push(result.kind), schedule: callback => { scheduled = callback; return 7; }, cancel: id => { assert.equal(id, 7); cancelled = true; } });
  await poller.start(); assert.deepEqual(calls, ['measurements', 'spectrum']); assert.deepEqual(results, calls); assert.equal(poller.active(), true);
  poller.start(); assert.equal(calls.length, 2); poller.stop(); await scheduled(); assert.equal(calls.length, 2); assert.equal(cancelled, true);
  const pending = createPoller({ read: kind => { calls.push(kind); return new Promise(resolve => { finish = resolve; }); }, onResult: () => assert.fail('Late result rendered'), schedule: () => assert.fail('Cancelled read rescheduled') });
  const operation = pending.start(); pending.stop(); finish({ kind: 'measurements' }); await operation; assert.equal(pending.active(), false);
  let error;
  const failed = createPoller({ read: async () => { throw new Error('Disconnected'); }, onError: value => { error = value; }, schedule: () => assert.fail('Failed read rescheduled') });
  await failed.start(); assert.match(error.message, /Disconnected/); assert.equal(failed.active(), false);
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
  const prefix = p.measurements(gap, { partial: true });
  assert.equal(prefix.length, 1); assert.match(prefix.warning, /sequence changed/);
  const unknown = p.bytes(measurementHex); unknown[2] = 4;
  const unsupported = p.measurements(unknown, { partial: true });
  assert.equal(unsupported.length, 0); assert.match(unsupported.warning, /record type 0\/4/);
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
  global.document = { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), addEventListener: (name, listener) => { events[name] = listener; }, removeEventListener: name => { delete events[name]; } };
  const find = (root, className) => root.className?.split(' ').includes(className) ? root : root.children.map(child => find(child, className)).find(Boolean);
  const f = fixture(), root = new Element('div'); let selected = { ...device, name: 'RadiaCode 103' }, confirmReset = false, isActive = true;
  const reader = mount(root, f.lab, { connection: f.connection, getDevice: () => selected, confirm: () => confirmReset, isActive: () => isActive });
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
  await reader.read('spectrum');
  assert.match(find(root, 'radiacode-result-spectrum').textContent, /Acquisition time 60 s.*Total counts 40.*Channels 3/);
  assert.match(find(root, 'radiacode-spectrum').textContent, /0.5 keV.*7.5 keV/);
  const reset = find(root, 'radiacode-reset'); await reset.listeners.click(); assert.equal(f.requests.some(request => request[4] === 0x25), false);
  confirmReset = true; await reset.listeners.click(); assert.equal(f.requests.at(-1)[4], 0x25); assert.equal(find(root, 'radiacode-result-measurements'), undefined);
  assert.match(find(root, 'radiacode-result-resetDose').textContent, /acknowledged/);
  const live = find(root, 'radiacode-actions').children.find(child => child.textContent === 'Start live');
  await live.listeners.click(); assert.equal(live.textContent, 'Stop live');
  global.document.hidden = true; events.visibilitychange(); assert.equal(live.textContent, 'Start live');
  global.document.hidden = false; await live.listeners.click(); isActive = false; events['nanoscope:workspace'](); assert.equal(live.textContent, 'Start live');
  selected = { address: '11:22:33:44:55:66' }; events['nanoscope:selection']();
  assert.equal(find(root, 'radiacode-results').children.length, 0);
  assert.equal(find(root, 'radiacode-empty').hidden, false);
});
