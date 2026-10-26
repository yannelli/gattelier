import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const library = require('../web/device-library.js');
const recipes = require('../web/recipe-library.js');
const address = 'aa:bb:cc:dd:ee:ff';
const connected = services => ({ ble: { connected: true, address }, services });

test('catalog includes the requested device families and actionable source links', () => {
  assert.deepEqual(library.entries.map(entry => entry.id), ['sleep-fuzion', 'sleep-mcr', 'health-thermometer', 'environmental-sensor', 'nuki-lock', 'resmed-air11', 'ge-appliance', 'samsung-tv', 'radiacode']);
  for (const entry of library.entries) {
    assert.ok(entry.authentication && entry.limitations && entry.capabilities.length);
    assert.ok(entry.sources.every(source => source.title && /^https:\/\//.test(source.url)));
    assert.ok(entry.capabilities.every(capability => capability.kind === 'read'));
    assert.ok(entry.recipes.every(id => recipes.get(id)), entry.id);
  }
});

test('Sleep Number service matching keeps Fuzion and MCR transport requirements separate', () => {
  const fuzion = library.match({ services: ['09D23FAE-90E6-44C2-95B6-0B3D0F1ABF25'] });
  assert.deepEqual(fuzion.map(entry => entry.id), ['sleep-fuzion']);
  assert.equal(fuzion[0].confidence, 'Service match');
  assert.equal(fuzion[0].modelConfirmed, false);
  const mcr = library.match({ services: ['ffffd1fd-388d-938b-344a-939d1f6efee0'] })[0];
  assert.equal(mcr.id, 'sleep-mcr');
  assert.match(mcr.authentication, /64-bit/);
  assert.equal(mcr.capabilities.find(capability => capability.id === 'mcr-status').status, 'implemented');
  assert.equal(mcr.capabilities.find(capability => capability.id === 'foundation-status').status, 'adapter-required');
});

test('standard services match short and full UUIDs without inferring a product model', () => {
  const matches = library.match({ services: ['0x1809', '0000181a-0000-1000-8000-00805f9b34fb'] });
  assert.deepEqual(matches.map(entry => entry.id), ['health-thermometer', 'environmental-sensor']);
  assert.ok(matches.every(entry => entry.confirmed && !entry.modelConfirmed));
});

test('ResMed and appliance names remain candidates and manufacturer IDs do not identify models', () => {
  for (const [name, id] of [['ResMed12345', 'resmed-air11'], ['GE Washer', 'ge-appliance'], ['[TV] Samsung 7 Series', 'samsung-tv']]) {
    const match = library.match({ name })[0];
    assert.equal(match.id, id);
    assert.equal(match.confidence, 'Name candidate');
    assert.equal(match.confirmed, false);
  }
  assert.deepEqual(library.match({ name: 'Samsung headphones', manufacturer: '750001' }), []);
  assert.deepEqual(library.match({ name: 'Someone named a thing ResMed', manufacturer: '750001' }), []);
});

test('RadiaCode requires its documented characteristic pair on this connection', () => {
  const entry = library.get('radiacode');
  const service = { uuid: 'private-service', characteristics: entry.characteristics.map(uuid => ({ uuid })) };
  const match = library.match({ address }, connected([service]))[0];
  assert.equal(match.id, 'radiacode');
  assert.equal(match.confidence, 'GATT signature');
  assert.deepEqual(library.match({ address: '11:22:33:44:55:66' }, connected([service])), []);
  assert.deepEqual(library.match({ address }, { ble: { connected: false, address }, services: [service] }), []);
  assert.deepEqual(library.match({ address }, connected([{ ...service, characteristics: service.characteristics.slice(0, 1) }])), []);
});

test('Nuki service matches expose authentication requirements without control recipes', () => {
  for (const service of library.get('nuki-lock').services) {
    const match = library.match({ services: [service] })[0];
    assert.equal(match.id, 'nuki-lock');
    assert.match(match.authentication, /authorized client/);
    assert.ok(match.recipes.every(id => recipes.get(id).recipe.steps.every(step => step.action !== 'write')));
  }
});

test('library objects are isolated from consumers', () => {
  const entry = library.get('sleep-fuzion');
  entry.capabilities[0].label = 'changed';
  assert.notEqual(library.get(entry.id).capabilities[0].label, 'changed');
  assert.ok(Object.isFrozen(library.entries[0].capabilities[0]));
  assert.equal(library.get('missing'), null);
});
