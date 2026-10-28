import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { readFileSync } from 'node:fs';

function fixture(preferences = {}, state = {}) {
  const controls = new Map();
  const get = id => {
    if (!controls.has(id)) controls.set(id, { type: id.includes('favorites') ? 'checkbox' : 'select', listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } });
    return controls.get(id);
  };
  let changes = 0;
  const store = { getPreference: (key, fallback) => preferences[key] ?? fallback, setPreference: (key, value) => { preferences[key] = value; } };
  const context = vm.createContext({ document: { getElementById: get }, store, hooks: { change: () => changes++, getState: () => state },
    NanoWorkspace: { show() {} }, NanoScanQuery: require('../web/scan-query.js'), NanoProfiles: require('../web/profiles.js'),
    NanoVendors: { identify: () => ({ search: '' }) }, NanoMetadata: { lookup() {} }, NanoCatalogs: { match: () => [] } });
  vm.runInContext(readFileSync(new URL('../web/browser-ui.js', import.meta.url), 'utf8') + '\nglobalThis.ui = NanoBrowserUI.mount(store, hooks);', context);
  return { ui: context.ui, get, preferences, changes: () => changes };
}

test('past-session and all-history filters are reflected in empty-state filtering', () => {
  for (const source of ['history', 'all']) {
    const f = fixture({ source });
    assert.equal(f.ui.isFiltered(), true);
    f.get('reset-filters').listeners.click();
    assert.equal(f.ui.isFiltered(), false);
    assert.equal(f.get('filter-source').value, 'live');
    assert.equal(f.preferences.source, 'live');
    assert.equal(f.changes(), 1);
  }
});

test('sorting alone does not claim devices were filtered out', () => {
  const f = fixture({ sort: 'name' });
  assert.equal(f.ui.isFiltered(), false);
  f.get('filter-favorites').checked = true;
  f.get('filter-favorites').listeners.change();
  assert.equal(f.ui.isFiltered(), true);
});

test('category filters and search use discovered GATT evidence for the exact connected identity', () => {
  const device = { address: 'aa:bb:cc:dd:ee:01', addressType: 0, services: [] };
  const state = { ble: { ...device, connected: true }, services: [{ uuid: '180d', characteristics: [] }] };
  const f = fixture({}, state);
  f.ui.setKind('sensor');
  assert.deepEqual(f.ui.select([device], null), [device]);
  assert.deepEqual(f.ui.select([{ ...device, addressType: 1 }], null), []);
  state.ble.connected = false;
  assert.deepEqual(f.ui.select([device], null), []);
  state.ble.connected = true;
  const search = fixture({ query: 'Heart rate', source: 'all' }, state);
  assert.deepEqual(search.ui.select([device], null), [device]);
});
