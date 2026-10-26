import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import catalogsAPI from '../web/catalogs.js';
import schema from '../web/catalog-schema.js';
import { buildCatalogs } from '../scripts/build-catalogs.mjs';
import { catalogs, fixture } from './catalog-fixtures.mjs';

test('download requests public paths only, saves offline data and searches all library kinds', async () => {
  const data = fixture(), store = catalogsAPI.create(data); await store.init(); await store.refresh();
  assert.equal(store.status().count, 2163); assert.equal(store.status().persistent, true);
  assert.equal(data.calls.length, 6);
  for (const call of data.calls) {
    assert.match(call.url, /^https:\/\/gattelier\.ryanyannelli\.com\/catalogs\/[a-z-]+\.json$/);
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.referrerPolicy, 'no-referrer');
    assert.equal(call.options.body, undefined);
  }
  assert.match(store.lookupUUID('0x180D').name, /heart rate/i);
  assert.equal(store.search('Meshtastic', 'protocol').rows[0].title, 'Meshtastic BLE client protocol');
  assert.ok(store.search('Keyboard', 'appearance').total);
  assert.equal(store.adType(16).length, 2);
  assert.equal(store.search('', '', 1).rows.length, 1);
  const restored = catalogsAPI.create({ ...data, fetcher: () => { throw new Error('offline'); } });
  await restored.init(); assert.equal(restored.status().count, store.status().count);
  assert.equal(restored.match({ services: ['6ba1b218-15a8-461f-9fa8-5dcae273eafd'] })[0].title, 'Meshtastic BLE client protocol');
});
test('disabled libraries stay disabled across updates and removal suppresses automatic downloads', async () => {
  const data = fixture(), store = catalogsAPI.create(data); await store.init(); await store.refresh();
  await store.enable('protocol-signatures', false);
  assert.equal(store.search('', 'protocol').total, 0);
  await store.refresh(); assert.equal(store.status().libraries.find(item => item.kind === 'protocol').enabled, false);
  await store.clear(); assert.equal(store.status().count, 0);
  data.calls.length = 0;
  const restored = catalogsAPI.create({ ...data, now: () => 1800000000000 }); await restored.init({ hosted: true });
  assert.equal(data.calls.length, 0); assert.equal(restored.status().count, 0);
  await restored.refresh(); assert.equal(restored.status().count, 2163);
});
test('failed, malformed, mismatched and oversized downloads preserve the entire existing set', async () => {
  for (const failure of ['404', 'schema', 'version', 'size']) {
    const data = fixture(), store = catalogsAPI.create(data); await store.init(); await store.refresh();
    const path = '/catalogs/protocol-signatures.json', original = data.bodies.get(path);
    if (failure === '404') data.bodies.delete(path);
    if (failure === 'schema') data.bodies.set(path, JSON.stringify({ schema: 900 }));
    if (failure === 'version') data.bodies.set(path, original.replace('Meshtastic', 'Teststatic'));
    if (failure === 'size') data.bodies.set(path, original + ' ');
    if (failure === 'version') {
      const index = structuredClone(data.index); index.libraries.find(item => item.id === 'protocol-signatures').revision = 'wrong'; data.bodies.set('/catalogs/index.json', JSON.stringify(index));
    }
    await assert.rejects(store.refresh(), /Existing libraries remain available/);
    assert.equal(store.status().count, 2163); assert.equal(data.saves.length, 1);
  }
});
test('invalid origins fail before requests and storage failure leaves session data usable', async () => {
  const data = fixture({ storage: { load: async () => undefined, save: async () => { throw new Error('quota'); } } });
  const store = catalogsAPI.create(data); await store.init();
  for (const origin of ['http://example.com', 'https://example.com/path', 'https://u:p@example.com', 'https://example.com?q=1']) await assert.rejects(store.refresh(origin), /HTTPS library origin/);
  assert.equal(data.calls.length, 0);
  await store.refresh(); assert.equal(store.status().count, 2163); assert.equal(store.status().persistent, false); assert.match(store.status().error, /quota/);
});
test('clearing during a download prevents late results and late cache initialization from returning', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; }), data = fixture();
  const store = catalogsAPI.create({ ...data, fetcher: async (...args) => { await waiting; return data.fetcher(...args); } });
  await store.init(); const refreshing = store.refresh(); await store.clear(); release(); await refreshing;
  assert.equal(store.status().count, 0); assert.equal(data.saves.at(-1).autoUpdate, false);
  let finishLoad;
  const loading = catalogsAPI.create({ ...data, storage: { load: () => new Promise(resolve => { finishLoad = resolve; }), save: async () => {} } });
  const init = loading.init({ hosted: true }); await loading.clear();
  data.calls.length = 0; finishLoad({ schema: 1, catalogs: catalogs.map(catalog => ({ catalog, enabled: true })) }); await init;
  assert.equal(loading.status().count, 0); assert.equal(data.calls.length, 0);
});
test('changes to enabled libraries while another library downloads are preserved at commit', async () => {
  const data = fixture(); let wait = false, release, reached;
  const slow = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
  const store = catalogsAPI.create({ ...data, fetcher: async (...args) => { if (wait && args[0].endsWith('protocol-signatures.json')) { reached(); await slow; } return data.fetcher(...args); } });
  await store.init(); await store.refresh(); wait = true;
  const updating = store.refresh(); await arrived; await new Promise(resolve => setImmediate(resolve));
  await store.enable('bluetooth-uuids', false); release(); await updating;
  assert.equal(store.lookupUUID('180d'), undefined);
  assert.equal(data.saves.at(-1).catalogs.find(item => item.catalog.id === 'bluetooth-uuids').enabled, false);
});
test('cloud build publishes validated files with byte-exact manifest entries', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'gattelier-catalogs-'));
  try {
    const index = await buildCatalogs(fileURLToPath(new URL('../', import.meta.url)), destination);
    schema.manifest(index);
    for (const entry of index.libraries) {
      const bytes = await readFile(join(destination, entry.path)); assert.equal(bytes.length, entry.bytes);
      const catalog = schema.validate(JSON.parse(bytes)); assert.equal(catalog.revision, entry.revision); assert.equal(catalog.entries.length, entry.count);
    }
  } finally { await rm(destination, { recursive: true, force: true }); }
});
