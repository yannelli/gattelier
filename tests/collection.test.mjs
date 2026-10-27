import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { configuration, setupCheck, captureCheck } = createRequire(import.meta.url)('../web/collection.js');
const defaults = { enabled: false, active: false, intervalMs: 160, windowMs: 80, periodMs: 0, burstMs: 10000, address: '' };
const ready = () => ({ usb: { mode: 'workbench' }, collection: { ...defaults, storageReady: true, configSaved: true, persistenceReady: true, savedEnabled: false, status: 'stopped', recordCount: 10, bootId: 123 } });

test('collection defaults use passive continuous scans with no address filter', () => {
  assert.deepEqual(configuration(defaults), defaults);
  assert.equal(configuration({ ...defaults, enabled: true, active: true }).active, true);
});

test('collection scan window fits within its interval', () => {
  assert.equal(configuration({ ...defaults, intervalMs: 10, windowMs: 5 }).windowMs, 5);
  assert.equal(configuration({ ...defaults, intervalMs: 10240, windowMs: 10240 }).intervalMs, 10240);
  for (const override of [{ intervalMs: 9 }, { intervalMs: 10241 }, { windowMs: 4 }, { windowMs: 161 }, { intervalMs: NaN }, { intervalMs: 160.1 }]) {
    assert.throws(() => configuration({ ...defaults, ...override }));
  }
});

test('collection burst timing accepts continuous or bounded periodic operation', () => {
  assert.equal(configuration({ ...defaults, burstMs: 1000, periodMs: 1000 }).periodMs, 1000);
  assert.equal(configuration({ ...defaults, burstMs: 600000, periodMs: 3600000 }).burstMs, 600000);
  for (const override of [{ periodMs: -1 }, { periodMs: 999 }, { periodMs: 3600001 }, { periodMs: 5000 }, { burstMs: 999 }, { burstMs: 600001 }, { burstMs: Infinity }]) {
    assert.throws(() => configuration({ ...defaults, ...override }));
  }
});

test('collection uses explicit Bluetooth addresses and allowlisted output fields', () => {
  const value = configuration({ ...defaults, address: 'AA:BB:CC:DD:EE:FF', privateKey: 'discarded' });
  assert.equal(value.address, 'aa:bb:cc:dd:ee:ff');
  assert.equal(Object.hasOwn(value, 'privateKey'), false);
  for (const address of ['Pocket', 'f4:4e:fc:a1:05', 'zz:4e:fc:a1:05:2a', null, 'aa:bb:cc:dd:ee:ff\n']) assert.throws(() => configuration({ ...defaults, address }));
  assert.throws(() => configuration({ ...defaults, enabled: 'true' }));
  assert.throws(() => configuration({ ...defaults, active: 1 }));
});

test('setup verification requires reachable workbench mode and saved settings', () => {
  assert.match(setupCheck(ready()).message, /verified and saved/);
  assert.equal(setupCheck(ready()).observe, false);
  assert.throws(() => setupCheck(ready(), { online: false }), /unavailable/);
  assert.throws(() => setupCheck(ready(), { dirty: true }), /Apply the edited/);
  assert.throws(() => setupCheck({ ...ready(), usb: { mode: 'hci' } }), /USB controller mode/);
  assert.throws(() => setupCheck({ ...ready(), usb: {} }), /did not report/);
  for (const override of [{ storageReady: false }, { full: true }, { damaged: true }, { configSaved: false }, { persistenceReady: false }, { windowMs: 999 }, { configError: 'Restore failed' }, { error: 'Write failed' }]) {
    assert.throws(() => setupCheck({ ...ready(), collection: { ...ready().collection, ...override } }));
  }
});

test('verification observes running captures and describes pauses without starting collection', () => {
  const root = ready(); root.collection.enabled = root.collection.savedEnabled = true;
  for (const [status, message] of [['paused-connected', /device is connected/], ['paused-busy', /BLE command/], ['scheduled', /scheduled burst/]]) {
    root.collection.status = status;
    assert.equal(setupCheck(root).observe, false);
    assert.match(setupCheck(root).message, message);
  }
  root.collection.status = 'collecting';
  assert.equal(setupCheck(root).observe, true);
  assert.equal(root.collection.enabled, true);
});

test('live capture verification reports record growth, silence, and a restart separately', () => {
  const before = ready(), after = ready();
  before.collection.enabled = after.collection.enabled = true;
  before.collection.status = after.collection.status = 'collecting';
  after.collection.recordCount = 13;
  assert.match(captureCheck(before, after), /3 new records saved/);
  after.collection.recordCount = 10;
  assert.match(captureCheck(before, after), /no new records arrived/);
  after.collection.bootId++;
  assert.throws(() => captureCheck(before, after), /restarted/);
});
