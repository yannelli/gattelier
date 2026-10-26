import test from 'node:test';
import assert from 'node:assert/strict';
import sensorSession from '../web/sensor-session.js';
const { create } = sensorSession;
const key = '231d39c1d7cc1ab1aee224cd096db932';
const encrypted = (at = 1000, extra = {}) => ({ address: '54:48:e6:8f:80:a5', addressType: 0, lastSeenMs: at, serviceData: [{ uuid: '0xfcd2', hex: '41e445f3c9962b332211006c7c4519' }], ...extra });
const readings = counter => ({ protocol: 'bthome', authenticated: true, counter, fields: [{ label: 'Temperature', value: '25.06 °C', numericValue: 25.06, unit: '°C' }] });

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
