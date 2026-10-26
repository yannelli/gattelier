import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const catalog = require('../web/pairing-catalog.js');

test('catalog preserves six-digit BLE passkeys and four-digit Classic PINs', () => {
  assert.equal(catalog.search('SmartShunt')[0].pin, '000000');
  assert.equal(catalog.search('RN4871')[0].pin, '000000');
  assert.equal(catalog.search('WH-1000XM4')[0].pin, '0000');
  assert.equal(catalog.search('EZ-Link')[0].pin, '1234');
  for (const entry of catalog.search('', 'ble')) assert.match(entry.pin, /^\d{6}$/);
});

test('manual search is case-insensitive, model-aware and transport-filtered', () => {
  assert.equal(catalog.search('victron bmv712', 'ble')[0].id, 'victron-bmv712');
  assert.equal(catalog.search('TEXAS simpleble', 'ble')[0].id, 'ti-cc2540-sample');
  assert.equal(catalog.search('WH1000XM4', 'classic')[0].id, 'sony-wh1000xm4');
  assert.deepEqual(catalog.search('Sony', 'ble'), []);
  assert.deepEqual(catalog.search('', 'unknown'), []);
  assert.deepEqual(catalog.search('PLAUD'), []);
  assert.deepEqual(catalog.search('f4:4e:fc'), []);
});

test('every entry has a scoped model, qualification and primary source', () => {
  const hosts = new Set(['www.victronenergy.com', 'ww1.microchip.com', 'www.ti.com', 'learn.adafruit.com', 'helpguide.sony.net']);
  assert.equal(new Set(catalog.entries.map(entry => entry.id)).size, catalog.entries.length);
  for (const entry of catalog.entries) {
    assert.ok(entry.manufacturer && entry.model && entry.condition && entry.sourceTitle);
    const url = new URL(entry.sourceUrl);
    assert.equal(url.protocol, 'https:');
    assert.ok(hosts.has(url.hostname));
    assert.equal(typeof entry.configurable, 'boolean');
  }
  assert.match(catalog.search('SmartShunt')[0].condition, /unique PIN/);
  assert.match(catalog.search('CC2540')[0].condition, /sample firmware/);
});

test('reference data cannot be changed through a search result', () => {
  const entry = catalog.search('RN4870')[0];
  assert.throws(() => { entry.pin = '123456'; }, TypeError);
  assert.throws(() => catalog.entries.push({}), TypeError);
  const result = catalog.search(); result.length = 0;
  assert.equal(catalog.search().length, 7);
});
