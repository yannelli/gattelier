import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), p = require('../web/sleep-mcr-protocol.js'), { createClient } = require('../web/sleep-mcr.js');
const address = '02:00:00:00:00:02', device = { address, addressType: 0 }, identifier = '0102030405060708';
const bindReply = '16160212340000020000800a010203040506070845670d63', statusReply = '16160212344567021234921300323c0f0b';
const concat = (...parts) => Uint8Array.from(parts.flatMap(part => Array.from(part)));
function storage() { const values = new Map([[`nanoscope.mcr.clientId.${address}`, identifier]]); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }

function fixture(onRequest = () => false, timeoutMs = 100) {
  let state = { ble: { connected: true, address, addressType: 0, connectionAttempt: 1, mtu: 23 }, services: [{ uuid: p.SERVICE, characteristics: [{ uuid: p.WRITE, handle: 4, properties: ['write', 'write-no-response'] }, { uuid: p.NOTIFY, handle: 6, properties: ['notify'] }] }] };
  let seq = 0, requestBytes = new Uint8Array(); const eventListeners = new Set(), stateListeners = new Set(), actions = [], requests = [], connects = [], saved = storage();
  const emit = (events = [], meta = {}) => { const batch = events.map(event => ({ address, handle: 6, kind: 'notification', success: true, ...event, seq: ++seq })); for (const listener of eventListeners) listener(batch, { bootId: 'boot-1', cursor: seq, nextSeq: seq, gaps: 0, ...meta }); };
  const notify = (hex, extra = {}) => { const data = p.bytes(hex); emit([{ hex: p.hex(data.slice(0, 1)), ...extra }, { hex: p.hex(data.slice(1, 9)), ...extra }, { hex: p.hex(data.slice(9)), ...extra }]); };
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
        if (requestBytes.length >= 12 && requestBytes.length === 14 + (requestBytes[11] & 15)) {
          const request = requestBytes; requestBytes = new Uint8Array(); requests.push(request);
          if (await onRequest(request, { emit, notify, setState, state })) return state;
          notify(request[10] === 0 ? bindReply : statusReply);
        }
      }
      return state;
    }
  };
  const connection = { async ensure(selected) { connects.push(selected); return state; } };
  return { client: createClient(lab, { connection, timeoutMs, storage: saved }), actions, requests, connects, emit, setState, getState: () => state, storage: saved };
}

test('MCR binding and firmness requests match independent checksum vectors', () => {
  assert.equal(p.hex(p.request('bind', {}, identifier)), '161602000000000200000008010203040506070800fe');
  assert.equal(p.hex(p.request('firmness', { client: 0x4567, bed: 0x1234 })), '16160245671234024567120009e6');
  for (const kind of ['move', 'stop', 'set-firmness', 'constructor']) assert.throws(() => p.request(kind), /Unsupported/);
  assert.throws(() => p.request('bind', {}, '0000000000000000'), /nonzero/);
  assert.throws(() => p.request('firmness'), /addresses/);
});

test('MCR identity persists per device and reports unavailable storage', () => {
  const saved = storage(); assert.equal(p.identity(saved, address), identifier);
  const random = { getRandomValues: data => data.set([8, 7, 6, 5, 4, 3, 2, 1]) };
  assert.equal(p.identity(saved, '11:22:33:44:55:66', random), '0807060504030201');
  assert.equal(p.identity(saved, '11:22:33:44:55:66', { getRandomValues() { throw new Error(); } }), '0807060504030201');
  assert.throws(() => p.identity({ getItem() { throw new Error(); } }, address), /storage/);
  assert.throws(() => p.identity(saved, 'bad'), /address/);
});

test('MCR fragments preserve negotiated addresses and reject checksums or lengths', () => {
  const assembler = new p.Assembler(), data = p.bytes(bindReply);
  assert.deepEqual(assembler.append(data.slice(0, 1)), []); assert.deepEqual(assembler.append(data.slice(1, 8)), []);
  const [frame] = assembler.append(data.slice(8)); assert.deepEqual(p.bind(frame), { client: 0x4567, bed: 0x1234 });
  const result = p.decode(statusReply); assert.equal(p.matches(result, 'firmness', { client: 0x4567, bed: 0x1234 }), true);
  assert.equal(p.matches(result, 'firmness', { client: 9, bed: 0x1234 }), false);
  assert.equal(p.matches({ ...result, echo: 2 }, 'firmness', { client: 0x4567, bed: 0x1234 }), false);
  assert.equal(p.matches({ ...result, response: false }, 'firmness', { client: 0x4567, bed: 0x1234 }), false);
  assert.deepEqual(p.firmness(result), { adjusting: false, dualChamber: true, left: 50, right: 60 });
  assert.throws(() => p.decode(`${statusReply.slice(0, -2)}ff`), /checksum/);
  assert.throws(() => p.decode(statusReply.slice(0, -2)), /length/);
  assert.throws(() => p.firmness({ ...result, side: 4 }), /chamber/);
  assert.throws(() => p.bind({ ...frame, payload: new Uint8Array() }), /addresses/);
});

test('MCR service discovery prevents borrowing characteristics from another transport', () => {
  const characteristics = [{ uuid: p.WRITE, handle: 1 }, { uuid: p.NOTIFY, handle: 2 }];
  assert.equal(p.handles({ services: [{ uuid: '180a', characteristics }] }), null);
  assert.equal(p.handles({ services: [{ uuid: p.SERVICE.toUpperCase(), characteristics }] }).notify.handle, 2);
});

test('explicit reads bind once and send firmness queries without actuator commands', async () => {
  const f = fixture(); assert.equal(f.actions.length, 0);
  const first = await f.client.read('firmness', device), second = await f.client.read('firmness', device);
  assert.equal(first.left, 50); assert.equal(first.right, 60); assert.equal(second.dualChamber, true);
  assert.deepEqual(f.requests.map(request => request[10]), [0, 18, 18]);
  assert.deepEqual(f.actions.filter(action => action.action === 'write').map(action => action.body.hex.length / 2), [20, 2, 14, 14]);
  assert.ok(f.actions.filter(action => action.action === 'write').every(action => action.body.response));
  assert.ok(f.connects.every(selected => selected === device));
  assert.equal(p.identity(f.storage, address), identifier); f.client.destroy();
});

test('foreign device and unrelated frames do not satisfy a response wait', async () => {
  const f = fixture((request, context) => {
    context.notify(bindReply, { address: '11:22:33:44:55:66' });
    if (request[10] === 18) context.notify(bindReply);
    return false;
  });
  assert.equal((await f.client.read('firmness', device)).right, 60); f.client.destroy();
});

test('retained packets from another address type or attempt cannot interrupt MCR binding', async () => {
  for (const scope of [{ addressType: 1 }, { connectionAttempt: 0 }]) {
    const f = fixture((request, context) => {
      context.emit([{ kind: 'disconnect', ...scope }]);
      context.notify(`${bindReply.slice(0, -2)}ff`, scope);
      return false;
    });
    assert.equal((await f.client.read('firmness', device)).right, 60); f.client.destroy();
  }
});

test('gaps, corrupt frames, interrupted links and timeouts abort MCR reads', async () => {
  for (const [disrupt, pattern] of [
    [context => context.emit([], { dropped: 1 }), /gap/],
    [context => context.notify(`${bindReply.slice(0, -2)}ff`), /checksum/],
    [context => context.setState({ ...context.state, ble: { connected: false } }), /changed/]
  ]) {
    const f = fixture((request, context) => { disrupt(context); return true; });
    await assert.rejects(f.client.read('firmness', device), pattern); f.client.destroy();
  }
  const timeout = fixture(() => true, 15);
  await assert.rejects(timeout.client.read('firmness', device), /timed out/); const count = timeout.actions.length;
  await assert.rejects(timeout.client.read('firmness', device), /Reconnect/); assert.equal(timeout.actions.length, count); timeout.client.destroy();
});
