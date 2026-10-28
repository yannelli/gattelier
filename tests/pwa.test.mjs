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

async function appFixture({ registrationFails = false, secure = true, initialInstallation = false } = {}) {
  const elements = new Map(), handlers = new Map(), messages = [], registrationHandlers = new Map();
  let installation, resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  let updates = 0, reloads = 0, registrations = 0, failUpdate = false;
  const get = key => {
    if (!elements.has(key)) elements.set(key, { textContent: '', hidden: false, disabled: false, addEventListener() {} });
    return elements.get(key);
  };
  const pending = { postMessage: message => messages.push(message) };
  const registration = { active: initialInstallation ? null : {}, waiting: initialInstallation ? null : pending, installing: null, addEventListener: (type, callback) => registrationHandlers.set(type, callback),
    async update() { updates++; if (failUpdate) throw new Error('offline'); } };
  function startInstallation() {
    const listeners = [], worker = { state: 'installing', addEventListener: (_type, callback) => listeners.push(callback) };
    registration.installing = worker;
    installation = state => {
      worker.state = state; registration.installing = null;
      if (state === 'activated') { registration.active = worker; resolveReady(registration); }
      listeners.forEach(callback => callback());
    };
    registrationHandlers.get('updatefound')?.();
  }
  if (initialInstallation) startInstallation();
  const context = vm.createContext({ module: { exports: {} }, isSecureContext: secure, document: { hidden: false },
    navigator: { serviceWorker: { ready, register: async () => { registrations++; if (registrationFails) throw new Error('worker download failed (503)'); if (initialInstallation && registrations > 1) startInstallation(); return registration; }, addEventListener: (type, callback) => handlers.set(type, callback) } },
    location: { reload: () => reloads++ }, addEventListener() {},
  });
  vm.runInContext(readFileSync(new URL('../web/pwa.js', import.meta.url), 'utf8'), context);
  await context.module.exports.mount({ classList: { add() {} }, querySelector: get });
  return { app: context.module.exports, registration, get, messages,
    setOffline: value => { failUpdate = value; }, setRegistrationFailure: value => { registrationFails = value; }, registrations: () => registrations, updates: () => updates, reloads: () => reloads,
    controllerChanged: () => handlers.get('controllerchange')?.(), startInstallation, failInstallation: () => installation('redundant'), finishInstallation: () => installation('activated') };
}

test('a downloaded waiting update can install without another network check', async () => {
  const f = await appFixture(); f.setOffline(true);
  assert.equal(f.get('[data-pwa-update]').textContent, 'Install update');
  await f.app.refresh();
  assert.equal(f.updates(), 0);
  assert.equal(f.messages[0]?.type, 'SKIP_WAITING');
  f.controllerChanged(); assert.equal(f.reloads(), 1);
  assert.equal(f.get('[data-pwa-detail]').textContent, '');
});

test('an unavailable update check retains a usable retry action', async () => {
  const f = await appFixture(); f.registration.waiting = null; f.setOffline(true);
  await f.app.refresh();
  assert.equal(f.updates(), 1); assert.equal(f.messages.length, 0);
  assert.equal(f.get('[data-pwa-update]').disabled, false);
  assert.equal(f.get('[data-pwa-detail]').textContent, 'offline');
});

test('initial offline setup failures can be retried without reloading the app', async () => {
  const f = await appFixture({ registrationFails: true });
  assert.equal(f.get('[data-pwa-update]').disabled, false);
  assert.equal(f.get('[data-pwa-update]').textContent, 'Retry offline setup');
  assert.equal(f.registrations(), 1);
  f.setRegistrationFailure(false); f.registration.waiting = null;
  await f.app.refresh();
  assert.equal(f.registrations(), 2); assert.equal(f.updates(), 0); assert.equal(f.reloads(), 0);
  assert.equal(f.get('[data-pwa-status]').textContent, 'Available offline');
  assert.equal(f.get('[data-pwa-detail]').textContent, '');
  assert.equal(f.get('[data-pwa-update]').disabled, false);
});

test('a repeated setup failure keeps the retry action available', async () => {
  const f = await appFixture({ registrationFails: true });
  await f.app.refresh();
  assert.equal(f.registrations(), 2);
  assert.equal(f.get('[data-pwa-status]').textContent, 'Offline setup unavailable');
  assert.equal(f.get('[data-pwa-update]').disabled, false);
  assert.match(f.get('[data-pwa-detail]').textContent, /retry/i);
});

test('offline setup stays disabled on an insecure page', async () => {
  const f = await appFixture({ secure: false });
  await f.app.refresh();
  assert.equal(f.registrations(), 0);
  assert.equal(f.get('[data-pwa-update]').disabled, true);
  assert.equal(f.get('[data-pwa-status]').textContent, 'Needs HTTPS for offline use');
});

test('failed first asset installation reports a terminal failure and retries in place', async () => {
  const f = await appFixture({ initialInstallation: true });
  assert.equal(f.get('[data-pwa-status]').textContent, 'Saving for offline use…');
  assert.equal(f.get('[data-pwa-update]').disabled, true);
  f.failInstallation();
  assert.equal(f.get('[data-pwa-status]').textContent, 'Offline setup unavailable');
  assert.equal(f.get('[data-pwa-update]').textContent, 'Retry offline setup');
  f.registration.update = async () => { throw new Error('Registration was removed'); };
  await f.app.refresh(); f.finishInstallation(); await Promise.resolve();
  assert.equal(f.get('[data-pwa-status]').textContent, 'Available offline');
  assert.equal(f.get('[data-pwa-detail]').textContent, '');
  assert.equal(f.registrations(), 2); assert.equal(f.updates(), 0); assert.equal(f.reloads(), 0);
});
