import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { create } = require('../web/scan-stream.js');
const response = (batch, status = 200) => ({ ok: status === 200, status, json: async () => batch });
function fixture(fetch) {
  const batches = [], errors = [], resets = [];
  const store = { ingestAdvertisements(batch, receivedAt) { batches.push({ batch, receivedAt }); return { cursor: batch.cursor }; }, streamError(error) { errors.push(error); }, resetStream() { resets.push(true); } };
  return { client: create(store, { fetch, now: () => 1000, timeoutMs: 10 }), batches, errors, resets };
}
test('stream polling applies backpressure and advances a boot-scoped cursor', async () => {
  let finish; const calls = [];
  const f = fixture((path, options) => { calls.push({ path, options }); return new Promise(resolve => { finish = resolve; }); });
  const first = f.client.poll(); assert.equal(f.client.poll(), first); assert.equal(calls.length, 1);
  finish(response({ bootId: 'one', cursor: 5 })); await first; assert.equal(f.batches.length, 1);
  const next = f.client.poll(); assert.equal(calls[1].path, 'advertisements?after=5&bootId=one');
  finish(response({ bootId: 'one', cursor: 7 })); await next; assert.equal(f.client.status().cursor, 7); f.client.destroy();
});
test('a board reboot refetches the retained journal from zero before ingestion', async () => {
  const replies = [{ bootId: 'one', cursor: 5 }, { bootId: 'two', cursor: 20, devices: ['incomplete'] }, { bootId: 'two', cursor: 20, devices: ['retained'] }], paths = [];
  const f = fixture(async path => { paths.push(path); return response(replies.shift()); });
  await f.client.poll(); await f.client.poll();
  assert.equal(paths[2], 'advertisements?after=0&bootId=one'); assert.equal(f.batches.length, 2);
  assert.deepEqual(f.batches[1].batch.devices, ['retained']); f.client.destroy();
});
test('API changes abort the old request and reject late data from that endpoint', async () => {
  const calls = [];
  const f = fixture((path, options) => new Promise(resolve => calls.push({ path, options, resolve })));
  const old = f.client.poll(); f.client.reset(); assert.equal(calls[0].options.signal.aborted, true);
  const fresh = f.client.poll(); calls[1].resolve(response({ bootId: 'new-board', cursor: 2 })); await fresh;
  calls[0].resolve(response({ bootId: 'old-board', cursor: 90 })); await old;
  assert.equal(f.batches.length, 1); assert.equal(f.client.status().bootId, 'new-board'); assert.equal(f.client.status().cursor, 2); f.client.destroy();
});
test('older firmware signals fallback and timeouts preserve the previous cursor', async () => {
  let calls = 0; const legacy = fixture(async () => { calls++; return response({}, 404); });
  await legacy.client.poll(); await legacy.client.poll(); assert.equal(calls, 1); assert.equal(legacy.client.status().supported, false); legacy.client.destroy();
  const timeout = fixture((_path, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  await timeout.client.poll(); assert.match(timeout.client.status().error, /timed out/); assert.equal(timeout.client.status().cursor, 0); assert.equal(timeout.errors.length, 1); timeout.client.destroy();
});
