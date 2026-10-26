import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const packets = require('../web/packets.js');
const event = (seq, extra = {}) => ({ seq, ms: seq * 100, kind: 'notification', handle: 8, address: 'AA:BB:CC:DD:EE:FF', hex: '0102', length: 2, success: true, ...extra });
const batch = (events, extra = {}) => ({ bootId: 'boot-1', oldestSeq: 1, nextSeq: events.at(-1)?.seq || 0, dropped: 0, events, ...extra });

test('write payload validates byte pairs, UTF-8 and MTU limits', () => {
  assert.equal(packets.payload('00 ff 10', 'hex', true).hex, '00ff10');
  assert.equal(packets.payload('é', 'utf8', true).hex, 'c3a9');
  assert.throws(() => packets.payload('f', 'hex', true), /complete hexadecimal/);
  assert.throws(() => packets.payload('zz', 'hex', true), /complete hexadecimal/);
  assert.throws(() => packets.payload('', 'hex', true), /at least one byte/);
  assert.throws(() => packets.payload('aa'.repeat(21), 'hex', false, 23), /20 bytes/);
  assert.throws(() => packets.payload('aa'.repeat(513), 'hex', true), /512 bytes/);
  assert.equal(packets.payload('aa'.repeat(20), 'hex', false, 23).length, 20);
});

test('packet decoder reads offsets and both byte orders without overruns', () => {
  const result = packets.decode('ff0102030441', 1);
  assert.equal(result.uint16LE, 513);
  assert.equal(result.uint16BE, 258);
  assert.equal(result.uint32LE, 67305985);
  assert.equal(result.uint32BE, 16909060);
  assert.equal(result.rows[0].ascii, '.....A');
  assert.equal(packets.decode('0000803f').float32LE, 1);
  assert.equal(packets.decode('3f800000').float32BE, 1);
  assert.equal(packets.decode('01').uint16LE, null);
  assert.equal(packets.decode('010203', 2).uint32LE, null);
  assert.throws(() => packets.decode('00', -1), /offset/);
  assert.throws(() => packets.decode('00', 2), /offset/);
});

test('capture deduplicates, counts gaps and distinguishes overwrites already received', () => {
  const capture = packets.createCapture();
  capture.ingest(batch([event(1), event(2)]));
  capture.ingest(batch([event(2), event(3)], { dropped: 1 }));
  assert.equal(capture.snapshot().stats.gaps, 0);
  assert.equal(capture.snapshot().stats.boardDropped, 1);
  capture.ingest(batch([event(6)]));
  assert.equal(capture.snapshot().stats.gaps, 2);
  assert.deepEqual(capture.snapshot().events.map(item => item.seq), [1, 2, 3, 6]);
});

test('capture detects reboot and counts browser eviction and truncation', () => {
  const capture = packets.createCapture(2);
  capture.ingest(batch([event(1), event(2), event(3, { truncated: true })]));
  const result = capture.ingest(batch([event(1)], { bootId: 'boot-2' }));
  assert.equal(result.meta.reboot, true);
  assert.equal(capture.snapshot().stats.reboots, 1);
  assert.equal(capture.snapshot().stats.browserDropped, 2);
  assert.equal(capture.snapshot().stats.truncated, 1);
  assert.deepEqual(capture.snapshot().events.map(item => item.bootId), ['boot-1', 'boot-2']);
});

test('authentication writes are redacted before capture and export', () => {
  const capture = packets.createCapture();
  const secret = packets.hex(new TextEncoder().encode('APP&SK&secret-key'));
  capture.ingest(batch([event(1, { kind: 'write', hex: secret })]));
  assert.equal(capture.snapshot().events[0].hex, '');
  assert.equal(capture.snapshot().events[0].redacted, true);
  assert.equal(packets.csv(capture.snapshot()).includes(secret), false);
});

test('filtering supports hexadecimal handles, kinds, HEX and ASCII', () => {
  const events = [event(1, { hex: '4142' }), event(2, { handle: 9, kind: 'write' })];
  assert.deepEqual(packets.filter(events, { handle: '0x08', text: 'AB' }).map(item => item.seq), [1]);
  assert.deepEqual(packets.filter(events, { kind: 'write', text: '0102' }).map(item => item.seq), [2]);
});

test('RX export isolates boot/address/handle and flags incomplete captures', () => {
  const capture = packets.createCapture();
  capture.ingest(batch([event(1), event(2, { kind: 'write' }), event(3, { handle: 9 }), event(4, { address: 'OTHER' })]));
  const stream = { handle: 8, address: 'AA:BB:CC:DD:EE:FF', bootId: 'boot-1' };
  let binary = packets.rxBinary(capture.snapshot(), stream);
  assert.equal(packets.hex(binary.data), '0102');
  assert.equal(binary.incomplete, false);
  assert.equal(binary.verified, false);
  capture.ingest(batch([event(6)]));
  binary = packets.rxBinary(capture.snapshot(), stream);
  assert.equal(binary.incomplete, true);
});

function labWithResponses(responses) {
  const calls = [], events = [];
  const context = {
    NanoPackets: packets, NanoConsole: { update() {} }, console, setTimeout, clearTimeout, AbortController,
    document: { dispatchEvent(event) { events.push(event); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    fetch: async (path, options) => {
      calls.push({ path, options });
      const response = await responses.shift();
      if (!response) throw new Error('Unexpected request');
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    }
  };
  context.NanoAPI = { fetch: (path, options) => context.fetch(`/api/${path}`, options) };
  vm.runInNewContext(readFileSync(new URL('../web/lab.js', import.meta.url), 'utf8'), context);
  context.NanoLab.update({ ble: { connected: true, busy: false }, services: [] }, true);
  return { lab: context.NanoLab, calls, events };
}

test('shared action waits for completion and propagates the resulting state', async () => {
  const ready = { ble: { connected: true, busy: false, error: '' }, services: [] };
  const { lab, calls, events } = labWithResponses([
    { status: 202, body: { ok: true } },
    { status: 200, body: { ...ready, ble: { ...ready.ble, busy: true } } },
    { status: 200, body: ready }
  ]);
  assert.equal(await lab.action('write', { handle: 8, hex: '00', response: true }), ready);
  assert.deepEqual(calls.map(call => call.path), ['/api/write', '/api/state', '/api/state']);
  assert.equal(lab.getState(), ready);
  assert.equal(lab.isActing(), false);
  assert.deepEqual(events.filter(item => item.type === 'nanoscope:busy').map(item => item.detail), [true, false]);
});

test('shared actions reject device errors and HTTP failures', async () => {
  const failed = labWithResponses([{ status: 202, body: { ok: true } }, { status: 200, body: { ble: { busy: false, error: 'Write rejected' } } }]);
  await assert.rejects(failed.lab.action('write', {}), /Write rejected/);
  assert.equal(failed.lab.isActing(), false);
  const http = labWithResponses([{ status: 409, body: { error: 'Already connected' } }]);
  await assert.rejects(http.lab.action('connect', {}), /Already connected/);
});

test('shared action rejects overlapping commands', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { lab } = labWithResponses([pending, { status: 200, body: { ble: { busy: false } } }]);
  const first = lab.action('write', {});
  await assert.rejects(lab.action('write', {}), /current BLE operation/);
  release({ status: 202, body: { ok: true } });
  await first;
});

test('board loss counts independent polling gaps', () => {
  const capture = packets.createCapture();
  capture.ingest(batch([event(4)], { dropped: 3 }));
  capture.ingest(batch([event(8)], { dropped: 3 }));
  assert.equal(capture.snapshot().stats.boardDropped, 6);
  assert.equal(capture.snapshot().stats.gaps, 6);
});

test('PLAUD signature writes are redacted only on the command characteristic', () => {
  assert.equal(packets.sensitive('10fe0300abcd', '0x2bb1'), true);
  assert.equal(packets.sensitive('10fe0300abcd', '0x1234'), false);
  const capture = packets.createCapture();
  capture.ingest(batch([event(1, { kind: 'write', uuid: '0x2bb1', hex: '10fe0300abcd' })]));
  assert.equal(capture.snapshot().events[0].hex, '');
  assert.equal(capture.snapshot().events[0].redacted, true);
});
