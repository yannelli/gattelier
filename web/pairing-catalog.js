'use strict';

const NanoPairingCatalog = (() => {
  const victronSource = 'https://www.victronenergy.com/media/pg/VictronConnect_app/en/connecting.html';
  const victronCondition = 'Use the unique PIN on the device sticker first. 000000 applies when no PIN is printed and the PIN has not been changed.';
  const entries = Object.freeze([
    {
      id: 'victron-smartshunt', manufacturer: 'Victron Energy', model: 'SmartShunt', pin: '000000', transport: 'ble', configurable: true,
      condition: victronCondition,
      sourceTitle: 'SmartShunt manual: Configuration', sourceUrl: 'https://www.victronenergy.com/media/pg/SmartShunt/en/configuration.html'
    },
    {
      id: 'victron-bmv712', manufacturer: 'Victron Energy', model: 'BMV-712 Smart', pin: '000000', transport: 'ble', configurable: true,
      condition: victronCondition,
      sourceTitle: 'VictronConnect manual: Connecting', sourceUrl: victronSource
    },
    {
      id: 'victron-smartsolar', manufacturer: 'Victron Energy', model: 'SmartSolar MPPT charge controllers', pin: '000000', transport: 'ble', configurable: true,
      condition: victronCondition,
      sourceTitle: 'VictronConnect manual: Connecting', sourceUrl: victronSource
    },
    {
      id: 'microchip-rn4870', manufacturer: 'Microchip', model: 'RN4870 / RN4871 BLE modules', pin: '000000', transport: 'ble', configurable: true,
      condition: 'Documented SP command default. Applies when firmware uses the fixed six-digit passkey with the required I/O capability. Product firmware can change this value.',
      sourceTitle: 'RN4870/71 User Guide DS50002466B, section 2.4.20', sourceUrl: 'https://ww1.microchip.com/downloads/en/DeviceDoc/50002466B.pdf'
    },
    {
      id: 'ti-cc2540-sample', manufacturer: 'Texas Instruments', model: 'CC2540 SimpleBLEPeripheral demo', pin: '000000', transport: 'ble', configurable: true,
      condition: 'Applies to the development-kit sample firmware. The application source controls its fixed passkey; this is not a default for all CC2540 products.',
      sourceTitle: 'CC2540 Development Kit User Guide, section 4.6.1', sourceUrl: 'https://www.ti.com/lit/ug/swru301a/swru301a.pdf'
    },
    {
      id: 'adafruit-ezlink', manufacturer: 'Adafruit', model: 'Bluefruit EZ-Link Shield', pin: '1234', transport: 'classic', configurable: false,
      condition: 'Enter when the pairing dialog requests a code. Bluetooth Classic SPP requires a host adapter; the NanoC6 cannot use this transport.',
      sourceTitle: 'Bluefruit EZ-Link Shield guide: Pairing', sourceUrl: 'https://learn.adafruit.com/adafruit-bluefruit-ez-link-shield?view=all'
    },
    {
      id: 'sony-wh1000xm4', manufacturer: 'Sony', model: 'WH-1000XM4', pin: '0000', transport: 'classic', configurable: false,
      condition: 'Enter if requested when pairing the WH-1000XM4 audio endpoint. The manual selects WH-1000XM4 rather than LE_WH-1000XM4. Classic audio requires a host adapter.',
      sourceTitle: 'WH-1000XM4 Help Guide: Pairing', sourceUrl: 'https://helpguide.sony.net/mdr/wh1000xm4/v1/en/contents/TP0002752780.html'
    }
  ].map(entry => Object.freeze(entry)));
  const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function search(query = '', transport = 'all') {
    if (!['all', 'ble', 'classic'].includes(transport)) return [];
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return entries.filter(entry => {
      if (transport !== 'all' && entry.transport !== transport) return false;
      const text = normalize(`${entry.manufacturer} ${entry.model}`), compact = text.replace(/\s/g, '');
      return words.every(word => text.includes(word) || compact.includes(word));
    });
  }
  return { entries, search };
})();

if (typeof module !== 'undefined') module.exports = NanoPairingCatalog;
