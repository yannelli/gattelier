import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const theme = require('../web/theme.js');
function setup(saved = 'system', dark = false, fail = false) {
  const listeners = {}, root = { dataset: {} }, meta = {}, writes = [];
  const control = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener: (name, action) => { listeners[name] = action; } };
  const media = { matches: dark, addEventListener: (name, action) => { listeners.media = action; } };
  const storage = { getItem() { if (fail) throw Error('blocked'); return saved; }, setItem(key, value) { if (fail) throw Error('blocked'); writes.push([key, value]); } };
  const instance = theme.init({ root, meta, control, media, storage });
  return { root, meta, control, media, listeners, instance, writes };
}
test('system appearance follows operating system changes', () => {
  const s = setup('system', true);
  assert.equal(s.root.dataset.theme, 'dark');
  assert.equal(s.instance.mode(), 'system');
  assert.equal(s.control.attributes['aria-label'], 'Switch to light appearance');
  s.media.matches = false; s.listeners.media();
  assert.equal(s.root.dataset.theme, 'light');
  assert.equal(s.meta.content, '#f5f5f7');
  assert.equal(s.control.attributes['aria-label'], 'Switch to dark appearance');
  assert.deepEqual(s.writes, []);
});
test('explicit appearance overrides the operating system and persists', () => {
  const s = setup('light', true);
  assert.equal(s.root.dataset.theme, 'light');
  s.listeners.click();
  s.media.matches = false; s.listeners.media();
  assert.equal(s.root.dataset.theme, 'dark');
  assert.equal(s.instance.mode(), 'dark');
  assert.deepEqual(s.writes, [['nanoscope.appearance', 'dark']]);
  assert.equal(s.control.title, 'Switch to light appearance');
  s.listeners.click();
  assert.equal(s.instance.mode(), 'light');
});
test('invalid preferences and unavailable storage keep the toggle usable', () => {
  assert.equal(setup('invalid', false).instance.mode(), 'system');
  const s = setup('light', true, true);
  assert.equal(s.root.dataset.theme, 'dark');
  s.listeners.click();
  assert.equal(s.root.dataset.theme, 'light');
});
test('the first click toggles the resolved system theme and saves an explicit preference', () => {
  for (const dark of [true, false]) {
    const s = setup('system', dark);
    s.listeners.click();
    assert.equal(s.instance.mode(), dark ? 'light' : 'dark');
    assert.deepEqual(s.writes, [['nanoscope.appearance', dark ? 'light' : 'dark']]);
  }
});
