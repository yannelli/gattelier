'use strict';

const NanoMetadata = (() => {
  const catalogs = typeof module !== 'undefined' ? require('./catalogs.js') : NanoCatalogs;
  const DEFAULT_ORIGIN = 'https://gattelier.ryanyannelli.com', KEY = 'nanoscope.metadata.v1';
  const uuid = value => String(value || '').toLowerCase().replace(/^0x/, '').replace(/^0000([\da-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  const uuidPattern = /^(?:[\da-f]{4}|[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})$/;
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\u0000-\u001f]/.test(value);
  function validate(value) {
    if (!value || value.schema !== 1 || !text(value.revision) || !Array.isArray(value.entries) || value.entries.length > 2000) throw new Error('Unsupported metadata catalog.');
    const seen = new Set();
    const entries = value.entries.map(entry => {
      const id = uuid(entry.uuid);
      if (!uuidPattern.test(id) || seen.has(id) || !text(entry.name) || !text(entry.source)) throw new Error('Invalid metadata entry.');
      const source = new URL(entry.source);
      if (source.protocol !== 'https:' || source.username || source.password) throw new Error('Metadata sources must use HTTPS.');
      seen.add(id);
      const result = { uuid: id, name: entry.name, source: source.href };
      if (entry.description !== undefined) {
        if (typeof entry.description !== 'string' || !entry.description.length || entry.description.length > 480 || /[\u0000-\u001f]/.test(entry.description)) throw new Error('Invalid metadata description.');
        result.description = entry.description;
      }
      if (entry.decode) {
        const d = entry.decode;
        if (!['enum', 'uint', 'int'].includes(d.type) || ![1, 2, 4].includes(d.bytes) || !text(d.label)) throw new Error('Unsupported metadata decoder.');
        result.decode = { type: d.type, bytes: d.bytes, label: d.label };
        if (d.type === 'enum') {
          if (!d.values || Array.isArray(d.values) || typeof d.values !== 'object' || Object.keys(d.values).length > 128) throw new Error('Invalid metadata states.');
          result.decode.values = Object.fromEntries(Object.entries(d.values).map(([key, label]) => {
            if (!/^\d+$/.test(key) || Number(key) >= 2 ** (8 * d.bytes) || !text(label)) throw new Error('Invalid metadata state.');
            return [String(Number(key)), label];
          }));
        } else {
          if (!Number.isFinite(d.scale) || Math.abs(d.scale) > 1e9 || typeof d.unit !== 'string' || d.unit.length > 24) throw new Error('Invalid metadata units.');
          result.decode.scale = d.scale; result.decode.unit = d.unit;
        }
      }
      return result;
    });
    return { schema: 1, revision: value.revision, entries };
  }
  function create({ storage = globalThis.localStorage, fetcher = (...args) => fetch(...args) } = {}) {
    let bundled = null, supplemental = null, enabled = false, origin = DEFAULT_ORIGIN, updatedAt = null;
    try {
      const saved = JSON.parse(storage?.getItem(KEY) || 'null');
      if (saved) { supplemental = validate(saved.catalog); enabled = saved.enabled === true; updatedAt = saved.updatedAt;
        const savedOrigin = new URL(saved.origin || DEFAULT_ORIGIN);
        if (savedOrigin.protocol === 'https:' && !savedOrigin.username && !savedOrigin.password && savedOrigin.pathname === '/' && !savedOrigin.search && !savedOrigin.hash) origin = savedOrigin.origin;
      }
    } catch {}
    const changed = () => globalThis.dispatchEvent?.(new CustomEvent('nanoscope:metadata'));
    function save() {
      try { if (supplemental) storage?.setItem(KEY, JSON.stringify({ catalog: supplemental, enabled, updatedAt, origin })); } catch {}
    }
    function lookup(id) {
      id = uuid(id);
      return bundled?.entries.find(entry => entry.uuid === id) || (enabled ? supplemental?.entries.find(entry => entry.uuid === id) : null) || catalogs.lookupUUID(id) || null;
    }
    async function download(url, fresh = false) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetcher(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: fresh ? 'no-store' : 'default', signal: controller.signal });
        if (!response.ok) throw new Error(`Metadata download failed (${response.status}).`);
        const reader = response.body?.getReader(); let raw = '';
        if (reader) {
          const decoder = new TextDecoder(); let bytes = 0;
          while (true) {
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 512 * 1024) { await reader.cancel(); throw new Error('Metadata catalog exceeds 512 KiB.'); }
            raw += decoder.decode(part.value, { stream: true });
          }
          raw += decoder.decode();
        } else { raw = await response.text(); if (raw.length > 512 * 1024) throw new Error('Metadata catalog exceeds 512 KiB.'); }
        return validate(JSON.parse(raw));
      } finally { clearTimeout(timer); }
    }
    return {
      status: () => ({ enabled, origin, updatedAt, bundled: bundled?.revision || '', supplemental: supplemental?.revision || '', count: (bundled?.entries.length || 0) + (enabled ? supplemental?.entries.filter(item => !bundled?.entries.some(local => local.uuid === item.uuid)).length || 0 : 0) }),
      lookup,
      async init() { try { bundled = await download('metadata-v1.json'); changed(); } catch {} },
      async refresh(value = DEFAULT_ORIGIN) {
        const target = new URL(value);
        if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Use an HTTPS metadata origin without a path.');
        const catalog = await download(`${target.origin}/metadata-v1.json`, true);
        supplemental = catalog; enabled = true; origin = target.origin; updatedAt = new Date().toISOString(); save(); changed();
      },
      enable(value) { enabled = Boolean(value); save(); changed(); },
      clear() { supplemental = null; enabled = false; updatedAt = null; storage?.removeItem(KEY); changed(); },
      decode(id, hex) {
        const known = lookup(id);
        const entry = known?.decode ? known : enabled ? supplemental?.entries.find(item => item.uuid === uuid(id) && item.decode) : null;
        const d = entry?.decode;
        if (!d || typeof hex !== 'string' || hex.length !== d.bytes * 2 || !/^[\da-f]+$/i.test(hex)) return [];
        const bytes = Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
        let value = bytes.reduce((sum, byte, index) => sum + byte * 256 ** index, 0);
        if (d.type === 'int' && value >= 2 ** (d.bytes * 8 - 1)) value -= 2 ** (d.bytes * 8);
        const display = d.type === 'enum' ? d.values[String(value)] || `Unassigned (${value})` : `${Number((value * d.scale).toPrecision(10))}${d.unit ? ` ${d.unit}` : ''}`;
        return [{ label: d.label, value: display, source: entry.source }];
      }
    };
  }
  let instance;
  const current = () => instance ||= create();
  return { create, validate, DEFAULT_ORIGIN, init: () => current().init(), refresh: value => current().refresh(value),
    status: () => current().status(), lookup: id => current().lookup(id), decode: (id, hex) => current().decode(id, hex),
    enable: value => current().enable(value), clear: () => current().clear() };
})();
if (typeof module !== 'undefined') module.exports = NanoMetadata;
