'use strict';

const NanoDexcomStorage = (() => {
  const PREFIX = 'gattelier.dexcom.v1.';
  function create(options = {}) {
    const storage = options.storage || globalThis.localStorage;
    const origin = options.origin || (() => globalThis.NanoAPI?.origin() || '');
    const now = options.now || Date.now;
    function scope(device, kind) {
      const board = origin(), address = String(device?.address || '').toLowerCase();
      if (!board || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(address) || !Number.isInteger(device.addressType)) return null;
      return `${PREFIX}${kind}.${encodeURIComponent(board)}.${address}.${device.addressType}`;
    }
    function read(device, kind) {
      const key = scope(device, kind);
      try { return key ? JSON.parse(storage?.getItem(key) || 'null') : null; } catch { return null; }
    }
    function remove(device, kind) {
      const key = scope(device, kind);
      if (key) storage?.removeItem(key);
    }
    function write(device, kind, value) {
      const key = scope(device, kind);
      if (!key || !storage) throw new Error('Browser storage is unavailable for this board and sensor.');
      storage.setItem(key, JSON.stringify(value));
    }
    function loadSession(device) {
      const value = read(device, 'session');
      return value?.version === 1 && typeof value.key === 'string' && /^[0-9a-f]{32}$/i.test(value.key) ? { key: value.key } : null;
    }
    function saveSession(device, session) {
      if (!/^[0-9a-f]{32}$/i.test(session?.key || '')) throw new Error('Invalid G7 session key.');
      write(device, 'session', { version: 1, key: session.key.toLowerCase(), savedAt: now() });
    }
    function saveReadings(device, snapshot) {
      const records = (snapshot.records || []).slice(-5000).map(item => ({
        clock: item.clock, timestamp: item.timestamp, glucoseMgDl: item.glucoseMgDl, glucoseRaw: item.glucoseRaw,
        state: item.state, stateLabel: item.stateLabel, source: item.source, trendMgDlMinute: item.trendMgDlMinute
      }));
      write(device, 'readings', { version: 1, savedAt: now(), records, latest: snapshot.latest, identity: snapshot.identity, estimatedStart: snapshot.estimatedStart });
    }
    function loadReadings(device) {
      const value = read(device, 'readings');
      if (value?.version !== 1 || !Array.isArray(value.records)) return null;
      return { ...value, records: value.records.slice(-5000) };
    }
    return { loadSession, saveSession, hasSession: device => Boolean(loadSession(device)), forgetSession: device => remove(device, 'session'),
      saveReadings, loadReadings, clearReadings: device => remove(device, 'readings') };
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcomStorage;
