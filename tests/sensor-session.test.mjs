import test from 'node:test';
import assert from 'node:assert/strict';
import sensorSession from '../web/sensor-session.js';
import sensorHistory from '../web/sensor-history.js';
const { create } = sensorSession;
const key = '231d39c1d7cc1ab1aee224cd096db932';
const encrypted = (at = 1000, extra = {}) => ({ address: '54:48:e6:8f:80:a5', addressType: 0, lastSeenMs: at, serviceData: [{ uuid: '0xfcd2', hex: '41e445f3c9962b332211006c7c4519' }], ...extra });
const readings = counter => ({ protocol: 'bthome', authenticated: true, counter, fields: [{ label: 'Temperature', value: '25.06 °C', numericValue: 25.06, unit: '°C' }] });
function delayedSession() {
  const history = sensorHistory.create({ storage: null, now: () => 1e7 }), decodes = [];
  const session = create(history, { decode: device => new Promise((resolve, reject) => decodes.push({ device, resolve, reject })) });
  return { session, history, decodes };
}

test('sensor keys authenticate official captured data and stay out of session status', async () => {
  const captured = [], session = create({ ingest: (device, profile) => captured.push({ device, profile }) });
  await session.select(encrypted()); assert.equal(session.status().encrypted, true);
  await session.unlock(key); assert.equal(session.status().profile.authenticated, true);
  assert.equal(captured.at(-1).profile.counter, 1122867); assert.equal(JSON.stringify(session.status()).includes(key), false);
  session.lock(); assert.equal(session.status().hasKey, false); assert.equal(session.status().profile.authenticated, undefined);
});
test('late decryptions cannot populate a different device or restore a forgotten key', async () => {
  let resolve; const captured = [], session = create({ ingest: (_device, profile) => { if (profile.authenticated) captured.push(profile); } }, { decode: () => new Promise(done => { resolve = done; }) });
  await session.select(encrypted()); const pending = session.unlock(key);
  await session.select({ address: '02:00:00:00:00:01', addressType: 0, lastSeenMs: 2000, serviceData: [{ uuid: 'fcd2', hex: '4002ca09' }] });
  resolve(readings(10)); await pending;
  assert.equal(captured.length, 0); assert.equal(session.status().hasKey, false); assert.equal(session.status().profile.authenticated, undefined);
});
test('old and reused counters with changed frames do not enter history', async () => {
  const counters = [10, 9, 10, 11], captured = [], session = create({ ingest: (_device, profile) => { if (profile.authenticated) captured.push(profile.counter); } }, { decode: async () => readings(counters.shift()) });
  await session.select(encrypted()); await session.unlock(key);
  await session.observe(encrypted(2000)); assert.match(session.status().message, /counter/);
  await session.observe(encrypted(3000, { manufacturer: '0102' })); assert.match(session.status().message, /counter/);
  await session.observe(encrypted(4000)); assert.deepEqual(captured, [10, 11]);
});
test('pausing history continues decoding and resuming uses the latest observation', async () => {
  let count = 0; const session = create({ ingest() { count++; } });
  const plain = at => ({ address: '02:00:00:00:00:01', addressType: 0, lastSeenMs: at, serviceData: [{ uuid: 'fcd2', hex: '4002ca09' }] });
  await session.select(plain(1000)); assert.equal(count, 1); session.toggle(); await session.observe(plain(2000));
  assert.equal(count, 1); assert.equal(session.status().recording, false); assert.ok(session.status().profile.fields.length);
  session.toggle(); assert.equal(count, 2);
});
test('repeated authenticated packets do not refresh history and cleartext cannot downgrade a protected sensor', async () => {
  const captured = [], session = create({ ingest: (device, profile) => captured.push({ device, profile }) }, { decode: async () => readings(10) });
  await session.select(encrypted()); await session.unlock(key); await session.observe(encrypted(2000));
  assert.equal(captured.length, 1); assert.equal(captured[0].device.lastSeenMs, 1000);
  const forged = at => encrypted(at, { serviceData: [{ uuid: 'fcd2', hex: '4002ca09' }] });
  await session.observe(forged(3000)); assert.match(session.status().message, /Unencrypted/); assert.equal(session.status().profile, null);
  session.lock(); await session.observe(forged(4000)); assert.equal(captured.length, 1); assert.equal(session.status().encrypted, true);
});

test('pending decryption drains the latest same-device observation into its profile and history', async () => {
  const { session, history, decodes } = delayedSession(), latest = encrypted(7000, { manufacturer: '0304' });
  await session.select(encrypted()); const pending = session.unlock(key);
  await session.observe(encrypted(2000, { manufacturer: '0102' })); await session.select(latest);
  assert.equal(session.status().device, latest); assert.equal(session.status().pending, true);
  decodes[0].resolve(readings(10)); await Promise.resolve();
  assert.equal(decodes.length, 2); assert.equal(decodes[1].device, latest); assert.equal(session.status().pending, true);
  decodes[1].resolve(readings(11)); await pending;
  assert.equal(session.status().profile.counter, 11); assert.equal(session.status().pending, false);
  assert.deepEqual(history.samples(latest).map(sample => sample.at), [1000, 7000]);
  await session.observe(latest); assert.equal(decodes.length, 2);
});

test('a failed decryption still processes the latest pending observation', async () => {
  const { session, history, decodes } = delayedSession(), latest = encrypted(7000);
  await session.select(encrypted()); const pending = session.unlock(key); await session.observe(latest);
  decodes[0].reject(new Error('Invalid authentication tag')); await Promise.resolve();
  assert.equal(decodes.length, 2); assert.equal(decodes[1].device, latest);
  decodes[1].resolve(readings(11)); await pending;
  assert.equal(session.status().message, ''); assert.equal(session.status().profile.counter, 11);
  assert.deepEqual(history.samples(latest).map(sample => sample.at), [7000]);
});

test('pending observations keep decoding while history is paused', async () => {
  const { session, history, decodes } = delayedSession(), latest = encrypted(7000);
  await session.select(encrypted()); const pending = session.unlock(key); session.toggle(); await session.observe(latest);
  decodes[0].resolve(readings(10)); await Promise.resolve();
  assert.equal(decodes.length, 2); assert.equal(session.status().recording, false);
  decodes[1].resolve(readings(11)); await pending;
  assert.equal(session.status().profile.counter, 11); assert.deepEqual(history.samples(latest), []);
  assert.equal(session.status().recording, false); assert.equal(session.status().pending, false);
});

test('resuming during pending decryption records the latest observation once', async () => {
  const { session, history, decodes } = delayedSession(), latest = encrypted(7000);
  await session.select(encrypted()); const pending = session.unlock(key); session.toggle(); await session.observe(latest);
  decodes[0].resolve(readings(10)); await Promise.resolve();
  assert.equal(decodes.length, 2); assert.deepEqual(history.samples(latest), []);
  session.toggle(); decodes[1].resolve(readings(11)); await Promise.resolve();
  assert.equal(decodes.length, 3); decodes[2].resolve(readings(11)); await pending;
  assert.equal(session.status().recording, true); assert.equal(session.status().pending, false);
  assert.deepEqual(history.samples(latest).map(sample => sample.at), [7000]);
});

test('old completions preserve a replacement device and its pending decryption', async t => {
  for (const target of [encrypted(7000, { address: '02:00:00:00:00:01' }), encrypted(7000, { addressType: 1 })]) {
    for (const rejected of [false, true]) await t.test(`${target.address}/${target.addressType}/${rejected}`, async () => {
      const { session, history, decodes } = delayedSession();
      await session.select(encrypted()); const old = session.unlock(key); await session.observe(encrypted(2000));
      await session.select(target); const current = session.unlock(key);
      if (rejected) decodes[0].reject(new Error('Old authentication failed')); else decodes[0].resolve(readings(10));
      await old;
      assert.equal(session.status().device, target); assert.equal(session.status().pending, true);
      assert.equal(session.status().hasKey, true); assert.equal(session.status().message, '');
      assert.equal(session.status().profile.authenticated, undefined); assert.deepEqual(history.samples(encrypted()), []);
      assert.equal(decodes.length, 2); decodes[1].resolve(readings(1)); await current;
      assert.equal(session.status().profile.counter, 1); assert.equal(session.status().pending, false);
      assert.deepEqual(history.samples(target).map(sample => sample.at), [7000]); assert.deepEqual(history.samples(encrypted()), []);
    });
  }
});

test('locking cancels pending decryption and its queued observation', async () => {
  const { session, history, decodes } = delayedSession();
  await session.select(encrypted()); const pending = session.unlock(key); await session.observe(encrypted(7000));
  session.lock(); decodes[0].resolve(readings(10)); await pending;
  assert.equal(session.status().hasKey, false); assert.equal(session.status().pending, false);
  assert.equal(session.status().profile.authenticated, undefined); assert.equal(decodes.length, 1);
  assert.deepEqual(history.samples(encrypted()), []);
});

test('address case preserves the key and replay checks while address types keep separate histories', async () => {
  const history = sensorHistory.create({ storage: null, now: () => 1e7 }), counters = [10, 9, 11, 1];
  const session = create(history, { decode: async () => readings(counters.shift()) });
  const upper = encrypted(7000, { address: encrypted().address.toUpperCase() });
  await session.select(encrypted()); await session.unlock(key); await session.observe(upper);
  assert.equal(session.status().device, upper); assert.equal(session.status().hasKey, true); assert.match(session.status().message, /counter/);
  await session.select({ ...upper, lastSeenMs: 13000 });
  assert.equal(session.status().hasKey, true); assert.equal(session.status().profile.counter, 11);
  const otherType = { ...upper, addressType: 1, lastSeenMs: 19000 };
  await session.observe(otherType); assert.equal(session.status().device.lastSeenMs, 13000);
  await session.select(otherType); assert.equal(session.status().hasKey, false); await session.unlock(key);
  assert.equal(session.status().profile.counter, 1);
  assert.deepEqual(history.samples(upper).map(sample => sample.at), [1000, 13000]);
  assert.deepEqual(history.samples(otherType).map(sample => sample.at), [19000]);
});
