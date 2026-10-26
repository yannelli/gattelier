import test from 'node:test';
import assert from 'node:assert/strict';
import catalogsAPI from '../web/catalogs.js';
import metadata from '../web/metadata.js';
import profiles from '../web/profiles.js';
import gatt from '../web/gatt-values.js';
import modules from '../web/modules.js';
import query from '../web/scan-query.js';
import { fixture } from './catalog-fixtures.mjs';

test('downloaded data feeds UUID lookup, appearance, AD names, profiles and discovery search', async () => {
  const store = catalogsAPI.create(fixture()); await store.init(); await store.refresh();
  const original = Object.fromEntries(['lookupUUID', 'appearance', 'adType', 'match'].map(key => [key, catalogsAPI[key]]));
  Object.assign(catalogsAPI, Object.fromEntries(Object.keys(original).map(key => [key, store[key]])));
  try {
    assert.match(metadata.lookup('fe95').name, /xiaomi/i);
    assert.equal(metadata.lookup('fb005c80-02e7-f387-1cad-8acd2d8df0c8').name, 'Polar Measurement Data Service');
    assert.match(metadata.lookup('6e400003-b5a3-f393-e0a9-e50e24dcca9e').name, /UART/i);
    assert.equal(metadata.lookup('8e400001-f315-4f60-9fb8-838830daea50'), null);
    const appearance = store.search('Keyboard', 'appearance').rows[0], bytes = Buffer.alloc(2); bytes.writeUInt16LE(appearance.code);
    assert.match(gatt.decode('2a01', bytes.toString('hex'))[0].value, /keyboard/i);
    assert.match(profiles.advertisement('021b00').fields[0].label, /LE Bluetooth Device Address/i);
    assert.match(profiles.advertisement('0310aabb').fields[0].label, /Device ID.*Security Manager/);
    const device = { address: '00:00:00:00:00:01', services: ['6ba1b218-15a8-461f-9fa8-5dcae273eafd'] };
    assert.equal(profiles.identify(device).title, 'Meshtastic BLE client protocol'); assert.deepEqual(modules.matches(device), []);
    const fitness = { services: ['1826'] }; assert.ok(profiles.identify(fitness).external); assert.deepEqual(modules.matches(fitness), []);
    const context = { profile: profiles.identify, lookupUUID: metadata.lookup, protocolMatches: store.match };
    assert.equal(query.select([device], { query: 'Meshtastic' }, context).length, 1);
    assert.equal(query.select([{ services: ['fe95'] }], { query: 'Xiaomi' }, context).length, 1);
    await store.enable('protocol-signatures', false); assert.equal(profiles.identify(device).category, 'other');
  } finally { Object.assign(catalogsAPI, original); }
});
