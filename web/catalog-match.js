'use strict';

const NanoCatalogMatch = (() => {
  const schema = typeof module !== 'undefined' ? require('./catalog-schema.js') : NanoCatalogSchema;
  const bytes = value => typeof value === 'string' && value.length <= 3300 && /^(?:[0-9a-f]{2})*$/i.test(value) ? value.toLowerCase() : '';
  const size = (value, rule) => (rule.minBytes === undefined || value.length / 2 >= rule.minBytes) && (rule.maxBytes === undefined || value.length / 2 <= rule.maxBytes);
  function match(entries, device, discovered = []) {
    if (!device || typeof device !== 'object') return [];
    const services = new Set((Array.isArray(device.services) ? device.services : []).map(schema.uuid));
    const data = (Array.isArray(device.serviceData) ? device.serviceData : []).filter(item => item && typeof item.uuid === 'string').map(item => ({ uuid: schema.uuid(item.uuid), hex: bytes(item.hex), valid: typeof item.hex === 'string' && /^(?:[0-9a-f]{2})*$/i.test(item.hex) && item.hex.length <= 3300 }));
    for (const item of data) if (item.valid) services.add(item.uuid);
    const gatt = new Set(discovered.map(item => schema.uuid(typeof item === 'string' ? item : item?.uuid)));
    const manufacturer = bytes(device.manufacturer), name = typeof device.name === 'string' ? device.name.toLowerCase() : '';
    function evidence(rule) {
      if (rule.kind === 'service') return services.has(rule.uuid) ? `Advertised service ${rule.uuid.length === 4 ? '0x' : ''}${rule.uuid}.` : gatt.has(rule.uuid) ? `Discovered GATT service ${rule.uuid}.` : '';
      if (rule.kind === 'company') return manufacturer.length >= 4 && parseInt(manufacturer.slice(2, 4) + manufacturer.slice(0, 2), 16) === rule.id ? `Manufacturer company identifier 0x${rule.id.toString(16).padStart(4, '0')}.` : '';
      if (rule.kind === 'manufacturer-prefix') return manufacturer.startsWith(rule.hex) && size(manufacturer, rule) ? `Manufacturer prefix ${rule.hex}${rule.minBytes === rule.maxBytes && rule.minBytes !== undefined ? `, ${rule.minBytes} bytes` : ''}.` : '';
      if (rule.kind === 'service-data') return data.some(item => item.valid && item.uuid === rule.uuid && item.hex.startsWith(rule.prefix || '') && size(item.hex, rule)) ? `Service data ${rule.uuid}${rule.prefix ? ` starts with ${rule.prefix}` : ''}.` : '';
      if (rule.kind === 'name' || rule.kind === 'name-prefix') return (rule.kind === 'name' ? name === rule.value.toLowerCase() : name.startsWith(rule.value.toLowerCase())) ? `Advertised name ${rule.kind === 'name' ? 'matches' : 'starts with'} ${rule.value}.` : '';
      return '';
    }
    const found = [];
    for (const entry of entries) {
      const matched = entry.rules.map(rule => ({ rule, evidence: rule.map(evidence) })).filter(item => item.evidence.every(Boolean));
      if (!matched.length) continue;
      const strength = rule => rule.some(item => item.kind === 'manufacturer-prefix' && item.hex.length > 4 || item.kind === 'service-data' && (item.prefix || item.minBytes > 0 || item.maxBytes !== undefined)) ? 4 : rule.some(item => ['service', 'service-data'].includes(item.kind)) ? 3 : rule.some(item => ['company', 'manufacturer-prefix'].includes(item.kind)) ? 2 : 1;
      matched.sort((a, b) => strength(b.rule) - strength(a.rule) || b.rule.length - a.rule.length);
      const best = matched[0], ceiling = { 'Name candidate': 1, 'Manufacturer match': 2, 'Service match': 3, 'Advertisement match': 4 }[entry.confidence];
      const score = Math.min(strength(best.rule), ceiling), confidence = { 1: 'Name candidate', 2: 'Manufacturer match', 3: 'Service match', 4: 'Advertisement match' }[score];
      found.push({ id: entry.id, title: entry.title, category: entry.category, confidence, evidence: best.evidence,
        fields: [{ label: 'Protocol family', value: entry.title }, { label: 'Description', value: entry.description }],
        limitations: [...entry.limitations, ...(score < 3 ? ['This match does not confirm a product model or supported operations.'] : []), ...(device.payloadTruncated ? ['Advertisement bytes were truncated; this match uses the retained fields.'] : [])],
        sources: entry.sources, library: entry.library, revision: entry.revision, external: true, score });
    }
    return found.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  }
  return { match };
})();
if (typeof module !== 'undefined') module.exports = NanoCatalogMatch;
