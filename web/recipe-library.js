'use strict';

const NanoRecipeLibrary = (() => {
  const references = {
    identity: { title: 'Device Information Service', url: 'https://www.bluetooth.com/specifications/specs/device-information-service/' },
    battery: { title: 'Battery Service', url: 'https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/BAS_v1.1/out/en/index-en.html' },
    thermometer: { title: 'Health Thermometer Service', url: 'https://www.bluetooth.com/specifications/specs/health-thermometer-service-1-0/' },
    environment: { title: 'Environmental Sensing Service', url: 'https://www.bluetooth.com/specifications/specs/environmental-sensing-service-1-0/' },
    heart: { title: 'Heart Rate Service', url: 'https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/' },
    pulse: { title: 'Pulse Oximeter Service', url: 'https://www.bluetooth.com/specifications/specs/pulse-oximeter-service-1-0-1/' },
    access: { title: 'Bluetooth Assigned Numbers', url: 'https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Assigned_Numbers/out/en/index-en.html' }
  };
  const definitions = [
    ['device-manufacturer', 'Read manufacturer', 'identity', '180a', '2a29', 'read', 'Manufacturer name supplied by the connected device.'],
    ['device-model', 'Read model number', 'identity', '180a', '2a24', 'read', 'Model number supplied by the connected device.'],
    ['device-serial', 'Read serial number', 'identity', '180a', '2a25', 'read', 'Per-device serial number when exposed.'],
    ['device-firmware', 'Read firmware revision', 'identity', '180a', '2a26', 'read', 'Reported firmware revision.'],
    ['device-hardware', 'Read hardware revision', 'identity', '180a', '2a27', 'read', 'Reported hardware revision.'],
    ['device-software', 'Read software revision', 'identity', '180a', '2a28', 'read', 'Reported software revision.'],
    ['device-system-id', 'Read system ID', 'identity', '180a', '2a23', 'read', 'System identifier bytes; interpret using the Device Information Service.'],
    ['device-pnp-id', 'Read PnP ID', 'identity', '180a', '2a50', 'read', 'Vendor source, vendor ID, product ID, and product version.'],
    ['battery-read', 'Read battery level', 'battery', '180f', '2a19', 'read', 'Reported battery percentage.'],
    ['battery-live', 'Capture a battery update', 'battery', '180f', '2a19', 'notify', 'Wait for the next battery-level notification.'],
    ['thermometer-measurement', 'Capture a temperature measurement', 'thermometer', '1809', '2a1c', 'indicate', 'Start a measurement on the thermometer; capture its completed reading.'],
    ['thermometer-intermediate', 'Capture intermediate temperature', 'thermometer', '1809', '2a1e', 'notify', 'Capture an update while the thermometer is measuring.'],
    ['thermometer-type', 'Read thermometer measurement location', 'thermometer', '1809', '2a1d', 'read', 'Read the declared measurement location.'],
    ['thermometer-interval', 'Read thermometer interval', 'thermometer', '1809', '2a21', 'read', 'Read the measurement interval without changing it.'],
    ['environment-temperature', 'Read ambient temperature', 'environment', '181a', '2a6e', 'read', 'Temperature as a signed integer in units of 0.01 degrees Celsius.'],
    ['environment-humidity', 'Read relative humidity', 'environment', '181a', '2a6f', 'read', 'Relative humidity as an unsigned integer in units of 0.01 percent.'],
    ['environment-pressure', 'Read pressure', 'environment', '181a', '2a6d', 'read', 'Pressure as an unsigned integer in units of 0.1 pascal.'],
    ['environment-temperature-live', 'Capture ambient temperature', 'environment', '181a', '2a6e', 'notify', 'Capture the next ambient-temperature notification.'],
    ['environment-humidity-live', 'Capture relative humidity', 'environment', '181a', '2a6f', 'notify', 'Capture the next relative-humidity notification.'],
    ['heart-measurement', 'Capture a heart-rate measurement', 'heart', '180d', '2a37', 'notify', 'Capture a standard heart-rate packet, including optional fields when present.'],
    ['heart-location', 'Read heart-rate sensor location', 'heart', '180d', '2a38', 'read', 'Read the declared body sensor location.'],
    ['pulse-features', 'Read pulse-oximeter features', 'pulse', '1822', '2a60', 'read', 'Read the supported measurement fields and device features.'],
    ['pulse-spot-check', 'Capture a pulse-oximeter spot check', 'pulse', '1822', '2a5e', 'indicate', 'Start a spot check on the device and capture its result packet.'],
    ['pulse-continuous', 'Capture a pulse-oximeter update', 'pulse', '1822', '2a5f', 'notify', 'Capture the next continuous measurement packet.'],
    ['device-name', 'Read device name', 'access', '1800', '2a00', 'read', 'Read the GATT name, which can differ from the advertisement name.']
  ];
  const clone = value => JSON.parse(JSON.stringify(value));
  const model = () => typeof NanoRecipeModel !== 'undefined' ? NanoRecipeModel : typeof module !== 'undefined' ? require('./recipe-model.js') : null;
  function freeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) freeze(child); return value; }
  const entries = freeze(definitions.map(([id, name, category, service, uuid, operation, description]) => ({
    id, name, category, description, readOnly: true, source: references[category],
    leavesSubscriptionActive: operation !== 'read',
    recipe: { version: 1, name, steps: operation === 'read' ? [{ action: 'read', service, uuid }] : [{ action: 'subscribe', service, uuid, mode: operation }, { action: 'wait', service, uuid, prefix: '', timeoutMs: 30000 }] }
  })));
  function get(id) { const entry = entries.find(item => item.id === id); return entry ? clone(entry) : null; }
  function availability(entryOrId, state = {}) {
    const entry = typeof entryOrId === 'string' ? get(entryOrId) : entryOrId;
    if (!entry?.recipe) return { ready: false, reason: 'Recipe is unavailable.', steps: [] };
    if (!state.ble?.connected) return { ready: false, reason: 'Connect a device and discover its services.', steps: [] };
    const parser = model();
    if (!parser) return { ready: false, reason: 'Recipe runner is unavailable.', steps: [] };
    let recipe;
    try { recipe = parser.validate(entry.recipe); } catch (error) { return { ready: false, reason: error.message, steps: [] }; }
    const steps = recipe.steps.map((step, index) => {
      try { return { index, ready: true, handle: parser.resolve(state, step).handle }; }
      catch (error) { return { index, ready: false, reason: error.message }; }
    });
    const failed = steps.find(step => !step.ready);
    return { ready: !failed, reason: failed ? failed.reason : 'Available on this connection.', steps };
  }
  return { entries, get, availability, available: state => entries.filter(entry => availability(entry, state).ready).map(clone) };
})();
if (typeof module !== 'undefined') module.exports = NanoRecipeLibrary;
