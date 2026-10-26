'use strict';

const NanoSensorHistory = (() => {
  const key = device => `${device.address.toLowerCase()}/${device.addressType}`;
  const clone = value => JSON.parse(JSON.stringify(value));
  function storage() {
    if (!globalThis.indexedDB) return null;
    const db = new Promise((resolve, reject) => {
      const request = indexedDB.open('gattelier-sensor-history', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('readings');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    async function transaction(mode, operation) {
      const opened = await db;
      return new Promise((resolve, reject) => {
        const tx = opened.transaction('readings', mode), request = operation(tx.objectStore('readings'));
        tx.oncomplete = () => resolve(request.result); tx.onerror = tx.onabort = () => reject(tx.error || request.error);
      });
    }
    return { load: () => transaction('readonly', store => store.get('history')), save: value => transaction('readwrite', store => store.put(value, 'history')) };
  }
  function cleanField(field) {
    if (!field || typeof field.label !== 'string' || field.label.length > 100 || !Number.isFinite(field.numericValue) || typeof field.unit !== 'string' || field.unit.length > 20) throw new Error('Invalid sensor reading.');
    return { label: field.label, value: field.numericValue, unit: field.unit };
  }
  function create(options = {}) {
    const devices = new Map(), cleared = new Set(), now = options.now || Date.now, limit = 600;
    let adapter, available = false, error = '', timer, revision = 0, saved = 0, writing = Promise.resolve();
    function snapshot(persist = false) {
      return { version: 1, devices: [...devices.values()].map(entry => ({ device: { ...entry.device }, samples: entry.samples.filter(sample => !persist || !sample.private).map(clone) })).filter(entry => entry.samples.length) };
    }
    function changed() {
      revision++;
      if (available && timer == null) { timer = setTimeout(() => { timer = null; flush(); }, 1000); timer.unref?.(); }
    }
    function trim() {
      if (devices.size <= 32) return;
      const oldest = [...devices].sort((a, b) => (a[1].samples.at(-1)?.at || 0) - (b[1].samples.at(-1)?.at || 0));
      for (const [id] of oldest.slice(0, devices.size - 32)) devices.delete(id);
    }
    function ingest(device, profile) {
      if (!device || !Number.isFinite(device.lastSeenMs) || device.lastSeenMs <= 0 || device.lastSeenMs > now() + 1000) return false;
      const fields = (profile?.fields || []).filter(field => Number.isFinite(field.numericValue)).map(cleanField);
      if (!fields.length) return false;
      const id = key(device), entry = devices.get(id) || { device: { address: device.address.toLowerCase(), addressType: device.addressType, name: String(device.name || '').slice(0, 80) }, samples: [] };
      const previous = entry.samples.at(-1), at = device.lastSeenMs;
      if (previous && (at <= previous.at || at - previous.at < 5000 && JSON.stringify(fields) === JSON.stringify(previous.fields))) return false;
      entry.samples.push({ at, fields, rssi: Number.isFinite(device.rssi) ? device.rssi : null, private: profile.authenticated === true });
      entry.samples = entry.samples.slice(-limit); entry.device.name = String(device.name || '').slice(0, 80); devices.set(id, entry); trim(); changed(); return true;
    }
    function samples(device) { return clone(devices.get(key(device))?.samples || []); }
    function series(device, label, since = 0) {
      const points = samples(device).filter(sample => sample.at >= since).flatMap(sample => {
        const field = sample.fields.find(field => field.label === label);
        return field ? [{ at: sample.at, value: field.value, unit: field.unit }] : [];
      });
      return points.filter(point => point.unit === points.at(-1).unit);
    }
    function summary(points) {
      if (!points.length) return null;
      const values = points.map(point => point.value);
      return { count: values.length, minimum: Math.min(...values), maximum: Math.max(...values), average: values.reduce((a, b) => a + b, 0) / values.length, latest: values.at(-1), unit: points.at(-1).unit };
    }
    function clear(device) { cleared.add(key(device)); devices.delete(key(device)); changed(); return flush(); }
    function exportDevice(device) { return { version: 1, device: { address: device.address, addressType: device.addressType, name: device.name || '' }, samples: samples(device) }; }
    function csv(device) {
      const quote = value => `"${String(value).replaceAll('"', '""')}"`;
      return ['Time,Measurement,Value,Unit,RSSI', ...samples(device).flatMap(sample => sample.fields.map(field => [new Date(sample.at).toISOString(), field.label, field.value, field.unit, sample.rssi ?? ''].map(quote).join(',')))].join('\r\n');
    }
    function restore(snapshot) {
      if (snapshot?.version !== 1 || !Array.isArray(snapshot.devices) || snapshot.devices.length > 32) throw new Error('Invalid saved sensor history.');
      const restored = new Map();
      for (const entry of snapshot.devices) {
        const device = entry?.device;
        if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(device?.address || '') || !Number.isInteger(device.addressType) || device.addressType < 0 || device.addressType > 3 || !Array.isArray(entry.samples) || entry.samples.length > limit) throw new Error('Invalid saved sensor history.');
        const readings = entry.samples.map(sample => {
          if (!Number.isFinite(sample.at) || sample.at < 0 || sample.at > now() + 1000 || !Array.isArray(sample.fields) || sample.fields.length > 128) throw new Error('Invalid saved sensor reading.');
          const fields = sample.fields.map(field => cleanField({ ...field, numericValue: field.value }));
          return { at: sample.at, fields, rssi: Number.isFinite(sample.rssi) ? sample.rssi : null, private: false };
        });
        const current = devices.get(key(device)), merged = new Map([...readings, ...(current?.samples || [])].map(sample => [sample.at, sample]));
        restored.set(key(device), { device: { address: device.address.toLowerCase(), addressType: device.addressType, name: String(device.name || '').slice(0, 80) }, samples: [...merged.values()].sort((a, b) => a.at - b.at).slice(-limit) });
      }
      for (const [id, entry] of restored) if (!cleared.has(id)) devices.set(id, entry); trim();
    }
    async function init() {
      try { adapter = options.storage === undefined ? storage() : options.storage; if (!adapter) throw new Error('Browser storage unavailable'); const saved = await adapter.load(); if (saved) restore(saved); available = true; changed(); }
      catch (failure) { error = failure.message; }
      return api;
    }
    function flush() {
      clearTimeout(timer); timer = null;
      writing = writing.then(async () => {
        if (!available) return false;
        while (saved < revision) {
          const version = revision;
          try { await adapter.save(snapshot(true)); saved = version; }
          catch (failure) { available = false; error = failure.message; return false; }
        }
        return true;
      });
      return writing;
    }
    const api = { init, ingest, samples, series, summary, clear, csv, exportDevice, flush, status: () => ({ available, error, limit, devices: devices.size }) };
    return api;
  }
  return { create, key };
})();
if (typeof module !== 'undefined') module.exports = NanoSensorHistory;
