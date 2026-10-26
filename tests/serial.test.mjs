import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FakePort, frame, encoder, tick } from './serial-helpers.mjs';
const require = createRequire(import.meta.url);
const Serial = require('../web/serial.js');
const Wire = require('../web/serial-wire.js');
const Codec = require('../web/serial-codec.js');

async function setup(t, options) {
  const port = new FakePort();
  await port.open({});
  const wire = Wire.create(port, options);
  t.after(() => wire.close());
  return { port, wire };
}

test('wire ignores boot logs and preserves binary bytes across fragmented frames', async t => {
  const { port, wire } = await setup(t);
  const pending = wire.fetch('/api/binary');
  await tick();
  const bytes = encoder.encode('snow 雪 😀');
  const data = `booting\n${frame({ id: 1, event: 'start', status: 200, type: 'application/octet-stream' })}${frame({ id: 1, event: 'data', data: Buffer.from(bytes.slice(0, 6)).toString('base64') })}${frame({ id: 1, event: 'data', data: Buffer.from(bytes.slice(6)).toString('base64') })}${frame({ id: 1, event: 'end', ok: true })}`;
  for (const byte of encoder.encode(data)) port.emit(Uint8Array.of(byte));
  const response = await pending;
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
});

test('malformed frames reject current and queued work and release locks', async t => {
  const { port, wire } = await setup(t);
  const first = assert.rejects(wire.fetch('/api/state'), /Invalid USB response data/);
  const second = assert.rejects(wire.fetch('/api/events'), /Invalid USB response data/);
  port.emit(frame({ id: 1, event: 'start', status: 200, type: 'application/json' }));
  port.emit(frame({ id: 1, event: 'data', data: '!!!!' }));
  await Promise.all([first, second]);
  await wire.close();
  assert.equal(port.closes, 1);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
});

test('sent abort drains its response and does not replay a mutation', async t => {
  const { port, wire } = await setup(t);
  const controller = new AbortController();
  const first = assert.rejects(wire.fetch('/api/action', { method: 'POST', body: '{}', signal: controller.signal }), { name: 'AbortError' });
  const second = wire.fetch('/api/state');
  await tick();
  controller.abort();
  await first;
  assert.equal(port.requests.length, 1);
  port.respond(1, '{}');
  await tick();
  assert.equal(port.requests.length, 2);
  port.respond(2, '{"ok":true}');
  assert.deepEqual(await (await second).json(), { ok: true });
  assert.equal(port.requests.filter(request => request.method === 'POST').length, 1);
});

test('queued cancellation and queue bounds do not write canceled requests', async t => {
  const { port, wire } = await setup(t, { queueLimit: 1 });
  const first = wire.fetch('/api/state');
  const controller = new AbortController();
  const queued = assert.rejects(wire.fetch('/api/events', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(wire.fetch('/api/extra'), /queue is full/);
  controller.abort();
  await queued;
  port.respond(1, '{}');
  await first;
  assert.equal(port.requests.length, 1);
});

test('request and parser limits reject invalid input', () => {
  assert.throws(() => Codec.request(1, '/api/state', { body: '雪'.repeat(467) }), /1400/);
  assert.throws(() => Codec.request(1, '/api/state', { headers: { Authorization: 'secret' } }), /headers/);
  assert.throws(() => Codec.request(1, '/api/state', { method: 'DELETE' }), /GET and POST/);
  assert.throws(() => Codec.request(1, '/api/' + 'a'.repeat(513)), /path/);
  assert.throws(() => Codec.decode('AB=='), /Invalid/);
  assert.throws(() => Codec.parser(() => {})(encoder.encode('a'.repeat(8193))), /limit/);
});

test('response limit closes the connection before retaining oversized data', async t => {
  const { port, wire } = await setup(t);
  const rejected = assert.rejects(wire.fetch('/api/events'), /2 MiB/);
  port.emit(frame({ id: 1, event: 'start', status: 200, type: 'text/plain' }));
  const chunk = frame({ id: 1, event: 'data', data: Buffer.alloc(768).toString('base64') });
  for (let size = 0; size <= Codec.limits.response; size += 768) port.emit(chunk);
  await rejected;
});

test('disconnect settles pending requests and cleans port locks', async t => {
  const { port, wire } = await setup(t);
  const pending = assert.rejects(wire.fetch('/api/state'), /disconnected/);
  port.input.close();
  await pending;
  await wire.close();
  assert.equal(port.closes, 1);
  assert.equal(port.readable.locked, false);
});

test('handshake, Wi-Fi toggle, and close use the session API', async () => {
  const port = new FakePort();
  let filter;
  const client = Serial.create({ navigator: { serial: { requestPort: async options => { filter = options; return port; } } } });
  assert.equal(port.requests.length, 0);
  await client.connect({ wifiOff: true });
  assert.deepEqual(filter.filters, [{ usbVendorId: 0x303a, usbProductId: 0x1001 }]);
  assert.equal(port.openOptions.baudRate, 115200);
  assert.equal(port.openOptions.bufferSize, 4096);
  assert.deepEqual(port.signals, { requestToSend: false, dataTerminalReady: true });
  assert.equal(client.status().wifiSuspended, true);
  await client.setWifiOff(false);
  assert.equal(client.status().wifiSuspended, false);
  await client.close();
  assert.equal(client.status().connected, false);
  assert.deepEqual(port.requests.map(request => JSON.parse(request.body).action), ['open', 'open', 'close']);
  assert.equal(port.closes, 1);
});

test('unsupported, insecure, chooser cancellation and locked ports report failures', async () => {
  await assert.rejects(Serial.create({ navigator: {} }).connect(), /desktop Chrome/);
  await assert.rejects(Serial.create({ navigator: {}, secureContext: false }).connect(), /HTTPS/);
  const canceled = Serial.create({ navigator: { serial: { requestPort: async () => { throw new DOMException('', 'NotFoundError'); } } } });
  await assert.rejects(canceled.connect(), /canceled/);
  const port = new FakePort();
  port.open = async () => { throw new DOMException('', 'NetworkError'); };
  await assert.rejects(Serial.create({ port }).connect(), /Close other serial tools/);
  assert.equal(port.closes, 0);
});

test('old firmware handshake timeout closes USB with recovery guidance', async () => {
  const port = new FakePort();
  port.onRequest = () => {};
  const client = Serial.create({ port, handshakeTimeout: 5 });
  await assert.rejects(client.connect(), /triple press/);
  assert.equal(client.status().connected, false);
  assert.equal(port.closes, 1);
});

test('closing rejects queued work and prioritizes Wi-Fi restoration after active request', async () => {
  const port = new FakePort();
  const client = Serial.create({ port });
  await client.connect();
  const active = assert.rejects(client.fetch('/api/state'), { name: 'AbortError' });
  const queued = assert.rejects(client.fetch('/api/events'), /closing/);
  const closing = client.close();
  port.respond(2, '{}');
  await Promise.all([active, queued, closing]);
  assert.deepEqual(port.requests.map(request => request.path), ['/api/serial', '/api/state', '/api/serial']);
  assert.equal(JSON.parse(port.requests[2].body).action, 'close');
});

test('reconnect waits for lost-port cleanup and requires an explicit connect call', async () => {
  const port = new FakePort();
  const client = Serial.create({ port });
  await client.connect();
  const lost = assert.rejects(client.fetch('/api/state'), /disconnected/);
  port.input.close();
  await lost;
  assert.equal(client.status().connected, false);
  assert.equal(port.requests.filter(request => request.path === '/api/serial').length, 1);
  await client.connect({ wifiOff: false });
  assert.equal(port.closes, 1);
  assert.equal(client.status().connected, true);
  assert.equal(client.status().wifiSuspended, false);
  await client.close();
});
