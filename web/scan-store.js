'use strict';

const NanoScanStore = (() => {
  const preferenceKeys = new Set(['backgroundScan', 'query', 'sort', 'signal', 'lastSeen', 'kind', 'connectable', 'favorites', 'source', 'persistent', 'view', 'recorderTab', 'workbenchTab', 'selectedDevice']);
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const text = value => typeof value === 'string' ? value : '';
  const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  function advertisement(value) {
    const address = text(value.address).toLowerCase(), addressType = Number.isInteger(value.addressType) ? value.addressType : 0;
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(address)) return null;
    return { key: `${address}/${addressType}`, address, addressType, name: text(value.name), rssi: number(value.rssi, -127),
      connectable: value.connectable === true, services: Array.isArray(value.services) ? value.services.filter(item => typeof item === 'string') : [],
      manufacturer: text(value.manufacturer), payloadHex: text(value.payloadHex),
      serviceData: Array.isArray(value.serviceData) ? value.serviceData.map(item => ({ uuid: text(item?.uuid), hex: text(item?.hex) })) : [],
      advType: number(value.advType), txPower: Number.isFinite(value.txPower) ? value.txPower : null, remembered: value.remembered === true };
  }
  function savedRecord(value) {
    const record = advertisement(value);
    if (!record) return null;
    const history = Array.isArray(value.history) ? value.history.filter(item => Number.isFinite(item?.at) && Number.isFinite(item?.rssi)) : [];
    const unique = new Map(history.map(item => [item.at, { at: item.at, rssi: item.rssi }]));
    return { ...record, firstSeenMs: number(value.firstSeenMs), lastSeenMs: number(value.lastSeenMs),
      observations: Math.max(0, Math.floor(number(value.observations))), history: [...unique.values()].sort((a, b) => a.at - b.at).slice(-60),
      favorite: value.favorite === true, label: text(value.label).slice(0, 160),
      boardSeenSeconds: number(value.boardSeenSeconds, -1), boardStartedMs: number(value.boardStartedMs, -1) };
  }
  const plainObject = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  function importRecord(value, time) {
    const reject = field => { throw new Error(`Invalid imported device ${field}.`); };
    if (!plainObject(value)) reject('record');
    if (typeof value.address !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value.address)) reject('address');
    if (!Number.isInteger(value.addressType) || value.addressType < 0 || value.addressType > 3) reject('address type');
    for (const [key, limit] of [['key', 64], ['name', 80], ['label', 160]]) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > limit)) reject(key);
    }
    const validHex = (hex, max) => typeof hex === 'string' && hex.length <= max * 2 && /^(?:[0-9a-f]{2})*$/i.test(hex);
    const validUUID = uuid => typeof uuid === 'string' && /^(?:0x)?(?:[0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(uuid);
    for (const [key, max] of [['manufacturer', 512], ['payloadHex', 1650]]) if (value[key] !== undefined && !validHex(value[key], max)) reject(key);
    for (const key of ['connectable', 'favorite', 'remembered']) if (value[key] !== undefined && typeof value[key] !== 'boolean') reject(key);
    for (const key of ['rssi', 'txPower']) {
      if (value[key] !== undefined && !(key === 'txPower' && value[key] === null) && (!Number.isFinite(value[key]) || value[key] < -127 || value[key] > 127)) reject(key);
    }
    if (value.advType !== undefined && (!Number.isInteger(value.advType) || value.advType < 0 || value.advType > 255)) reject('advertisement type');
    for (const key of ['firstSeenMs', 'lastSeenMs']) if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > Number.MAX_SAFE_INTEGER) reject(key);
    if (value.observations !== undefined && (!Number.isSafeInteger(value.observations) || value.observations < 0)) reject('observation count');
    for (const key of ['boardSeenSeconds', 'boardStartedMs']) if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < -1 || value[key] > Number.MAX_SAFE_INTEGER)) reject(key);
    if (value.services !== undefined && (!Array.isArray(value.services) || value.services.length > 64 || !value.services.every(validUUID))) reject('services');
    if (value.serviceData !== undefined && (!Array.isArray(value.serviceData) || value.serviceData.length > 64 || !value.serviceData.every(item => plainObject(item) && validUUID(item.uuid) && validHex(item.hex, 512)))) reject('service data');
    if (value.history !== undefined && (!Array.isArray(value.history) || value.history.length > 60 || !value.history.every(item => plainObject(item) && Number.isFinite(item.at) && item.at >= 0 && item.at <= Number.MAX_SAFE_INTEGER && Number.isFinite(item.rssi) && item.rssi >= -127 && item.rssi <= 127))) reject('history');
    const record = savedRecord(value);
    record.lastSeenMs = Math.min(record.lastSeenMs, time);
    record.firstSeenMs = Math.min(record.firstSeenMs, record.lastSeenMs);
    record.boardStartedMs = Math.min(record.boardStartedMs, time);
    const history = new Map(record.history.map(item => [Math.min(item.at, time), { at: Math.min(item.at, time), rssi: item.rssi }]));
    record.history = [...history.values()];
    if (record.history.length) {
      record.firstSeenMs = Math.min(record.firstSeenMs, record.history[0].at);
      record.lastSeenMs = Math.max(record.lastSeenMs, record.history[record.history.length - 1].at);
    }
    record.observations = Math.max(record.observations, record.history.length);
    return record;
  }
  function indexedStorage() {
    if (!globalThis.indexedDB) return null;
    let opened;
    function open() {
      if (!opened) opened = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open('nanoscope-scan-history', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('history');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB could not open'));
        request.onblocked = () => reject(new Error('History database upgrade is blocked by another tab'));
      });
      return opened;
    }
    async function transaction(mode, operation) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('history', mode), request = operation(tx.objectStore('history'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('History database operation failed'));
      });
    }
    return { load: () => transaction('readonly', store => store.get('snapshot')),
      save: value => transaction('readwrite', store => store.put(value, 'snapshot')) };
  }
  function create({ storage, now = Date.now } = {}) {
    const records = new Map(), preferences = { backgroundScan: false, persistent: true };
    let adapter = storage, available = false, error = '', evicted = 0, revision = 0, saved = 0, timer, initPromise;
    let previousUptime = null, boardStartedMs = null, writing = Promise.resolve();
    try {
      const stored = JSON.parse(globalThis.localStorage?.getItem('nanoscope.scan.preferences') || '{}');
      for (const [key, value] of Object.entries(stored || {})) {
        if (preferenceKeys.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) preferences[key] = value;
      }
    } catch (failure) { error = `Preferences are kept in memory: ${failure.message}`; }
    function savePreferences() {
      try { globalThis.localStorage?.setItem('nanoscope.scan.preferences', JSON.stringify(preferences)); }
      catch (failure) { error = `Preferences are kept in memory: ${failure.message}`; }
    }
    function changed() {
      revision++;
      clearTimeout(timer);
      if (available) { timer = setTimeout(() => { flush(); }, 700); timer.unref?.(); }
    }
    function trim() {
      const historical = [...records.values()].filter(record => record.liveId == null);
      historical.sort((a, b) => a.lastSeenMs - b.lastSeenMs || a.key.localeCompare(b.key));
      for (const record of historical.slice(0, Math.max(0, historical.length - 10000))) {
        records.delete(record.key); evicted++;
      }
    }
    async function init() {
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          if (adapter === undefined) adapter = indexedStorage();
          if (!adapter?.load || !adapter?.save) throw new Error('IndexedDB is unavailable');
          const snapshot = await adapter.load();
          if (preferences.persistent !== false && snapshot?.schemaVersion === 1 && Array.isArray(snapshot.records)) {
            for (const value of snapshot.records) {
              const record = savedRecord(value);
              if (!record) continue;
              const current = records.get(record.key);
              if (current) {
                current.firstSeenMs = Math.min(current.firstSeenMs, record.firstSeenMs);
                current.lastSeenMs = Math.max(current.lastSeenMs, record.lastSeenMs);
                const repeated = current.boardSeenSeconds === record.boardSeenSeconds && Math.abs(current.boardStartedMs - record.boardStartedMs) < 2500;
                current.observations += record.observations - (repeated ? 1 : 0);
                current.history = savedRecord({ ...current, history: [...record.history, ...current.history] }).history;
                current.favorite = current.favorite || record.favorite;
                current.label = current.label || record.label;
              } else records.set(record.key, { ...record, liveId: null });
            }
            evicted += Math.max(0, Math.floor(number(snapshot.evicted)));
          }
          available = true; trim(); changed();
        } catch (failure) { available = false; error = `Scan history is kept in memory: ${failure.message}`; }
        return api;
      })();
      return initPromise;
    }
    function ingest(boardState, receivedAtMs = now()) {
      if (!boardState || !Array.isArray(boardState.devices)) { setOffline(); return; }
      const uptime = number(boardState.uptime), reboot = previousUptime !== null && uptime < previousUptime;
      if (boardStartedMs === null || reboot) boardStartedMs = receivedAtMs - uptime * 1000;
      previousUptime = uptime;
      for (const record of records.values()) record.liveId = null;
      let dirty = false;
      for (const value of boardState.devices) {
        const advertised = advertisement(value);
        if (!advertised) continue;
        const current = records.get(advertised.key), before = current && JSON.stringify(savedRecord(current));
        const seen = Number.isFinite(value.lastSeen) ? Math.max(0, Math.min(uptime, value.lastSeen)) : null;
        const at = seen === null ? receivedAtMs : Math.min(receivedAtMs, boardStartedMs + seen * 1000);
        const sameBoot = current && !reboot && Math.abs(current.boardStartedMs - boardStartedMs) < 2500;
        const observed = !current || (seen !== null && (!sameBoot || current.boardSeenSeconds < seen));
        const fields = sameBoot && seen !== null && current.boardSeenSeconds > seen ? advertisement(current) : advertised;
        const record = { ...fields, firstSeenMs: current?.firstSeenMs ?? at, lastSeenMs: current?.lastSeenMs ?? at,
          observations: current?.observations ?? 0, history: current?.history || [], favorite: current?.favorite || false,
          label: current?.label || '', boardSeenSeconds: current?.boardSeenSeconds ?? -1, boardStartedMs: current?.boardStartedMs ?? boardStartedMs,
          liveId: Number.isInteger(value.id) && value.id > 0 ? value.id : null };
        if (observed) {
          record.observations++;
          record.lastSeenMs = Math.max(record.lastSeenMs, at);
          record.boardSeenSeconds = seen ?? -1; record.boardStartedMs = boardStartedMs;
          if (!record.history.some(item => item.at === at)) record.history = [...record.history, { at, rssi: record.rssi }].slice(-60);
        }
        records.set(record.key, record);
        if (before !== JSON.stringify(savedRecord(record))) dirty = true;
      }
      const count = records.size; trim();
      if (dirty || count !== records.size) changed();
    }
    function devices() { return [...records.values()].map(clone); }
    function annotate(key, values) {
      const record = records.get(key);
      if (!record) return false;
      if (typeof values.label === 'string') record.label = values.label.slice(0, 160);
      if (typeof values.favorite === 'boolean') record.favorite = values.favorite;
      changed(); return true;
    }
    function getPreference(key, fallback) { return preferences[key] ?? fallback; }
    function setPreference(key, value) {
      if (!preferenceKeys.has(key) || !['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) return false;
      if (key === 'persistent') { setPersistence(value); return true; }
      preferences[key] = typeof value === 'string' ? value.slice(0, 1024) : value;
      savePreferences(); return true;
    }
    function setPersistence(enabled) {
      preferences.persistent = Boolean(enabled); savePreferences(); changed();
      return flush();
    }
    function clearHistory() { records.clear(); evicted = 0; changed(); return flush(); }
    function setOffline() {
      for (const record of records.values()) record.liveId = null;
      const count = records.size; trim(); if (count !== records.size) changed();
    }
    function exportData() { return { schemaVersion: 1, exportedAtMs: now(), evicted, records: [...records.values()].map(savedRecord) }; }
    function importData(snapshot) {
      if (!plainObject(snapshot) || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.records) || snapshot.records.length > 10000) throw new Error('Choose a schemaVersion 1 scan-history export containing at most 10000 records.');
      const time = now(), imported = snapshot.records.map(value => importRecord(value, time)), merged = new Map(records);
      for (const record of imported) {
        const current = merged.get(record.key);
        if (!current) { merged.set(record.key, { ...record, liveId: null }); continue; }
        const latest = current.liveId != null || current.lastSeenMs >= record.lastSeenMs ? current : record;
        const history = new Map([...record.history, ...current.history].map(item => [item.at, { at: item.at, rssi: item.rssi }]));
        merged.set(record.key, { ...savedRecord(latest), liveId: current.liveId ?? null,
          firstSeenMs: Math.min(current.firstSeenMs, record.firstSeenMs), lastSeenMs: Math.max(current.lastSeenMs, record.lastSeenMs),
          observations: Math.max(current.observations, record.observations, history.size),
          history: [...history.values()].sort((a, b) => a.at - b.at).slice(-60),
          label: current.label || record.label, favorite: current.favorite || record.favorite });
      }
      records.clear(); for (const [key, value] of merged) records.set(key, value);
      trim(); if (imported.length) changed();
      return { imported: new Set(imported.map(record => record.key)).size, count: records.size };
    }
    function flush() {
      clearTimeout(timer);
      writing = writing.then(async () => {
        if (!available) return false;
        while (saved < revision) {
          const version = revision, snapshot = preferences.persistent !== false ? exportData() : { schemaVersion: 1, records: [], evicted: 0 };
          try { await adapter.save(snapshot); saved = version; }
          catch (failure) { available = false; error = `Scan history is kept in memory: ${failure.message}`; return false; }
        }
        return true;
      });
      return writing;
    }
    function status() { return { persistent: preferences.persistent !== false && available, available, error, count: records.size, evicted }; }
    const api = { init, ingest, devices, annotate, getPreference, setPreference, setPersistence, clearHistory, flush, status, exportData, importData, setOffline };
    return api;
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = NanoScanStore;
