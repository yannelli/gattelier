'use strict';

const NanoCatalogs = (() => {
  const schema = typeof module !== 'undefined' ? require('./catalog-schema.js') : NanoCatalogSchema;
  const matcher = typeof module !== 'undefined' ? require('./catalog-match.js') : NanoCatalogMatch;
  const DEFAULT_ORIGIN = 'https://gattelier.ryanyannelli.com';
  function indexedStorage() {
    if (!globalThis.indexedDB) return null;
    let opened;
    function open() {
      return opened ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('gattelier-protocol-libraries', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('libraries');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Another tab is blocking library storage.'));
      });
    }
    async function run(mode, action) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('libraries', mode), request = action(transaction.objectStore('libraries'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error || request.error || new Error('Library storage failed.'));
      });
    }
    return { load: () => run('readonly', store => store.get('snapshot')), save: value => run('readwrite', store => store.put(value, 'snapshot')) };
  }
  function origin(value) {
    const target = new URL(value);
    if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Use an HTTPS library origin without a path.');
    return target.origin;
  }
  function create({ storage, fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
    let adapter = storage, catalogs = [], definitions = [], source = DEFAULT_ORIGIN, updatedAt = null, persistent = false, error = '', busy = false, autoUpdate = true;
    let initialized, generation = 0, controller, writes = Promise.resolve(), uuids = new Map(), appearances = new Map(), adTypes = new Map(), protocols = [], rows = [];
    const changed = () => globalThis.dispatchEvent?.(new CustomEvent('nanoscope:catalogs'));
    function rebuild() {
      uuids = new Map(); appearances = new Map(); adTypes = new Map(); protocols = []; rows = [];
      for (const { catalog, enabled } of catalogs) if (enabled) for (const entry of catalog.entries) {
        const decorated = { ...entry, library: catalog.id, revision: catalog.revision };
        if (catalog.kind === 'uuid') uuids.set(entry.uuid, decorated);
        if (catalog.kind === 'appearance') appearances.set(entry.code, decorated);
        if (catalog.kind === 'ad-type') adTypes.set(entry.code, [...(adTypes.get(entry.code) || []), decorated]);
        if (catalog.kind === 'protocol') protocols.push(decorated);
        rows.push({ ...decorated, libraryTitle: catalog.title, type: catalog.kind });
      }
      changed();
    }
    async function persist() {
      if (adapter === undefined) adapter = indexedStorage();
      const value = { schema: 1, origin: source, updatedAt, autoUpdate, catalogs };
      writes = writes.catch(() => {}).then(async () => {
        try { if (!adapter) throw new Error('IndexedDB is unavailable.'); await adapter.save(value); persistent = true; }
        catch (failure) { persistent = false; error = `Libraries are available for this tab only: ${failure.message}`; }
      });
      await writes; changed();
    }
    async function download(path, signal, limit) {
      const response = await fetcher(path, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal });
      if (!response.ok) throw new Error(`Library download failed (${response.status}).`);
      const reader = response.body?.getReader(); let raw = '', size = 0;
      if (reader) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) throw new Error('Library exceeds its download limit.'); raw += decoder.decode(part.value, { stream: true }); } raw += decoder.decode(); }
        catch (failure) { await reader.cancel().catch(() => {}); throw failure; }
      } else { raw = await response.text(); size = new TextEncoder().encode(raw).byteLength; if (size > limit) throw new Error('Library exceeds its download limit.'); }
      return { value: JSON.parse(raw), size };
    }
    async function refresh(value = source) {
      const target = origin(value), token = ++generation; controller?.abort();
      const active = controller = new AbortController(), timeout = setTimeout(() => active.abort(), 20000);
      busy = true; error = ''; changed();
      try {
        const index = schema.manifest((await download(`${target}/catalogs/index.json`, active.signal, 65536)).value);
        if (index.libraries.reduce((total, item) => total + item.bytes, 0) > 8 * 1024 * 1024) throw new Error('Library set exceeds 8 MiB.');
        const downloaded = await Promise.all(index.libraries.map(async item => {
          const response = await download(`${target}${item.path}`, active.signal, Math.min(item.bytes, 2 * 1024 * 1024)), catalog = schema.validate(response.value);
          if (response.size !== item.bytes || catalog.id !== item.id || catalog.kind !== item.kind || catalog.revision !== item.revision || catalog.entries.length !== item.count) throw new Error('Library version changed during download. Try again.');
          return catalog;
        }));
        if (token !== generation) return;
        catalogs = downloaded.map(catalog => ({ catalog, enabled: catalogs.find(record => record.catalog.id === catalog.id)?.enabled !== false })); definitions = index.libraries; source = target; updatedAt = now(); autoUpdate = true; rebuild(); await persist();
      } catch (failure) {
        active.abort();
        if (token !== generation) return;
        error = failure.name === 'AbortError' ? 'Library download timed out. Existing libraries remain available.' : `${failure.message} Existing libraries remain available.`;
        throw new Error(error);
      } finally { clearTimeout(timeout); if (token === generation) { busy = false; controller = null; changed(); } }
    }
    async function init({ hosted = false } = {}) {
      if (initialized) return initialized;
      const token = generation;
      initialized = (async () => {
        try {
          if (adapter === undefined) adapter = indexedStorage();
          if (!adapter) throw new Error('IndexedDB is unavailable.');
          const saved = await adapter.load(); if (token !== generation) return;
          if (saved?.schema === 1 && Array.isArray(saved.catalogs) && saved.catalogs.length <= 16) {
            const restored = saved.catalogs.map(item => ({ catalog: schema.validate(item.catalog), enabled: item.enabled === true }));
            source = origin(saved.origin || DEFAULT_ORIGIN); catalogs = restored; autoUpdate = saved.autoUpdate !== false; updatedAt = Number.isFinite(saved.updatedAt) ? saved.updatedAt : null; rebuild();
          }
          persistent = true;
        } catch (failure) { error = `Library storage unavailable: ${failure.message}`; }
        changed();
        if (token === generation && hosted && autoUpdate && (!updatedAt || now() - updatedAt > 24 * 60 * 60 * 1000)) try { await refresh(); } catch {}
      })();
      return initialized;
    }
    function status() {
      const items = catalogs.length ? catalogs.map(({ catalog, enabled }) => ({ id: catalog.id, title: catalog.title, kind: catalog.kind, revision: catalog.revision, count: catalog.entries.length, sources: catalog.sources, enabled })) : definitions.map(item => ({ ...item, enabled: false, sources: [] }));
      return { origin: source, updatedAt, persistent, error, busy, libraries: items, count: rows.length };
    }
    function search(query = '', kind = '', limit = 40) {
      const words = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
      const results = rows.filter(row => (!kind || row.type === kind) && words.every(word => `${row.uuid || ''} ${row.code === undefined ? '' : `0x${row.code.toString(16).padStart(row.type === 'appearance' ? 4 : 2, '0')} ${row.code}`} ${row.name || row.title} ${row.description || ''} ${row.category || ''} ${row.kind || ''} ${row.libraryTitle}`.toLowerCase().includes(word)));
      return { total: results.length, rows: results.slice(0, Math.max(0, Math.min(100, limit))) };
    }
    return { init, refresh, status, search, lookupUUID: value => uuids.get(schema.uuid(value)), appearance: code => appearances.get(code), adType: code => adTypes.get(code) || [],
      match: (device, discovered) => matcher.match(protocols, device, discovered),
      async enable(id, enabled) { const item = catalogs.find(record => record.catalog.id === id); if (!item) return; item.enabled = Boolean(enabled); rebuild(); await persist(); },
      async clear() { generation++; controller?.abort(); controller = null; busy = false; catalogs = []; definitions = []; updatedAt = null; autoUpdate = false; error = ''; rebuild(); await persist(); }
    };
  }
  let instance;
  const current = () => instance ||= create();
  return { create, DEFAULT_ORIGIN, init: options => current().init(options), refresh: value => current().refresh(value), status: () => current().status(), search: (...args) => current().search(...args),
    lookupUUID: value => current().lookupUUID(value), appearance: value => current().appearance(value), adType: value => current().adType(value), match: (...args) => current().match(...args), enable: (...args) => current().enable(...args), clear: () => current().clear() };
})();
if (typeof module !== 'undefined') module.exports = NanoCatalogs;
