import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const library = require('../web/recipe-library.js');
const model = require('../web/recipe-model.js');
const state = (service, uuid, properties) => ({ ble: { connected: true, address: 'aa:bb:cc:dd:ee:ff' }, services: [{ uuid: service, characteristics: [{ uuid, handle: 12, properties }] }] });

test('all 25 built-in recipes validate and avoid value writes', () => {
  assert.equal(library.entries.length, 25);
  assert.equal(new Set(library.entries.map(entry => entry.id)).size, 25);
  for (const entry of library.entries) {
    const recipe = model.validate(entry.recipe);
    assert.equal(entry.readOnly, true);
    assert.ok(recipe.steps.every(step => ['read', 'subscribe', 'wait'].includes(step.action)));
    assert.ok(entry.source.title && /^https:\/\//.test(entry.source.url));
    assert.equal(recipe.address, undefined);
  }
});

test('availability uses actual characteristic properties', () => {
  const read = state('180f', '2a19', ['read']);
  assert.equal(library.availability('battery-read', read).ready, true);
  assert.equal(library.availability('battery-live', read).ready, false);
  assert.deepEqual(library.available(read).map(entry => entry.id), ['battery-read']);
  const notify = state('180f', '2a19', ['read', 'notify']);
  assert.deepEqual(library.available(notify).map(entry => entry.id), ['battery-read', 'battery-live']);
  assert.equal(library.availability('battery-read', state('180a', '2a19', ['read'])).ready, false);
});

test('thermometer capture uses indications and a bounded wait', () => {
  const entry = library.get('thermometer-measurement');
  assert.deepEqual(entry.recipe.steps.map(step => step.action), ['subscribe', 'wait']);
  assert.equal(entry.recipe.steps[0].mode, 'indicate');
  assert.equal(entry.recipe.steps[1].timeoutMs, 30000);
  assert.equal(entry.leavesSubscriptionActive, true);
  assert.equal(library.availability(entry, state('1809', '2a1c', ['notify'])).ready, false);
  assert.equal(library.availability(entry, state('1809', '2a1c', ['indicate'])).ready, true);
});

test('availability rejects disconnected, missing, malformed, and ambiguous targets', () => {
  assert.match(library.availability('battery-read').reason, /Connect/);
  assert.match(library.availability('missing').reason, /unavailable/);
  const current = state('180f', '2a19', ['read']);
  assert.match(library.availability({ recipe: { version: 9 } }, current).reason, /version/);
  current.services[0].characteristics.push({ uuid: '2a19', handle: 14, properties: ['read'] });
  const result = library.availability('battery-read', current);
  assert.equal(result.ready, false);
  assert.match(result.reason, /ambiguous/);
});

test('a source recipe can be edited without changing the built-in library', () => {
  const copy = library.get('battery-read');
  copy.recipe.steps[0].uuid = '2a00';
  assert.equal(library.get('battery-read').recipe.steps[0].uuid, '2a19');
  assert.ok(Object.isFrozen(library.entries[0].recipe.steps));
  assert.equal(library.get('missing'), null);
});
