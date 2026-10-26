import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { stationPayload, hotspotPayload } = createRequire(import.meta.url)('../web/network-ui.js');

test('blank Wi-Fi password omits the field to retain the same SSID credentials', () => {
  const payload = stationPayload({ configuredSSID: 'Saved network', passwordSet: true }, 'Saved network', '');
  assert.deepEqual(payload, { ssid: 'Saved network' });
  assert.equal(Object.hasOwn(payload, 'password'), false);
});

test('changing the saved Wi-Fi SSID requires an explicit password', () => {
  assert.throws(() => stationPayload({ configuredSSID: 'Saved' }, 'Changed', ''), /password when changing/);
  assert.throws(() => stationPayload({}, 'First network', ''), /password when changing/);
  assert.deepEqual(stationPayload({ configuredSSID: 'Saved' }, 'Changed', 'test-passphrase'), { ssid: 'Changed', password: 'test-passphrase' });
});

test('SSID validation counts UTF-8 bytes and preserves valid whitespace', () => {
  assert.deepEqual(hotspotPayload({}, 'é'.repeat(16), ''), { apSsid: 'é'.repeat(16) });
  assert.throws(() => hotspotPayload({}, 'é'.repeat(17), ''), /32 UTF-8/);
  assert.throws(() => stationPayload({}, '', 'test-passphrase'), /32 UTF-8/);
  assert.deepEqual(hotspotPayload({}, ' Network ', ''), { apSsid: ' Network ' });
});

test('Wi-Fi passphrases enforce byte lengths and accept a 64-digit hexadecimal key', () => {
  const config = { configuredSSID: 'Saved' };
  assert.throws(() => stationPayload(config, 'Saved', 'short'), /8–63/);
  assert.throws(() => stationPayload(config, 'Saved', 'x'.repeat(64)), /8–63/);
  assert.throws(() => stationPayload(config, 'Saved', 'é'.repeat(32)), /8–63/);
  assert.equal(stationPayload(config, 'Saved', 'p'.repeat(63)).password.length, 63);
  assert.equal(stationPayload(config, 'Saved', 'A'.repeat(64)).password.length, 64);
});

test('blank hotspot password retains the key instead of requesting an open hotspot', () => {
  const payload = hotspotPayload({ apSSID: 'Old hotspot', apPasswordSet: true }, 'New hotspot', '');
  assert.deepEqual(payload, { apSsid: 'New hotspot' });
  assert.equal(Object.hasOwn(payload, 'apPassword'), false);
});

test('hotspot password changes require a valid protected-network key', () => {
  assert.throws(() => hotspotPayload({}, 'NanoScope', '1234567'), /8–63/);
  assert.throws(() => hotspotPayload({}, 'NanoScope', 'g'.repeat(64)), /8–63/);
  assert.deepEqual(hotspotPayload({}, 'NanoScope', '12345678'), { apSsid: 'NanoScope', apPassword: '12345678' });
  assert.equal(hotspotPayload({}, 'NanoScope', 'a'.repeat(64)).apPassword.length, 64);
});

test('hotspot edits omit station credentials and mode changes', () => {
  const payload = hotspotPayload({ mode: 'station', configuredSSID: 'Saved' }, 'NanoScope', 'test-passphrase');
  assert.deepEqual(Object.keys(payload), ['apSsid', 'apPassword']);
  assert.equal(Object.hasOwn(payload, 'mode'), false);
  assert.equal(Object.hasOwn(payload, 'ssid'), false);
  assert.equal(Object.hasOwn(payload, 'password'), false);
});
