'use strict';

const NanoCredentials = (() => {
  const protocol = typeof module !== 'undefined' ? require('./plaud-protocol.js') : NanoPlaudProtocol;
  const storageKey = 'nanoscope.credentials.v1', maxBytes = 512 * 1024, maxRecords = 100;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  function address(value) {
    if (typeof value !== 'string' || value.length !== 17 || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) throw new Error('Enter the Pocket Bluetooth address shown in Discover.');
    return value.toLowerCase();
  }
  function plaud(value) {
    if (!plain(value) || size(value) > 32768) throw new Error('Invalid PLAUD credential record.');
    for (const key of Object.keys(value)) if (!['serial', 'userId', 'privateKeyPem', 'publicKeyPem', 'signature'].includes(key)) throw new Error(`Unexpected PLAUD credential field: ${key}`);
    const parsed = protocol.credentials(value);
    if (parsed.serial.length !== 16) throw new Error('Serial must contain 16 hexadecimal characters');
    return { serial: parsed.serial, userId: parsed.userId, privateKeyPem: parsed.privateKeyPem, publicKeyPem: parsed.publicKeyPem, signature: value.signature };
  }
  function pocket(value) {
    if (typeof value !== 'string' || value.length !== 16 || !/^[A-Za-z0-9]{16}$/.test(value)) throw new Error('Pocket keys must contain 16 letters or digits.');
    return value;
  }
  function validate(input) {
    if (!plain(input) || input.format !== 'nanoscope-credentials' || input.schemaVersion !== 1 || !Array.isArray(input.records) || input.records.length > maxRecords || size(input) > maxBytes) throw new Error('Choose a Gattelier credentials backup, version 1, under 512 KiB.');
    for (const key of Object.keys(input)) if (!['format', 'schemaVersion', 'exportedAt', 'records'].includes(key)) throw new Error(`Unexpected credential backup field: ${key}`);
    if (Object.hasOwn(input, 'exportedAt') && (!Number.isSafeInteger(input.exportedAt) || input.exportedAt < 0)) throw new Error('Invalid credential backup date.');
    const records = [], keys = new Set();
    for (const item of input.records) {
      if (!plain(item) || !['plaud', 'pocket'].includes(item.kind) || typeof item.id !== 'string' || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) throw new Error('Invalid credential backup record.');
      for (const key of Object.keys(item)) if (!['kind', 'id', 'credentials', 'updatedAt'].includes(key)) throw new Error(`Unexpected credential record field: ${key}`);
      const credentials = item.kind === 'plaud' ? plaud(item.credentials) : pocket(item.credentials);
      const id = item.kind === 'plaud' ? credentials.serial : address(item.id);
      if (item.id.toLowerCase() !== id) throw new Error('Credential identity does not match its record.');
      const key = `${item.kind}/${id}`;
      if (keys.has(key)) throw new Error('Duplicate credential identities in the backup.');
      keys.add(key); records.push({ kind: item.kind, id, credentials, updatedAt: item.updatedAt });
    }
    return records;
  }
  function create(options = {}) {
    let records = new Map(), storage, initialized = false, error = '', persistent = false;
    const clock = options.now || Date.now;
    const changed = () => {
      options.onChange?.();
      if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('nanoscope:credentials-changed'));
    };
    const exportData = () => { init(); return { format: 'nanoscope-credentials', schemaVersion: 1, exportedAt: clock(), records: clone([...records.values()]) }; };
    function persist(next) {
      const data = { format: 'nanoscope-credentials', schemaVersion: 1, records: [...next.values()] };
      validate(data);
      records = next;
      try {
        if (!storage) throw new Error('Browser storage is unavailable.');
        storage.setItem(storageKey, JSON.stringify(data)); persistent = true; error = '';
      } catch { persistent = false; error = 'Credentials are in memory only because browser storage could not save them. Export a backup before closing this page.'; }
      changed(); return { persistent, error };
    }
    function init() {
      if (initialized) return;
      initialized = true;
      try {
        storage = options.storage === undefined ? localStorage : options.storage;
        if (!storage) throw new Error('Storage unavailable');
        const saved = storage.getItem(storageKey);
        if (saved && new TextEncoder().encode(saved).byteLength > maxBytes) throw new Error('Saved credentials exceed the storage limit.');
        if (saved) records = new Map(validate(JSON.parse(saved)).map(item => [`${item.kind}/${item.id}`, item]));
        persistent = true;
      } catch { error = 'Saved credentials could not be loaded. Import a backup or load credentials again.'; persistent = false; }
    }
    function save(kind, id, credentials) {
      init(); const next = new Map(records);
      next.set(`${kind}/${id}`, { kind, id, credentials, updatedAt: clock() }); return persist(next);
    }
    function importData(input) {
      init(); const incoming = validate(input), next = new Map(records);
      for (const record of incoming) next.set(`${record.kind}/${record.id}`, { ...record, updatedAt: Math.min(clock(), record.updatedAt) });
      const result = persist(next); return { ...result, imported: incoming.length, count: next.size };
    }
    return {
      init, exportData, importData,
      status() { init(); return { count: records.size, persistent, error }; },
      list() { init(); return [...records.values()].map(({ kind, id, updatedAt }) => ({ kind, id, updatedAt })); },
      getPlaud(serial) { init(); return clone(records.get(`plaud/${String(serial).toLowerCase()}`)?.credentials || null); },
      getPocket(mac) { init(); return records.get(`pocket/${String(mac).toLowerCase()}`)?.credentials || null; },
      savePlaud(value) { const credentials = plaud(value); return save('plaud', credentials.serial, credentials); },
      savePocket(mac, key) { return save('pocket', address(mac), pocket(key)); },
      remove(kind, id) { init(); const next = new Map(records); next.delete(`${kind}/${String(id).toLowerCase()}`); return persist(next); }
    };
  }
  const store = create();
  return { ...store, create, validate, maxBytes };
})();
if (typeof module !== 'undefined') module.exports = NanoCredentials;
