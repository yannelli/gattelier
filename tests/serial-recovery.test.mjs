import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FakePort, frame, tick } from './serial-helpers.mjs';
const require = createRequire(import.meta.url);
const Wire = require('../web/serial-wire.js');
const Serial = require('../web/serial.js');

test('new USB session terminates partial input and skips old response fragments', async t => {
  const port = new FakePort();
  await port.open({});
  const wire = Wire.create(port, { synchronize: true, initialId: 42 });
  t.after(() => wire.close());
  const response = wire.fetch('/api/state');
  await tick();
  assert.equal(port.writes[0][0], 10);
  assert.equal(port.requests[0].id, 42);
  port.emit('@G1 {"v":1,"id":9,"event":"data","data":"interrupted\n');
  port.respond(9, '{"old":true}');
  port.respond(42, '{"fresh":true}');
  assert.deepEqual(await (await response).json(), { fresh: true });
});

test('synchronized USB sessions reject corrupt responses without replaying commands', async t => {
  const port = new FakePort();
  await port.open({});
  const wire = Wire.create(port, { synchronize: true, initialId: 42 });
  t.after(() => wire.close());
  const first = wire.fetch('/api/state');
  await tick(); port.respond(42, '{}'); await first;
  const command = assert.rejects(wire.fetch('/api/connect', { method: 'POST', body: '{}' }), SyntaxError);
  await tick();
  port.emit('@G1 {bad frame}\n');
  await command;
  assert.equal(port.requests.filter(request => request.path === '/api/connect').length, 1);
});

test('stale frames cannot satisfy the handshake and synchronization remains bounded', async t => {
  const port = new FakePort();
  await port.open({});
  let expire;
  const timers = { setTimeout(callback) { expire = callback; return 1; }, clearTimeout() {} };
  const wire = Wire.create(port, { synchronize: true, initialId: 42, timers });
  t.after(() => wire.close());
  const response = assert.rejects(wire.fetch('/api/state'), /timed out/);
  await tick();
  port.respond(9, '{}');
  port.emit(frame({ id: 42, event: 'data', data: 'e30=' }));
  await tick();
  expire();
  await response;
  await wire.close();
  assert.equal(port.closes, 1);
});

test('client assigns a fresh request ID for a later USB connection', async t => {
  let next = 40;
  t.mock.method(globalThis.crypto, 'getRandomValues', values => { values[0] = next++; return values; });
  const port = new FakePort();
  const client = Serial.create({ port });
  await client.connect();
  const first = port.requests[0].id;
  await client.close();
  const count = port.requests.length;
  await client.connect();
  assert.notEqual(port.requests[count].id, first);
  await client.close();
});

test('a response that keeps streaming outlives the silence timeout', async t => {
  const port = new FakePort();
  await port.open({});
  const wire = Wire.create(port, { synchronize: true, initialId: 42, timeout: 40 });
  t.after(() => wire.close());
  const response = wire.fetch('/api/collection/export');
  await tick();
  port.emit(frame({ id: 42, event: 'start', status: 200, type: 'application/x-ndjson' }));
  for (let part = 0; part < 4; part++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    port.emit(frame({ id: 42, event: 'data', data: Buffer.from(`line ${part}\n`).toString('base64') }));
  }
  port.emit(frame({ id: 42, event: 'end', ok: true }));
  assert.equal(await (await response).text(), 'line 0\nline 1\nline 2\nline 3\n');
});
