import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const library = require('../web/device-library.js');
const recipes = require('../web/recipe-library.js');
const address = 'aa:bb:cc:dd:ee:ff';
const connected = services => ({ ble: { connected: true, address }, services });

test('catalog includes the requested device families and actionable source links', () => {
  assert.deepEqual(library.entries.map(entry => entry.id), ['sleep-fuzion', 'sleep-mcr', 'health-thermometer', 'environmental-sensor', 'nuki-lock', 'resmed-air11', 'ge-appliance', 'samsung-tv', 'samsung-device', 'radiacode']);
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
  assert.deepEqual(library.match({ name: 'Samsung headphones', manufacturer: '750001' }).map(entry => entry.id), ['samsung-device']);
  assert.equal(library.match({ name: 'Someone named a thing ResMed', manufacturer: '750001' }).some(entry => entry.id === 'resmed-air11'), false);
});

test('anonymous Samsung company data and assigned services match without a TV claim', () => {
  const entry = library.match({ manufacturer: '750042040000' })[0];
  assert.equal(entry.id, 'samsung-device'); assert.equal(entry.confidence, 'Manufacturer match');
  assert.equal(entry.modelConfirmed, false); assert.equal(entry.confirmed, false);
  for (const manufacturer of ['75', '0075', '7500zz', '750']) assert.deepEqual(library.match({ manufacturer }), []);
  for (const service of library.get('samsung-device').services) {
    const match = library.match({ services: [`0000${service}-0000-1000-8000-00805f9b34fb`] });
    assert.deepEqual(match.map(item => item.id), ['samsung-device']); assert.equal(match[0].confidence, 'Service match'); assert.equal(match[0].modelConfirmed, false);
  }
  const named = library.match({ name: 'Samsung synthetic speaker' });
  assert.equal(named[0].confidence, 'Name candidate'); assert.equal(named[0].confirmed, false);
  assert.equal(library.match({ name: '[TV] Samsung Synthetic' }).some(item => item.id === 'samsung-tv'), true);
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

test('connected GATT matching and commands require the selected address type', () => {
  const target = { address, addressType: 0 };
  const state = { ble: { connected: true, address: address.toUpperCase(), addressType: 1 }, services: [{ uuid: '181a', characteristics: [{ uuid: '2a6e', handle: 4, properties: ['read'] }] }] };
  assert.deepEqual(library.match(target, state), []);
  assert.deepEqual(library.suggestions(target, state), []);
  assert.equal(library.connected(target, state), false);
  state.ble.addressType = 0;
  assert.equal(library.match(target, state)[0].id, 'environmental-sensor');
  assert.equal(library.suggestions(target, state)[0].recipeId, 'environment-temperature');
});

test('suggested commands resolve real handles and properties without vendor writes', () => {
  const target = { address, addressType: 0 }, state = { ble: { ...target, connected: true }, services: [
    { uuid: '180f', characteristics: [{ uuid: '2a19', handle: 3, properties: ['read', 'notify'] }] },
    { uuid: 'f0000000-0000-4000-8000-000000000000', characteristics: [{ uuid: 'f0000001-0000-4000-8000-000000000000', handle: 5, properties: ['write'] }, { uuid: 'f0000002-0000-4000-8000-000000000000', handle: 8, properties: ['indicate'], subscription: 'off' }] }
  ] };
  const actions = library.suggestions(target, state);
  assert.deepEqual(actions.map(({ handle, action, mode }) => [handle, action, mode]), [[3, 'read', undefined], [3, 'subscribe', 'notify'], [8, 'subscribe', 'indicate']]);
  assert.equal(actions[0].label, 'Read battery level');
  assert.equal(actions[0].recipeId, 'battery-read');
  state.services[0].characteristics[0].subscription = 'notify';
  assert.equal(library.suggestions(target, state).filter(item => item.handle === 3).length, 1);
  state.services[0].characteristics[0].properties = [];
  assert.equal(library.suggestions(target, state).some(item => item.handle === 3), false);
});

test('vendor transport names retain source links and service scope', () => {
  const service = library.get('sleep-mcr').services[0], characteristic = library.get('sleep-mcr').characteristics[1];
  assert.equal(library.lookup(characteristic, service).name, 'Sleep Number MCR commands');
  assert.match(library.lookup(characteristic, service).source, /sleep_number_mcr/);
  assert.equal(library.lookup(characteristic, '180a'), null);
  assert.equal(library.lookup('arbitrary-vendor-uuid'), null);
});
