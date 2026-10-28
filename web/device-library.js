'use strict';

const NanoDeviceLibrary = (() => {
  const sources = {
    sleep: { title: 'Sleep Number transport implementation', url: 'https://github.com/kristofferR/ha-adjustable-bed/blob/main/docs/beds/sleep_number.md' },
    mcr: { title: 'Sleep Number MCR implementation', url: 'https://github.com/kristofferR/ha-adjustable-bed/blob/main/custom_components/adjustable_bed/beds/sleep_number_mcr.py' },
    thermometer: { title: 'Bluetooth Health Thermometer Service', url: 'https://www.bluetooth.com/specifications/specs/health-thermometer-service-1-0/' },
    environment: { title: 'Bluetooth Environmental Sensing Service', url: 'https://www.bluetooth.com/specifications/specs/environmental-sensing-service-1-0/' },
    nuki: { title: 'Nuki Bluetooth API 2.3.0', url: 'https://developer.nuki.io/uploads/short-url/1qEVXUUpo4xkPvTchbyKbdJLuOV.pdf' },
    resmed: { title: 'Air11 Bluetooth protocol implementation', url: 'https://github.com/m-kozlowski/airbreak-plus/blob/master/docs/as11/bluetooth_protocol.md' },
    ge: { title: 'GE Appliances SDK', url: 'https://github.com/GEMakers/gea-sdk' },
    samsung: { title: 'Samsung TV local API implementation', url: 'https://github.com/xchwarze/samsung-tv-ws-api' },
    samsungCompany: { title: 'Bluetooth SIG company identifiers', url: 'https://bitbucket.org/bluetooth-SIG/public/src/e7f76d7c5e2edced4872a352ff4a300610ac8212/assigned_numbers/company_identifiers/company_identifiers.yaml' },
    samsungServices: { title: 'Bluetooth SIG member service UUIDs', url: 'https://bitbucket.org/bluetooth-SIG/public/src/e7f76d7c5e2edced4872a352ff4a300610ac8212/assigned_numbers/uuids/member_uuids.yaml' },
    radiacode: { title: 'RadiaCode protocol implementation', url: 'https://github.com/cdump/radiacode/blob/master/src/radiacode/radiacode.py' },
    radiacodeBle: { title: 'RadiaCode BLE transport', url: 'https://github.com/cdump/radiacode/blob/master/src/radiacode/transports/bluetooth.py' }
  };
  const read = (id, label, status, module, command) => ({ id, label, kind: 'read', status, ...(module ? { module, command } : {}) });
  const definitions = [
    {
      id: 'sleep-fuzion', title: 'Sleep Number Fuzion', category: 'sleep', transport: 'BLE', status: 'Reader', module: 'sleep',
      services: ['09d23fae-90e6-44c2-95b6-0b3d0f1abf25'], characteristics: ['8d4675a5-b5fa-42b2-b587-0ee71c46b709', '421e00f3-ae76-4c49-ab6e-39e4df4a5333'],
      description: 'Read system capabilities, left/right firmness, and privacy state through the Fuzion session.',
      models: 'Transport documented for Climate 360, FlexFit, and FlexFit Smart; capability replies determine installed hardware.',
      authentication: 'Read Auth after discovery. Pair when link encryption is required. A valid 16-byte session UUID gates requests.',
      limitations: 'Cloud sleep scores are not available over BLE.',
      capabilities: [read('capabilities', 'System capabilities', 'implemented', 'sleep', 'capabilities'), read('left', 'Left firmness', 'implemented', 'sleep', 'left'), read('right', 'Right firmness', 'implemented', 'sleep', 'right'), read('privacy', 'Privacy state', 'implemented', 'sleep', 'privacy')],
      recipes: [], sources: [sources.sleep]
    },
    {
      id: 'sleep-mcr', title: 'Sleep Number MCR', category: 'sleep', transport: 'BLE', status: 'Reader', module: 'sleep',
      services: ['ffffd1fd-388d-938b-344a-939d1f6efee0'], characteristics: ['ffffd1fd-388d-938b-344a-939d1f6efee1', 'ffffd1fd-388d-938b-344a-939d1f6efee2'],
      description: 'Separate binary transport for older BAM and 360 foundations.',
      models: 'Documented for older BAM, i8, and 360 FlexFit 2. Read foundation capabilities to identify controls.',
      authentication: 'Session binding uses a persistent random nonzero 64-bit client identity and assigned addresses; a blanket PIN requirement is unsupported.',
      limitations: 'The reader binds a client identity and reads pump status. Foundation movement controls are not included.',
      capabilities: [read('mcr-status', 'Pump status and firmness', 'implemented', 'sleep', 'firmness'), read('foundation-status', 'Foundation capabilities and position', 'adapter-required')],
      recipes: [], sources: [sources.sleep, sources.mcr]
    },
    {
      id: 'health-thermometer', title: 'BLE health thermometer', category: 'sensor', transport: 'BLE', status: 'GATT recipes', services: ['1809'],
      description: 'Capture completed measurements or intermediate temperature updates from the standard Health Thermometer Service.',
      models: 'Devices exposing Health Thermometer service 0x1809.',
      authentication: 'Use the discovered characteristic properties. Pair if the device reports insufficient authentication or encryption.',
      limitations: 'Start a measurement on the thermometer to receive a measurement indication.',
      capabilities: [read('temperature', 'Temperature measurements', 'recipe'), read('type', 'Measurement location', 'recipe'), read('interval', 'Measurement interval', 'recipe')],
      recipes: ['thermometer-measurement', 'thermometer-intermediate', 'thermometer-type', 'thermometer-interval'], sources: [sources.thermometer]
    },
    {
      id: 'environmental-sensor', title: 'BLE environmental sensor', category: 'sensor', transport: 'BLE', status: 'GATT recipes', services: ['181a'],
      description: 'Read temperature, relative humidity, and pressure where the corresponding standard characteristics exist.',
      models: 'Devices exposing Environmental Sensing service 0x181A.', authentication: 'Security requirements come from the connected device.',
      limitations: 'Each reading and subscription requires its own discovered characteristic and property.',
      capabilities: [read('temperature', 'Ambient temperature', 'recipe'), read('humidity', 'Relative humidity', 'recipe'), read('pressure', 'Pressure', 'recipe')],
      recipes: ['environment-temperature', 'environment-humidity', 'environment-pressure', 'environment-temperature-live', 'environment-humidity-live'], sources: [sources.environment]
    },
    {
      id: 'nuki-lock', title: 'Nuki lock', category: 'lock', transport: 'BLE', status: 'Protocol documented',
      services: ['a92ee000-5501-11e4-916c-0800200c9a66', 'a92ee100-5501-11e4-916c-0800200c9a66', 'a92ee200-5501-11e4-916c-0800200c9a66', 'a92ee300-5501-11e4-916c-0800200c9a66'],
      description: 'Recognize initialization, pairing, and operational services and inspect discovered security properties.',
      models: 'Nuki API covers generations 1-4 and Ultra with distinct pairing service UUIDs.',
      authentication: 'Reading lock state requires an authorized client identity and shared key. Pairing is an application protocol, separate from a BLE PIN.',
      limitations: 'The encrypted state reader is not implemented. No unlock, configuration, or authorization-change recipe is included.',
      capabilities: [read('lock-state', 'Lock state and battery flags', 'adapter-required')], recipes: ['device-manufacturer', 'device-model', 'battery-read'], sources: [sources.nuki]
    },
    {
      id: 'resmed-air11', title: 'ResMed Air11 transport', category: 'medical', transport: 'BLE', status: 'Protocol documented',
      services: ['fd56'], characteristics: ['a6220002-35f1-4b20-afae-cb089d2044aa', 'a6220003-35f1-4b20-afae-cb089d2044aa'], names: ['^ResMed'],
      description: 'Recognize the documented Air11 FIG transport and inspect service metadata.',
      models: 'AirSense 11 protocol research; an FD56 advertisement or ResMed name alone does not establish the model.',
      authentication: 'First pairing uses a displayed four-digit code and SRP. Reconnect uses the saved clientId and masterPairKey; RPC requires a fresh AES session.',
      limitations: 'The encrypted RPC reader is not implemented. No therapy-setting writes are included.',
      capabilities: [read('version', 'Device version through encrypted GetVersion', 'adapter-required')], recipes: ['device-manufacturer', 'device-model', 'device-firmware'], sources: [sources.resmed]
    },
    {
      id: 'ge-appliance', title: 'GE washer / dryer', category: 'appliance', transport: 'GEA over USB / UDP', status: 'External transport', services: [], names: ['^(?:GE|GEA)[ _-](?:Washer|Dryer)\\b'],
      description: 'GE publishes a GEA bus SDK with appliance identity and ERD read/subscription APIs.',
      models: 'Matched by broadcast name. Compatibility depends on the appliance and adapter.',
      authentication: 'Transport and access requirements depend on the appliance and adapter.',
      limitations: 'The GE SDK provides USB and UDP adapters. No BLE cycle-data protocol is implemented.',
      capabilities: [read('identity', 'Model, serial, and appliance type over GEA', 'external-transport')], recipes: ['device-manufacturer', 'device-model', 'device-serial'], sources: [sources.ge]
    },
    {
      id: 'samsung-tv', title: 'Samsung TV', category: 'appliance', transport: 'LAN HTTP / WebSocket', status: 'External transport', services: [], names: ['^\\[TV\\]\\s*Samsung\\b', '^Samsung[ _-]TV\\b'],
      description: 'Published local clients read TV identity through the HTTP API and use WebSocket remote control.',
      models: 'Tizen compatibility varies by TV and firmware. Confirm model using the LAN device-info response.',
      authentication: 'Remote control requests TV approval and reuses the returned token. Device-info reads use the LAN endpoint.',
      limitations: 'A Samsung manufacturer ID does not identify a TV. Remote control runs over LAN, not BLE.',
      capabilities: [read('identity', 'Device information at /api/v2/', 'external-transport')], recipes: ['device-manufacturer', 'device-model'], sources: [sources.samsung]
    },
    {
      id: 'samsung-device', title: 'Samsung device', category: 'vendor', transport: 'BLE', status: 'Manufacturer metadata', companies: [0x0075],
      services: ['fddb', 'fd7e', 'fd6c', 'fd69', 'fd5a', 'fd59', 'fd4b', 'fd1d', 'fc91'], names: ['^Samsung(?:\\b|[ _-])', '^\\[TV\\]\\s*Samsung\\b'],
      description: 'Recognize Samsung Electronics manufacturer data, assigned services, and candidate broadcast names.',
      models: 'Matched by Samsung Electronics company and service assignments.',
      authentication: 'Security and application authentication depend on the device and its discovered services.',
      limitations: 'A Samsung match does not identify the device type, model, owner, or a control protocol.',
      capabilities: [read('identity', 'Exposed identity metadata', 'recipe')], recipes: ['device-manufacturer', 'device-model'], sources: [sources.samsungCompany, sources.samsungServices]
    },
    {
      id: 'radiacode', title: 'RadiaCode', category: 'sensor', transport: 'BLE', status: 'Spectrum and measurements', module: 'radiacode', services: ['e63215e5-7003-49d8-96b0-b024798fb901'],
      characteristics: ['e63215e6-7003-49d8-96b0-b024798fb901', 'e63215e7-7003-49d8-96b0-b024798fb901'],
      description: 'The documented BLE protocol supports firmware, serial number, buffered measurements, and spectrum queries.',
      models: 'Protocol and spectrum format depend on firmware. Confirm the returned firmware before decoding measurements.',
      authentication: 'The inspected BLE client connects and subscribes without an application credential exchange.',
      limitations: 'Measurement decoding requires firmware 4.8 or later. Dose values retain device units. Spectrum formats 0 and 1 are supported; reset requires confirmation.',
      capabilities: [read('version', 'Firmware version', 'implemented', 'radiacode', 'identity'), read('serial', 'Serial number', 'implemented', 'radiacode', 'identity'), read('measurements', 'Buffered measurements', 'implemented', 'radiacode', 'measurements'), read('spectrum', 'Energy spectrum', 'implemented', 'radiacode', 'spectrum')],
      recipes: ['device-manufacturer', 'device-model', 'battery-read'], sources: [sources.radiacode, sources.radiacodeBle]
    }
  ];
  const clone = value => JSON.parse(JSON.stringify(value));
  function freeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) freeze(child); return value; }
  const entries = freeze(definitions);
  const uuid = value => String(value || '').toLowerCase().replace(/^0x/, '').replace(/^0000([\da-f]{4})-0000-1000-8000-00805f9b34fb$/, '$1');
  const connected = (device, state = {}) => Boolean(state.ble?.connected && device?.address && state.ble.address && device.address.toLowerCase() === state.ble.address.toLowerCase() && device.addressType === state.ble.addressType);
  const attributes = [
    ['sleep-fuzion', '8d4675a5-b5fa-42b2-b587-0ee71c46b709', 'Sleep Number session authentication'],
    ['sleep-fuzion', '421e00f3-ae76-4c49-ab6e-39e4df4a5333', 'Sleep Number BAM key transport'],
    ['sleep-mcr', 'ffffd1fd-388d-938b-344a-939d1f6efee1', 'Sleep Number MCR responses'],
    ['sleep-mcr', 'ffffd1fd-388d-938b-344a-939d1f6efee2', 'Sleep Number MCR commands'],
    ['radiacode', 'e63215e6-7003-49d8-96b0-b024798fb901', 'RadiaCode commands'],
    ['radiacode', 'e63215e7-7003-49d8-96b0-b024798fb901', 'RadiaCode responses']
  ];
  function lookup(value, serviceUuid = '') {
    const key = uuid(value), service = uuid(serviceUuid);
    const schlage = typeof NanoSchlage !== 'undefined' ? NanoSchlage.lookup?.(value, serviceUuid) : null;
    if (schlage) return schlage;
    const attribute = attributes.find(([, id]) => id === key);
    if (attribute) {
      const entry = entries.find(item => item.id === attribute[0]);
      if (!service || entry.services.includes(service)) return { name: attribute[2], source: entry.sources.at(-1).url };
    }
    const catalog = typeof NanoMetadata !== 'undefined' ? NanoMetadata.lookup(value) : typeof module !== 'undefined' ? require('./catalogs.js').lookupUUID(value) : null;
    if (catalog) return catalog;
    const entry = entries.find(item => item.services.includes(key) && item.category !== 'vendor');
    return entry ? { name: entry.title, description: entry.description, source: entry.sources[0].url } : null;
  }
  function suggestions(device, state = {}) {
    if (!connected(device, state)) return [];
    const recipes = typeof NanoRecipeLibrary !== 'undefined' ? NanoRecipeLibrary : typeof module !== 'undefined' ? require('./recipe-library.js') : null;
    const available = recipes?.available(state) || [];
    return (state.services || []).flatMap(service => (service.characteristics || []).flatMap(item => {
      const properties = item.properties || [], actions = [];
      if (properties.includes('read')) actions.push({ action: 'read' });
      const mode = properties.includes('notify') ? 'notify' : properties.includes('indicate') ? 'indicate' : '';
      if (mode && (!item.subscription || item.subscription === 'off')) actions.push({ action: 'subscribe', mode });
      return actions.map(action => {
        const recipe = available.find(entry => {
          const step = entry.recipe.steps[0];
          return uuid(step.service) === uuid(service.uuid) && uuid(step.uuid) === uuid(item.uuid) && step.action === action.action && step.mode === action.mode;
        });
        const name = lookup(item.uuid, service.uuid)?.name || `handle ${item.handle}`;
        return { ...action, handle: item.handle, uuid: item.uuid, serviceUuid: service.uuid, label: action.action === 'read' && recipe ? recipe.name : `${action.action === 'read' ? 'Read' : 'Subscribe to'} ${name}`, ...(recipe ? { recipeId: recipe.id } : {}) };
      });
    }));
  }
  function match(device = {}, state = {}) {
    const gatt = connected(device, state) ? state.services || [] : [];
    const services = new Set([...(device.services || []).map(item => uuid(typeof item === 'string' ? item : item.uuid)), ...gatt.map(item => uuid(item.uuid))]);
    const characteristics = new Set(gatt.flatMap(service => (service.characteristics || []).map(item => uuid(item.uuid))));
    const manufacturer = typeof device.manufacturer === 'string' && /^(?:[\da-f]{2}){2,}$/i.test(device.manufacturer) ? device.manufacturer : '';
    const company = manufacturer ? parseInt(manufacturer.slice(0, 2), 16) | parseInt(manufacturer.slice(2, 4), 16) << 8 : null;
    return entries.flatMap(entry => {
      const service = entry.services.find(value => services.has(uuid(value)));
      const signature = entry.characteristics?.length && entry.characteristics.every(value => characteristics.has(uuid(value)));
      const name = entry.names?.some(pattern => new RegExp(pattern, 'i').test(device.name || ''));
      const manufacturerMatch = entry.companies?.includes(company);
      if (!service && !signature && !manufacturerMatch && !name) return [];
      return [{ ...clone(entry), confidence: signature ? 'GATT signature' : service ? 'Service match' : manufacturerMatch ? 'Manufacturer match' : 'Name candidate', confirmed: Boolean(signature || service), evidence: signature ? 'Documented characteristic UUIDs discovered on this device.' : service ? `Service ${service} is present.` : manufacturerMatch ? `Manufacturer company 0x${company.toString(16).padStart(4, '0')} is assigned to Samsung Electronics Co. Ltd.` : `Broadcast name: ${device.name}`, modelConfirmed: false }];
    });
  }
  return { entries, sources: freeze(sources), get: id => { const entry = entries.find(item => item.id === id); return entry ? clone(entry) : null; }, match, uuid, connected, lookup, suggestions };
})();
if (typeof module !== 'undefined') module.exports = NanoDeviceLibrary;
