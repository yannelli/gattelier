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
  const records = [], flushes = [];
  const store = {
    getPreference: (key, fallback) => preferences[key] ?? fallback,
    setPreference: (key, value) => { preferences[key] = value; },
    importData(snapshot) { records.push(...snapshot.records); return { imported: snapshot.records.length, count: records.length }; },
    clearHistory() { records.length = 0; },
    async flush() { flushes.push([...records]); }
  };
  const context = vm.createContext({ document: { getElementById: get }, store, hooks: { change: () => changes++, getState: () => state },
    NanoWorkspace: { show() {} }, NanoScanQuery: require('../web/scan-query.js'), NanoProfiles: require('../web/profiles.js'),
    NanoVendors: { identify: () => ({ search: '' }) }, NanoMetadata: { lookup() {} }, NanoCatalogs: { match: () => [] } });
  vm.runInContext(readFileSync(new URL('../web/browser-ui.js', import.meta.url), 'utf8') + '\nglobalThis.ui = NanoBrowserUI.mount(store, hooks);', context);
  return { ui: context.ui, get, preferences, store, records, flushes, changes: () => changes };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const historyText = name => JSON.stringify({ schemaVersion: 1, records: [{ name }] });
const historyFile = (name, reading = Promise.resolve(historyText(name))) => ({ name, size: 1, text: () => reading });

function selectFile(f, file) {
  const input = f.get('import-history');
  input.files = file ? [file] : [];
  input.value = file?.name || '';
  return input.listeners.change({ target: input });
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

test('history import flushes records, refreshes the UI and clears the input', async () => {
  const f = fixture();
  await selectFile(f, historyFile('normal.json'));
  assert.deepEqual(f.records.map(record => record.name), ['normal.json']);
  assert.deepEqual(f.flushes.map(records => records.length), [1]);
  assert.equal(f.changes(), 1);
  assert.equal(f.get('history-import-status').textContent, 'Imported 1 devices. 1 retained.');
  assert.equal(f.get('import-history').value, '');
});

test('history import preserves size, parsing and schema errors', async () => {
  const f = fixture();
  await selectFile(f, { size: 16 * 1024 * 1024 + 1, text() { assert.fail('Oversized files must not be read'); } });
  assert.equal(f.get('history-import-status').textContent, 'History imports must be under 16 MB.');
  await selectFile(f, historyFile('invalid.json', Promise.resolve('{')));
  assert.match(f.get('history-import-status').textContent, /JSON/);
  f.store.importData = () => { throw new Error('Choose a schemaVersion 1 scan-history export containing at most 10000 records.'); };
  await selectFile(f, historyFile('schema.json', Promise.resolve('{"schemaVersion":2}')));
  assert.equal(f.get('history-import-status').textContent, 'Choose a schemaVersion 1 scan-history export containing at most 10000 records.');
  assert.deepEqual(f.records, []);
  assert.deepEqual(f.flushes, []);
  assert.equal(f.changes(), 0);
  assert.equal(f.get('import-history').value, '');
});

for (const outcome of ['resolve', 'reject']) {
  test(`new file selection revokes a previous read that later ${outcome}s`, async () => {
    const f = fixture(), reading = deferred();
    const previous = selectFile(f, historyFile('old.json', reading.promise));
    await selectFile(f, historyFile('new.json'));
    reading[outcome](outcome === 'resolve' ? historyText('old.json') : new Error('Old read failed'));
    await previous;
    assert.deepEqual(f.records.map(record => record.name), ['new.json']);
    assert.equal(f.flushes.length, 1);
    assert.equal(f.changes(), 1);
    assert.equal(f.get('history-import-status').textContent, 'Imported 1 devices. 1 retained.');
    assert.equal(f.get('import-history').value, '');
  });

  test(`new selection preserves imported records during an old flush that ${outcome}s`, async () => {
    const f = fixture(), flushing = deferred(), started = deferred(), reading = deferred();
    const flush = f.store.flush;
    f.store.flush = () => {
      const result = flush();
      if (f.flushes.length !== 1) return result;
      started.resolve(); return flushing.promise;
    };
    const previous = selectFile(f, historyFile('old.json'));
    await started.promise;
    const latest = selectFile(f, historyFile('new.json', reading.promise));
    f.get('history-import-status').textContent = '';
    flushing[outcome](outcome === 'resolve' ? undefined : new Error('Old flush failed'));
    await previous;
    assert.deepEqual(f.records.map(record => record.name), ['old.json']);
    assert.equal(f.changes(), outcome === 'resolve' ? 1 : 0);
    assert.equal(f.get('history-import-status').textContent, '');
    assert.equal(f.get('import-history').value, 'new.json');
    reading.resolve(historyText('new.json'));
    await latest;
    assert.deepEqual(f.records.map(record => record.name), ['old.json', 'new.json']);
    assert.equal(f.flushes.length, 2);
    assert.equal(f.changes(), outcome === 'resolve' ? 2 : 1);
    assert.equal(f.get('history-import-status').textContent, 'Imported 1 devices. 2 retained.');
    assert.equal(f.get('import-history').value, '');
  });

  for (const boundary of ['read', 'flush']) {
    test(`Clear History revokes a pending ${boundary} that ${outcome}s`, async () => {
      const f = fixture(), pending = deferred(), started = deferred();
      await selectFile(f, historyFile('saved.json'));
      const clear = f.store.clearHistory;
      f.store.clearHistory = () => {
        assert.equal(f.get('history-import-status').textContent, '');
        clear();
      };
      if (boundary === 'flush') {
        const flush = f.store.flush;
        f.store.flush = () => {
          const result = flush();
          if (f.flushes.length !== 2) return result;
          started.resolve(); return pending.promise;
        };
      }
      const previous = selectFile(f, historyFile('old.json', boundary === 'read' ? pending.promise : Promise.resolve(historyText('old.json'))));
      if (boundary === 'flush') await started.promise;
      const clearing = f.get('clear-history').listeners.click();
      assert.deepEqual(f.records, []);
      assert.equal(f.get('history-import-status').textContent, '');
      assert.deepEqual(f.flushes.at(-1), []);
      pending[outcome](outcome === 'resolve' ? historyText('old.json') : new Error(`Old ${boundary} failed`));
      await Promise.all([previous, clearing]);
      assert.deepEqual(f.records, []);
      assert.deepEqual(f.flushes.map(records => records.length), boundary === 'read' ? [1, 0] : [1, 2, 0]);
      assert.equal(f.changes(), boundary === 'flush' && outcome === 'resolve' ? 3 : 2);
      assert.equal(f.get('history-import-status').textContent, '');
      assert.equal(f.get('import-history').value, '');
    });
  }

  test(`empty selection revokes a pending read that ${outcome}s`, async () => {
    const f = fixture(), reading = deferred();
    f.get('history-import-status').textContent = 'Previous result';
    const previous = selectFile(f, historyFile('old.json', reading.promise));
    await selectFile(f, null);
    reading[outcome](outcome === 'resolve' ? historyText('old.json') : new Error('Old read failed'));
    await previous;
    assert.deepEqual(f.records, []);
    assert.deepEqual(f.flushes, []);
    assert.equal(f.changes(), 0);
    assert.equal(f.get('history-import-status').textContent, 'Previous result');
    assert.equal(f.get('import-history').value, '');
  });
}
