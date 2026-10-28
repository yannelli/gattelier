'use strict';

const NanoSnapshotModel = (() => {
  const MAX_BYTES = 512 * 1024, properties = ['read', 'write', 'write-no-response', 'notify', 'indicate', 'broadcast', 'signed-write', 'extended-properties'];
  const fail = message => { throw new Error(message); };
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : fail('Expected a snapshot object.'); }
  function text(value, maximum = 256) { return typeof value === 'string' && value.length <= maximum ? value : fail('Invalid snapshot text.'); }
  function number(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fail('Invalid snapshot number.');
  }
  function integer(value, maximum = 65535) { return Number.isInteger(value) ? number(value, 0, maximum) : fail('Invalid snapshot integer.'); }
  function list(value, maximum) { return Array.isArray(value) && value.length <= maximum ? value : fail('Snapshot contains too many or invalid entries.'); }
  function uuid(value) {
    const raw = text(value, 40).toLowerCase().replace(/^0x/, '');
    if (/^[a-f0-9]{4}$/.test(raw)) return `0000${raw}-0000-1000-8000-00805f9b34fb`;
    if (/^[a-f0-9]{8}$/.test(raw)) return `${raw}-0000-1000-8000-00805f9b34fb`;
    return /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(raw) ? raw : fail('Invalid Bluetooth UUID.');
  }
  function hex(value) {
    const raw = text(value, 65536).replace(/\s/g, '').toLowerCase();
    return /^(?:[a-f0-9]{2})*$/.test(raw) ? raw : fail('Invalid hexadecimal bytes.');
  }
  function timestamp(value) {
    if (typeof value === 'number') return number(value);
    return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : fail('Invalid snapshot timestamp.');
  }
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  function forbidden(value, characteristic, service) {
    if (service === uuid('1910') || /^001120[a-f0-9]{2}-2233-4455-6677-889912345678$/.test(characteristic)) return true;
    if (typeof NanoPackets !== 'undefined' && NanoPackets.sensitive(value, characteristic)) return true;
    return /^41505026534b26/.test(value) || (characteristic === uuid('2bb1') && /^10fe/.test(value));
  }
  function keyed(entries, map) {
    const counts = new Map();
    return entries.map(entry => {
      const item = map(object(entry)), instance = (counts.get(item.uuid) || 0) + 1;
      counts.set(item.uuid, instance);
      return { key: `${item.uuid}#${instance}`, ...item };
    });
  }
  function validate(input) {
    let encoded;
    try { encoded = typeof input === 'string' ? input : JSON.stringify(input); } catch { fail('Snapshot JSON cannot be serialized.'); }
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).length > MAX_BYTES) fail('Snapshot exceeds the 512 KB limit.');
    let source; try { source = object(JSON.parse(encoded)); } catch { fail('Invalid snapshot JSON.'); }
    if (source.version !== 1) fail('Unsupported snapshot version.');
    const device = object(source.device);
    const address = text(device.address, 17).toUpperCase();
    if (!/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(address)) fail('Invalid Bluetooth address.');
    if (typeof source.includeValues !== 'boolean') fail('Invalid value inclusion setting.');
    const result = { version: 1, label: text(source.label, 160), capturedAt: timestamp(text(source.capturedAt, 40)), includeValues: source.includeValues,
      device: { address, addressType: integer(device.addressType, 3), name: text(device.name), manufacturer: hex(device.manufacturer),
        payloadHex: hex(device.payloadHex), serviceUUIDs: list(device.serviceUUIDs, 256).map(uuid).sort(),
        serviceData: list(device.serviceData, 256).map(item => ({ uuid: uuid(object(item).uuid), hex: hex(item.hex) })).sort((a, b) => a.uuid.localeCompare(b.uuid)) }, gatt: null };
    for (const field of ['firstSeen', 'lastSeen']) if (source[field] != null) result[field] = timestamp(source[field]);
    if (source.rssi != null) result.rssi = number(source.rssi, -200, 100);
    let count = 0, descriptors = 0;
    if (source.gatt !== null) result.gatt = keyed(list(source.gatt, 100), service => {
      const serviceUUID = uuid(service.uuid);
      const characteristics = keyed(list(service.characteristics, 2000), characteristic => {
        if (++count > 2000) fail('Snapshot exceeds 2,000 characteristics.');
        const result = { uuid: uuid(characteristic.uuid), handle: integer(characteristic.handle),
          properties: [...new Set(list(characteristic.properties, 16).map(property => properties.includes(property) ? property : fail('Invalid characteristic property.')))].sort(),
          descriptors: keyed(list(characteristic.descriptors, 128), descriptor => {
            if (++descriptors > 10000) fail('Snapshot contains too many descriptors.');
            return { uuid: uuid(descriptor.uuid), handle: integer(descriptor.handle) };
          }) };
        if (source.includeValues && result.properties.includes('read') && characteristic.valueHex != null) {
          const value = hex(characteristic.valueHex);
          if (!forbidden(value, result.uuid, serviceUUID)) result.valueHex = value;
        }
        return result;
      });
      return { uuid: serviceUUID, characteristics };
    });
    return freeze(result);
  }
  function capture(device, state = {}, options = {}) {
    if (!device) fail('Select a device in Discover before saving a snapshot.');
    const connected = state.ble?.connected && state.ble.addressType === device.addressType && String(state.ble.address).toUpperCase() === String(device.address).toUpperCase();
    return validate({ version: 1, label: options.label || device.name || device.address, capturedAt: new Date().toISOString(),
      firstSeen: device.firstSeenMs ? new Date(device.firstSeenMs).toISOString() : device.firstSeen ?? null,
      lastSeen: device.lastSeenMs ? new Date(device.lastSeenMs).toISOString() : device.lastSeen ?? null, rssi: device.rssi ?? null, includeValues: options.includeValues === true,
      device: { address: device.address, addressType: device.addressType, name: device.name || '', manufacturer: device.manufacturer || '',
        payloadHex: device.payloadHex || '', serviceUUIDs: device.services || [], serviceData: device.serviceData || [] },
      gatt: connected ? (state.services || []).map(service => ({ uuid: service.uuid, characteristics: (service.characteristics || []).map(characteristic => ({
        uuid: characteristic.uuid, handle: characteristic.handle, properties: characteristic.properties || [], descriptors: characteristic.descriptors || [],
        ...(options.includeValues && characteristic.valueHex != null ? { valueHex: characteristic.valueHex } : {}) })) })) : null });
  }
  function comparable(snapshot) {
    const value = { device: snapshot.device, gatt: snapshot.gatt === null ? null : {} };
    for (const service of snapshot.gatt || []) {
      const characteristics = {};
      for (const characteristic of service.characteristics) {
        const item = { handle: characteristic.handle, properties: characteristic.properties, descriptors: {} };
        if ('valueHex' in characteristic) item.valueHex = characteristic.valueHex;
        for (const descriptor of characteristic.descriptors) item.descriptors[descriptor.key] = { handle: descriptor.handle };
        characteristics[characteristic.key] = item;
      }
      value.gatt[service.key] = { characteristics };
    }
    return value;
  }
  function diff(a, b) {
    const changes = [];
    function walk(before, after, path) {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      if (before === undefined || after === undefined) { changes.push({ path, before, after, type: before === undefined ? 'added' : 'removed' }); return; }
      if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
        for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) walk(before[key], after[key], path ? `${path}.${key}` : key);
      } else changes.push({ path, before, after, type: 'changed' });
    }
    walk(comparable(validate(a)), comparable(validate(b)), '');
    return changes;
  }
  return { capture, validate, diff, uuid, MAX_BYTES };
})();
if (typeof module !== 'undefined') module.exports = NanoSnapshotModel;
