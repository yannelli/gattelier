'use strict';

const NanoDeviceApps = (() => {
  const load = (name, value) => typeof module !== 'undefined' ? require(`./${name}.js`) : value;
  const apple = load('apple-continuity', typeof NanoAppleContinuity === 'undefined' ? null : NanoAppleContinuity);
  const nespresso = load('nespresso-protocol', typeof NanoNespressoProtocol === 'undefined' ? null : NanoNespressoProtocol);
  const vesync = load('vesync-protocol', typeof NanoVeSyncProtocol === 'undefined' ? null : NanoVeSyncProtocol);
  const entries = [
    { id: 'apple', title: 'Apple & AirPods', category: 'vendor', description: 'Headphone battery levels, Continuity messages, and broadcast changes.', protocol: apple, primary: ['Headphone battery', 'Left battery', 'Right battery', 'Case battery', 'Model', 'AirPlay advertised IPv4', 'Reported activity code'] },
    { id: 'nespresso', title: 'Nespresso', category: 'appliance', description: 'Vertuo machine states, maintenance flags, and settings packet previews.', protocol: nespresso, primary: ['Vertuo machine state', 'Model candidate', 'Water tank empty', 'Cleaning needed', 'Descaling needed', 'Error reported'] },
    { id: 'vesync', title: 'Levoit air purifiers', category: 'appliance', description: 'Core 200S identification, saved status inspection, and VeSync command previews.', protocol: vesync }
  ];
  function matches(device) { return device ? entries.filter(entry => entry.protocol.identify(device)).map(entry => entry.id) : []; }
  function identify(device) { for (const entry of entries) { const profile = entry.protocol.identify(device); if (profile) return profile; } return null; }
  function snapshot(id, device, state = {}) {
    const app = entries.find(item => item.id === id), profile = app?.protocol.identify(device || {});
    if (!profile) return null;
    const fields = [...profile.fields], limitations = [...profile.limitations], connected = state.ble?.connected && device.address === state.ble.address && device.addressType === state.ble.addressType;
    if (connected && app.protocol.decode) for (const service of state.services || []) for (const characteristic of service.characteristics || []) {
      if (!characteristic.valueHex) continue;
      try { fields.push(...app.protocol.decode(characteristic.uuid, characteristic.valueHex, { device, family: profile.family })); }
      catch (error) { limitations.push(`Saved ${characteristic.uuid} value: ${error.message}`); }
    }
    return { ...profile, fields, limitations, address: device.address, addressType: device.addressType, name: device.name, manufacturer: device.manufacturer || '', payloadHex: device.payloadHex || '', lastSeenMs: device.lastSeenMs, rssi: device.rssi };
  }
  function changes(before, after) {
    const previous = new Map((before?.fields || []).map(field => [field.label, String(field.value)]));
    const current = new Set(after.fields.map(field => field.label));
    return [...after.fields.filter(field => previous.get(field.label) !== String(field.value)).map(field => ({ label: field.label, before: previous.get(field.label) ?? 'Not observed', after: String(field.value) })), ...[...previous].filter(([label]) => !current.has(label)).map(([label, value]) => ({ label, before: value, after: 'Not present in latest observation' }))];
  }
  return { entries, get: id => entries.find(entry => entry.id === id), matches, identify, snapshot, changes };
})();
if (typeof module !== 'undefined') module.exports = NanoDeviceApps;
