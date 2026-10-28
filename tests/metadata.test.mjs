import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const metadata = createRequire(import.meta.url)('../web/metadata.js');
const catalog = JSON.parse(readFileSync(new URL('../web/metadata-v1.json', import.meta.url)));
const make = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
const supplemental = { schema: 1, revision: 'test.1', entries: [{ uuid: 'abcd', name: 'Test state', source: 'https://example.org/protocol', decode: { type: 'enum', bytes: 1, label: 'State', values: { 0: 'Idle', 1: 'Running' } } }] };

test('bundled catalog provides UUID names and exact-length human-readable states', async () => {
  const api = metadata.create({ storage: make(), fetcher: async () => new Response(JSON.stringify(catalog)) });
  await api.init();
  assert.equal(api.lookup('00001809-0000-1000-8000-00805f9b34fb').name, 'Health Thermometer');
  assert.equal(api.decode('2a38', '02')[0].value, 'Wrist');
  assert.equal(api.decode('2a06', '02')[0].value, 'High alert');
  assert.equal(api.decode('2902', '0200')[0].value, 'Indications enabled');
  assert.deepEqual(api.decode('2902', '02'), []);
  assert.equal(api.decode('2a38', 'ff')[0].value, 'Unassigned (255)');
  assert.deepEqual(api.decode('2a38', 'zz'), []);
  assert.ok(api.status().count >= 743);
  for (const [uuid, name] of Object.entries({ '2a05': 'Service Changed', '2b29': 'Client Supported Features', '2b3a': 'Server Supported Features', '2900': 'Characteristic Extended Properties', '2902': 'Client Characteristic Configuration', '272f': 'Celsius temperature (degree Celsius)', '2803': 'Characteristic' })) assert.equal(api.lookup(uuid).name, name);
  assert.match(api.lookup('2a05').description, /changed attribute handles/);
  assert.equal(api.lookup('f000ffe0-0451-4000-b000-000000000000'), null);
});

test('supplemental downloads send no device data and persist origin and definitions', async () => {
  const storage = make(); let request;
  const api = metadata.create({ storage, fetcher: async (url, options) => { request = { url, options }; return new Response(JSON.stringify(supplemental)); } });
  await api.refresh('https://metadata.example.org');
  assert.equal(request.url, 'https://metadata.example.org/metadata-v1.json');
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(request.options.body, undefined); assert.equal(request.options.cache, 'no-store');
  assert.equal(api.decode('abcd', '01')[0].value, 'Running');
  const restored = metadata.create({ storage });
  assert.equal(restored.status().origin, 'https://metadata.example.org');
  assert.equal(restored.decode('abcd', '01')[0].value, 'Running');
  restored.enable(false); assert.deepEqual(restored.decode('abcd', '01'), []);
  restored.enable(true); assert.equal(restored.decode('abcd', '01')[0].value, 'Running');
  restored.clear(); assert.equal(restored.status().supplemental, '');
});

test('invalid downloads keep the previous catalog and reject executable decoder formats', async () => {
  let next = supplemental;
  const api = metadata.create({ storage: make(), fetcher: async () => new Response(JSON.stringify(next)) });
  await api.refresh();
  next = { ...supplemental, entries: [{ ...supplemental.entries[0], decode: { type: 'javascript', expression: 'alert(1)' } }] };
  await assert.rejects(api.refresh(), /Unsupported metadata decoder/);
  assert.equal(api.decode('abcd', '01')[0].value, 'Running');
  await assert.rejects(api.refresh('http://example.org'), /HTTPS/);
  assert.throws(() => metadata.validate({ ...supplemental, entries: [supplemental.entries[0], supplemental.entries[0]] }), /Invalid metadata entry/);
  assert.throws(() => metadata.validate({ ...supplemental, entries: [{ ...supplemental.entries[0], source: 'javascript:alert(1)' }] }), /HTTPS/);
  assert.throws(() => metadata.validate({ ...supplemental, entries: [{ ...supplemental.entries[0], description: 'x'.repeat(481) }] }), /description/);
});

test('oversized metadata does not replace stored definitions', async () => {
  const api = metadata.create({ storage: make(), fetcher: async () => new Response(' '.repeat(512 * 1024 + 1)) });
  await assert.rejects(api.refresh(), /exceeds 512 KiB/);
  assert.equal(api.status().supplemental, '');
});

test('a supplemental decoder fills a bundled name-only entry', async () => {
  let next = { schema: 1, revision: 'local', entries: [{ uuid: 'abcd', name: 'Local name', source: 'https://example.org/protocol' }] };
  const api = metadata.create({ storage: make(), fetcher: async () => new Response(JSON.stringify(next)) });
  await api.init(); next = supplemental; await api.refresh();
  assert.equal(api.lookup('abcd').name, 'Local name');
  assert.equal(api.decode('abcd', '01')[0].value, 'Running');
  api.enable(false); assert.deepEqual(api.decode('abcd', '01'), []);
});

test('vendor names ship offline including Nordic UART and Polar PMD', async () => {
  const api = metadata.create({ storage: make(), fetcher: async () => new Response(JSON.stringify(catalog)) });
  await api.init();
  assert.match(api.lookup('6e400001-b5a3-f393-e0a9-e50e24dcca9e').name, /UART/);
  assert.match(api.lookup('fb005c80-02e7-f387-1cad-8acd2d8df0c8').name, /Polar/);
  assert.ok(api.status().count >= 993);
});
