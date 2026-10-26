'use strict';

const NanoScanQuery = (() => {
  const key = device => String(device.key || `${String(device.address).toLowerCase()}/${device.addressType}`);
  const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const number = (value, fallback) => Number.isFinite(value) ? value : fallback;
  function select(devices, filters = {}, context = {}) {
    const now = typeof context.now === 'function' ? context.now() : number(context.now, Date.now());
    const query = String(filters.query || '').trim().toLowerCase();
    const signal = filters.signal === 'all' || filters.signal == null || filters.signal === '' ? null : Number(filters.signal);
    const age = filters.lastSeen === 'all' || filters.lastSeen == null || filters.lastSeen === '' ? null : Number(filters.lastSeen);
    const selected = devices.filter(device => {
      if (Number.isFinite(signal) && number(device.rssi, -Infinity) < signal) return false;
      if (Number.isFinite(age) && now - number(device.lastSeenMs, -Infinity) > age * 1000) return false;
      if ((filters.connectable === true || filters.connectable === 'yes' || filters.connectable === 'connectable') && !device.connectable) return false;
      if ((filters.connectable === 'no' || filters.connectable === 'broadcast') && device.connectable) return false;
      if ((filters.favorites === true || filters.favorites === 'favorites') && !device.favorite) return false;
      const live = device.liveId != null || device.streamLive === true;
      if (filters.source === 'live' && !live) return false;
      if ((filters.source === 'history' || filters.source === 'historical') && live) return false;
      if (filters.kind && filters.kind !== 'all' && context.profile?.(device)?.category !== filters.kind) return false;
      if (!query) return true;
      const vendor = context.identifyVendor?.(device);
      const names = typeof vendor === 'string' ? vendor : [vendor?.search, vendor?.manufacturer, vendor?.addressVendor, vendor?.name, vendor?.vendor].filter(Boolean).join(' ');
      const services = [...(device.services || []), ...(device.serviceData || []).map(item => item.uuid)].join(' ');
      const profile = context.profile?.(device);
      return `${device.name || ''} ${device.address || ''} ${device.label || ''} ${names} ${services} ${profile?.title || ''} ${profile?.category || ''}`.toLowerCase().includes(query);
    });
    const compare = {
      strength: (a, b) => number(b.rssi, -Infinity) - number(a.rssi, -Infinity),
      recent: (a, b) => number(b.lastSeenMs, 0) - number(a.lastSeenMs, 0),
      name: (a, b) => order(String(a.label || a.name || '').toLowerCase(), String(b.label || b.name || '').toLowerCase()),
      first: (a, b) => number(a.firstSeenMs, Infinity) - number(b.firstSeenMs, Infinity),
      observations: (a, b) => number(b.observations, 0) - number(a.observations, 0),
    }[filters.sort] || ((a, b) => number(b.rssi, -Infinity) - number(a.rssi, -Infinity));
    return selected.sort((a, b) => compare(a, b) || order(key(a), key(b)));
  }
  return { select };
})();
if (typeof module !== 'undefined') module.exports = NanoScanQuery;
