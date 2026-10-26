'use strict';

const NanoCatalogSchema = (() => {
  const kinds = ['uuid', 'appearance', 'ad-type', 'protocol'];
  const uuid = value => String(value || '').toLowerCase().replace(/^0x/, '').replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  const validUUID = value => /^(?:[0-9a-f]{4}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.test(value);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = message => { throw new Error(`Invalid library: ${message}.`); };
  function text(value, limit = 180) { if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) fail('text'); return value; }
  function integer(value, max) { if (!Number.isInteger(value) || value < 0 || value > max) fail('numeric code'); return value; }
  function id(value) { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail('identifier'); return value; }
  function url(value) { const parsed = new URL(text(value, 600)); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('source URL'); return parsed.href; }
  function sources(value) { if (!Array.isArray(value) || !value.length || value.length > 100) fail('sources'); return value.map(item => ({ title: text(item?.title), url: url(item?.url) })); }
  function hex(value) { if (typeof value !== 'string' || !/^(?:[0-9a-f]{2}){1,256}$/i.test(value)) fail('byte prefix'); return value.toLowerCase(); }
  function condition(value) {
    if (!object(value)) fail('matching condition');
    const kind = value.kind, result = { kind };
    if (kind === 'service' || kind === 'service-data') { result.uuid = uuid(value.uuid); if (!validUUID(result.uuid)) fail('matching UUID'); }
    else if (kind === 'company') result.id = integer(value.id, 65535);
    else if (kind === 'manufacturer-prefix') { result.hex = hex(value.hex); if (result.hex.length < 4) fail('manufacturer prefix must include the company identifier'); }
    else if (kind === 'name' || kind === 'name-prefix') result.value = text(value.value, 80);
    else fail('matching condition type');
    if (kind === 'service-data' && value.prefix !== undefined) result.prefix = hex(value.prefix);
    if (['service-data', 'manufacturer-prefix'].includes(kind)) {
      for (const key of ['minBytes', 'maxBytes']) if (value[key] !== undefined) result[key] = integer(value[key], 1650);
      if (result.minBytes !== undefined && result.maxBytes !== undefined && result.minBytes > result.maxBytes) fail('byte range');
      if (result.maxBytes !== undefined && result.maxBytes < (result.hex || result.prefix || '').length / 2) fail('prefix exceeds byte range');
    }
    return result;
  }
  function protocol(value) {
    if (!object(value) || !Array.isArray(value.rules) || !value.rules.length || value.rules.length > 8) fail('protocol rules');
    if (!['sensor', 'beacon', 'tracker', 'vendor', 'medical', 'sleep', 'recorder', 'appliance', 'lock', 'other'].includes(value.category)) fail('protocol category');
    if (!['Service match', 'Advertisement match', 'Name candidate', 'Manufacturer match'].includes(value.confidence)) fail('match confidence');
    if (!Array.isArray(value.limitations) || value.limitations.length > 12) fail('protocol limitations');
    return { id: id(value.id), title: text(value.title), category: value.category, description: text(value.description, 480), confidence: value.confidence,
      limitations: value.limitations.map(item => text(item, 480)), sources: sources(value.sources), rules: value.rules.map(rule => {
        if (!Array.isArray(rule) || !rule.length || rule.length > 8) fail('rule size'); return rule.map(condition);
      }) };
  }
  function validate(value) {
    if (!object(value) || value.schema !== 1 || !kinds.includes(value.kind) || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 10000) fail('catalog format');
    const kind = value.kind, seen = new Set();
    const entries = value.entries.map(entry => {
      if (!object(entry)) fail('entry');
      let result, key;
      if (kind === 'protocol') { result = protocol(entry); key = result.id; }
      else {
        result = { name: text(entry.name), source: url(entry.source) };
        if (kind === 'uuid') {
          result.uuid = uuid(entry.uuid); if (!validUUID(result.uuid)) fail('UUID');
          if (!['service', 'characteristic', 'descriptor', 'unit', 'declaration', 'member-service', 'sdo-service'].includes(entry.kind)) fail('UUID type');
          result.kind = entry.kind; key = result.uuid;
        } else {
          result.code = integer(entry.code, kind === 'appearance' ? 65535 : 255); key = result.code;
          if (kind === 'appearance') {
            result.category = text(entry.category); result.categoryCode = integer(entry.categoryCode, 1023); result.subcategory = integer(entry.subcategory, 63);
            if (result.categoryCode * 64 + result.subcategory !== result.code) fail('appearance code');
          } else key = `${result.code}/${result.name}`;
        }
      }
      if (seen.has(key)) fail('duplicate entry'); seen.add(key); return result;
    });
    return { schema: 1, id: id(value.id), kind, title: text(value.title), revision: text(value.revision, 80), sources: sources(value.sources), entries };
  }
  function manifest(value) {
    if (!object(value) || value.schema !== 1 || !Array.isArray(value.libraries) || !value.libraries.length || value.libraries.length > 16) fail('manifest');
    const seen = new Set();
    return { schema: 1, revision: text(value.revision, 80), libraries: value.libraries.map(item => {
      const key = id(item.id); if (seen.has(key) || !kinds.includes(item.kind)) fail('manifest entry'); seen.add(key);
      if (item.path !== `/catalogs/${key}.json`) fail('catalog path');
      const count = integer(item.count, 10000), bytes = integer(item.bytes, 2 * 1024 * 1024); if (!count || !bytes) fail('empty catalog');
      return { id: key, kind: item.kind, title: text(item.title), revision: text(item.revision, 80), path: item.path, count, bytes };
    }) };
  }
  return { validate, manifest, uuid };
})();
if (typeof module !== 'undefined') module.exports = NanoCatalogSchema;
