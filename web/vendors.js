'use strict';

const NanoVendors = (() => {
  function companyId(manufacturer) {
    if (typeof manufacturer !== 'string') return null;
    const hex = manufacturer.replace(/\s/g, '');
    if (hex.length < 4 || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) return null;
    return parseInt(hex.slice(2, 4) + hex.slice(0, 2), 16);
  }
  function addressHex(address) {
    if (typeof address !== 'string' || !/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2})$/i.test(address)) return '';
    return address.replace(/[:-]/g, '').toUpperCase();
  }
  function addressLabel(address, addressType) {
    if (addressType === 0) return 'Public';
    if (addressType === 2) return 'Public identity';
    if (addressType === 3) return 'Static BLE identity address';
    if (addressType !== 1) return 'Unknown address type';
    const hex = addressHex(address);
    if (!hex) return 'Unclassified random BLE address';
    return ['Non-resolvable private address', 'Resolvable private address', 'Reserved BLE address', 'Static BLE address'][parseInt(hex.slice(0, 2), 16) >> 6];
  }
  function addressVendor(address, addressType, database) {
    if (addressType !== 0 && addressType !== 2) return '';
    const hex = addressHex(address);
    if (!hex) return '';
    for (const length of [9, 7, 6]) {
      const company = database?.oui?.[hex.slice(0, length)];
      if (typeof company === 'string' && company) return company;
    }
    return '';
  }
  // vendors.json groups IEEE prefixes by organization to shrink the embedded copy; lookups need them keyed by prefix.
  function expand(data) {
    if (!data?.vendors) return data;
    const { vendors, ...rest } = data, oui = {};
    for (const [name, prefixes] of Object.entries(vendors)) for (const prefix of String(prefixes).split(' ')) oui[prefix] = name;
    return { ...rest, oui };
  }
  function identify(device, database) {
    const id = companyId(device.manufacturer);
    const manufacturer = id === null ? '' : database?.company?.[String(id)] || '';
    const vendor = addressVendor(device.address, device.addressType, database);
    const random = device.addressType === 1 || device.addressType === 3;
    const label = addressLabel(device.address, device.addressType);
    const staticAddress = label === 'Static BLE address' || label === 'Static BLE identity address';
    return {
      companyId: id, manufacturer, addressVendor: vendor,
      addressNote: random ? `${label}; no IEEE OUI attribution` : device.addressType !== 0 && device.addressType !== 2 ? 'Unknown address type; OUI lookup unavailable' : '',
      addressExplanation: staticAddress ? 'Device reports a static random BLE address; this does not mean it rotates.' : '',
      hint: [manufacturer || vendor, random ? label : ''].filter(Boolean).join(' · '),
      search: `${manufacturer} ${vendor}`
    };
  }
  return { companyId, addressLabel, addressVendor, expand, identify };
})();
if (typeof module !== 'undefined') module.exports = NanoVendors;
