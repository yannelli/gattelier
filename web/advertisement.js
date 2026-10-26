'use strict';

const NanoAdvertisement = (() => {
  const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  function uuid(bytes) {
    const value = hex(bytes.slice().reverse());
    return bytes.length < 16 ? `0x${value}` : `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
  function decode(record) {
    if (typeof record?.payloadHex !== 'string' || record.payloadHex.length > 3300 || !/^(?:[0-9a-f]{2})*$/i.test(record.payloadHex)) throw new Error('Invalid raw advertisement payload.');
    const bytes = Uint8Array.from(record.payloadHex.match(/../g) || [], value => parseInt(value, 16));
    const decoded = { ...record, manufacturer: '', services: [], serviceData: [] };
    let completeName = false;
    for (let at = 0; at < bytes.length;) {
      const length = bytes[at++];
      if (!length || at + length > bytes.length) break;
      const type = bytes[at], data = bytes.slice(at + 1, at + length);
      if (type === 0xff && !decoded.manufacturer) decoded.manufacturer = hex(data);
      if (type === 0x09 || type === 0x08 && !completeName && !decoded.name) {
        decoded.name = new TextDecoder().decode(data).replace(/\0.*$/, '').slice(0, 80);
        completeName = type === 0x09;
      }
      if (type === 0x0a && data.length === 1 && !Number.isFinite(decoded.txPower)) decoded.txPower = data[0] > 127 ? data[0] - 256 : data[0];
      const width = [2, 3].includes(type) ? 2 : [4, 5].includes(type) ? 4 : [6, 7].includes(type) ? 16 : 0;
      for (let pos = 0; width && pos + width <= data.length; pos += width) decoded.services.push(uuid(data.slice(pos, pos + width)));
      const serviceWidth = type === 0x16 ? 2 : type === 0x20 ? 4 : type === 0x21 ? 16 : 0;
      if (serviceWidth && data.length >= serviceWidth) decoded.serviceData.push({ uuid: uuid(data.slice(0, serviceWidth)), hex: hex(data.slice(serviceWidth)) });
      at += length;
    }
    decoded.services = [...new Set(decoded.services)];
    return decoded;
  }
  function batch(value) {
    if (!['raw-v1', 'raw-v2'].includes(value?.format)) return value;
    if (!Array.isArray(value.devices) || value.devices.length > 4096) throw new Error('Invalid raw advertisement batch.');
    return { ...value, devices: value.devices.map(record => {
      if (value.format === 'raw-v1') return decode(record);
      if (!Array.isArray(record) || record.length !== 12 || !Number.isInteger(record[7]) || record[7] < 0 || record[7] > 3) throw new Error('Invalid compact advertisement row.');
      const [seq, id, ms, address, addressType, rssi, advType, flags, txPower, payloadBytes, name, payloadHex] = record;
      if (![seq, id, ms, addressType, advType, payloadBytes].every(Number.isSafeInteger) || seq < 1 || id < 1 || id > 0xffffffff || ms < 0 || ms > 0xffffffff || addressType < 0 || addressType > 3 || advType < 0 || advType > 255 || payloadBytes < 0 || payloadBytes > 65535 || typeof address !== 'string' || !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(address) || typeof name !== 'string' || name.length > 80 || !Number.isInteger(rssi) || rssi < -128 || rssi > 127 || txPower !== null && (!Number.isInteger(txPower) || txPower < -128 || txPower > 127)) throw new Error('Invalid compact advertisement row.');
      return decode({ seq, id, ms, address, addressType, rssi, advType, connectable: Boolean(flags & 1), payloadTruncated: Boolean(flags & 2), txPower, payloadBytes, name, payloadHex });
    }) };
  }
  return { decode, batch };
})();
if (typeof module !== 'undefined') module.exports = NanoAdvertisement;
