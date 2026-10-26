import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
test('manifest and touch icons have matching PNG dimensions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../web/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  for (const size of [180, 192, 512]) {
    const png = readFileSync(new URL(`../web/icons/nanoscope-${size}.png`, import.meta.url));
    assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
function worker() {
  const listeners = {}, stores = new Map();
  let offline = false, revision = 'first';
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async key => stores.delete(key),
    open: async key => {
      if (!stores.has(key)) stores.set(key, new Map());
      return { put: async (path, response) => stores.get(key).set(path, response), match: async path => stores.get(key).get(path) };
    },
  };
  const context = vm.createContext({ URL, caches, self: {
    location: { origin: 'https://nano.test' }, clients: { claim: async () => {} },
    addEventListener: (name, callback) => { listeners[name] = callback; }, skipWaiting: () => {},
  }, fetch: async (path, options) => {
    assert.equal(options.credentials, 'omit');
    if (offline) throw new Error('offline');
    return { ok: true, redirected: false, text: `${revision}:${path}`, clone() { return this; } };
  } });
  vm.runInContext(workerSource, context);
  return { listeners, stores, caches, setOffline: value => { offline = value; }, setRevision: value => { revision = value; } };
}
async function lifecycle(instance, name) {
  let work;
  instance.listeners[name]({ waitUntil: promise => { work = promise; } });
  await work;
}
function fetchEvent(instance, path, method = 'GET') {
  let response;
  instance.listeners.fetch({ request: { method, url: new URL(path, 'https://nano.test').href }, respondWith: promise => { response = promise; } });
  return response;
}

test('installed shell opens offline and excludes API, credentials and other origins', async () => {
  const instance = worker();
  await lifecycle(instance, 'install');
  instance.setOffline(true);
  assert.equal((await fetchEvent(instance, '/')).text, 'first:/');
  assert.equal((await fetchEvent(instance, '/app.bundle.js?version=2')).text, 'first:/app.bundle.js');
  for (const path of ['/api/state', '/api/write', '/credentials.json', 'https://elsewhere.test/app.bundle.js']) {
    assert.equal(fetchEvent(instance, path), undefined);
  }
  assert.equal(fetchEvent(instance, '/', 'POST'), undefined);
});

test('activation removes previous app caches and preserves unrelated storage', async () => {
  const instance = worker();
  await instance.caches.open('other-app');
  await instance.caches.open('nanoscope-shell-old');
  await lifecycle(instance, 'install');
  await lifecycle(instance, 'activate');
  assert.deepEqual(await instance.caches.keys(), ['other-app', 'nanoscope-shell-__NANO_BUILD__']);
});

test('manual refresh replaces assets and retains the working shell on download failure', async () => {
  const instance = worker();
  await lifecycle(instance, 'install');
  const refresh = async () => {
    let work, result;
    instance.listeners.message({ data: { type: 'REFRESH_SHELL' }, ports: [{ postMessage: value => { result = value; } }], waitUntil: promise => { work = promise; } });
    await work; return result;
  };
  instance.setRevision('second');
  assert.equal((await refresh()).ok, true);
  instance.setOffline(true);
  assert.equal((await refresh()).ok, false);
  assert.equal((await fetchEvent(instance, '/')).text, 'second:/');
});

test('foreground failures back off and background polling follows the preference', () => {
  const context = vm.createContext({ module: { exports: {} }, document: { hidden: false } });
  vm.runInContext(readFileSync(new URL('../web/pwa.js', import.meta.url), 'utf8'), context);
  const app = context.module.exports;
  assert.equal(app.pollDelay(), 1500);
  app.reportConnection(false);
  assert.equal(app.pollDelay(), 3000);
  for (let i = 0; i < 20; i++) app.reportConnection(false);
  assert.equal(app.pollDelay(), 30000);
  app.reportConnection(true);
  assert.equal(app.pollDelay(), 1500);
  context.document.hidden = true;
  assert.equal(app.pollDelay(), null);
  assert.equal(app.pollDelay({ background: true }), 30000);
});

test('explicit metadata download bypasses the installed shell catalog', async () => {
  const instance = worker(); await lifecycle(instance, 'install');
  assert.equal((await fetchEvent(instance, '/metadata-v1.json')).text, 'first:/metadata-v1.json');
  let intercepted = false;
  instance.listeners.fetch({ request: { method: 'GET', url: 'https://nano.test/metadata-v1.json', cache: 'no-store' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
});
