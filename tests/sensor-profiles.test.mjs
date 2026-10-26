import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { identify } = require('../web/sensor-profiles.js');
const fields = result => Object.fromEntries(result.fields.map(item => [item.label, item.value]));
const bthome = hex => identify({ serviceData: [{ uuid: '0xfcd2', hex }] });
const ruuvi = hex => identify({ manufacturer: '9904' + hex });

test('BTHome published example decodes little-endian temperature and humidity', () => {
  const result = bthome('4002c40903bf13');
  assert.equal(result.category, 'sensor'); assert.equal(result.confidence, 'Decoded format');
  assert.equal(fields(result).Temperature, '25 °C'); assert.equal(fields(result).Humidity, '50.55 %');
  assert.equal(result.sources[0].url, 'https://bthome.io/format/');
  const fullUUID = identify({ serviceData: [{ uuid: '0000fcd2-0000-1000-8000-00805f9b34fb', hex: '400161' }] });
  assert.equal(fields(fullUUID).Battery, '97 %');
});
test('BTHome decodes signed temperature and requested environmental, count and binary objects', () => {
  const result = bthome('44002a0161022efb03bf1304138a0105138a1409600b021b000c020c11012100');
  assert.equal(result.confidence, 'Decoded format');
  assert.deepEqual(fields(result), { 'BTHome version': 2, Encryption: 'Unencrypted', 'Update mode': 'Trigger-based',
    'Packet ID': 42, Battery: '97 %', Temperature: '-12.34 °C', Humidity: '50.55 %', Pressure: '1008.83 hPa',
    Illuminance: '13460.67 lx', Count: 96, Power: '69.14 W', Voltage: '3.074 V', Opening: 'Open', Motion: 'Clear' });
});
test('BTHome alternate integer widths and scale factors retain signedness', () => {
  const fixtures = [
    ['2e23', 'Humidity', '35 %'], ['3d0960', 'Count', 24585], ['3e2a2c0960', 'Count', 1611213866],
    ['3effffffff', 'Count', 4294967295], ['451101', 'Temperature', '27.3 °C'], ['4a020c', 'Voltage', '307.4 V'],
    ['57ea', 'Temperature', '-22 °C'], ['58ea', 'Temperature', '-7.7 °C'], ['59ea', 'Count', -22],
    ['5aeaea', 'Count', -5398], ['5bea0234ea', 'Count', -365690134], ['5c02fbffff', 'Power', '-12.78 W'],
  ];
  for (const [packet, label, value] of fixtures) assert.equal(fields(bthome('40' + packet))[label], value, packet);
  const repeated = fields(bthome('4002c409022efb'));
  assert.equal(repeated.Temperature, '25 °C'); assert.equal(repeated['Temperature 2'], '-12.34 °C');
});
test('BTHome encrypted published frame exposes metadata without decrypting measurements', () => {
  const result = bthome('41e445f3c9962b332211006c7c4519');
  assert.equal(result.title, 'BTHome v2 encrypted sensor'); assert.equal(result.confidence, 'Format match');
  assert.equal(fields(result)['Advertised counter'], 1122867); assert.equal(fields(result)['Encrypted bytes'], 6);
  assert.equal(fields(result).Temperature, undefined); assert.match(result.limitations[0], /authentication was not verified/);
  assert.equal(bthome('410203').confidence, 'Malformed frame');
});
test('BTHome rejects version/header errors and stops at unknown, truncated or invalid objects', () => {
  for (const hex of ['', 'abc', 'gg']) assert.equal(bthome(hex).confidence, 'Malformed frame');
  for (const hex of ['2002c409', '6002c409']) {
    const result = bthome(hex); assert.equal(fields(result).Temperature, undefined); assert.match(result.limitations[0], /unsupported/);
  }
  assert.equal(bthome('4202c409').confidence, 'Malformed frame');
  assert.equal(bthome('4002c4').confidence, 'Malformed frame');
  const partial = bthome('4001610200');
  assert.equal(partial.confidence, 'Partial decode'); assert.equal(fields(partial).Battery, '97 %'); assert.equal(fields(partial).Temperature, undefined);
  const unknown = bthome('400161060002c409');
  assert.equal(unknown.confidence, 'Partial decode'); assert.match(unknown.limitations[0], /Unsupported object 0x06/);
  assert.equal(fields(unknown).Temperature, undefined);
  const outOfOrder = bthome('4003bf1302c409');
  assert.match(outOfOrder.limitations[0], /ascending ID order/); assert.equal(fields(outOfOrder).Temperature, undefined);
  assert.equal(fields(bthome('401102')).Opening, undefined); assert.match(bthome('401102').limitations[0], /expected 0 or 1/);
  assert.equal(identify({ services: ['fcd2'] }).confidence, 'Service match');
});
test('Ruuvi published positive vector decodes big-endian measurements and packed power', () => {
  const result = ruuvi('0512fc5394c37c0004fffc040cac364200cdcbb8334c884f');
  assert.equal(result.confidence, 'Decoded format');
  assert.deepEqual(fields(result), { Temperature: '24.3 °C', Humidity: '53.49 %', Pressure: '100044 Pa',
    'Acceleration X': '0.004 g', 'Acceleration Y': '-0.004 g', 'Acceleration Z': '1.036 g',
    'Battery voltage': '2.977 V', 'TX power': '4 dBm', 'Movement counter': 66, 'Measurement sequence': 205,
    'Sensor MAC': 'cb:b8:33:4c:88:4f' });
  assert.equal(result.sources[0].url, 'https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-5-rawv2');
});
test('Ruuvi maximum, minimum and unavailable published vectors preserve sentinel semantics', () => {
  const maximum = fields(ruuvi('057ffffffefffe7fff7fff7fffffdefefffecbb8334c884f'));
  assert.equal(maximum.Temperature, '163.835 °C'); assert.equal(maximum.Humidity, '163.835 %');
  assert.equal(maximum['Battery voltage'], '3.646 V'); assert.equal(maximum['TX power'], '20 dBm');
  assert.equal(maximum['Movement counter'], 254); assert.equal(maximum['Measurement sequence'], 65534);
  const minimum = fields(ruuvi('058001000000008001800180010000000000cbb8334c884f'));
  assert.equal(minimum.Temperature, '-163.835 °C'); assert.equal(minimum.Humidity, '0 %'); assert.equal(minimum.Pressure, '50000 Pa');
  assert.equal(minimum['Acceleration X'], '-32.767 g'); assert.equal(minimum['Battery voltage'], '1.6 V'); assert.equal(minimum['TX power'], '-40 dBm');
  const unavailable = fields(ruuvi('058000ffffffff800080008000ffffffffffffffffffffff'));
  assert.equal(Object.keys(unavailable).length, 11); assert.ok(Object.values(unavailable).every(value => value === 'Not available'));
  const packed = Buffer.from('0512fc5394c37c0004fffc040cac364200cdcbb8334c884f', 'hex');
  packed.writeUInt16BE((2047 << 5) | 22, 13);
  assert.equal(fields(ruuvi(packed.toString('hex')))['Battery voltage'], 'Not available');
  assert.equal(fields(ruuvi(packed.toString('hex')))['TX power'], '4 dBm');
  packed.writeUInt16BE((1400 << 5) | 31, 13);
  assert.equal(fields(ruuvi(packed.toString('hex')))['Battery voltage'], '3 V');
  assert.equal(fields(ruuvi(packed.toString('hex')))['TX power'], 'Not available');
});
test('Ruuvi rejects truncated, oversized and unrelated data without guessing measurements', () => {
  const valid = '0512fc5394c37c0004fffc040cac364200cdcbb8334c884f';
  for (const data of ['05', valid.slice(0, -2), valid + '00']) {
    const result = ruuvi(data); assert.equal(result.confidence, 'Malformed frame'); assert.deepEqual(result.fields, []);
  }
  for (const device of [{ manufacturer: '9904' }, { manufacturer: '990403' }, { manufacturer: '0499' + valid },
    { manufacturer: '990405zz' }, { name: 'Ruuvi sensor' }, {}, null]) assert.equal(identify(device), null);
  const device = { manufacturer: '9904' + valid, credentials: 'private' }, before = JSON.stringify(device);
  identify(device); assert.equal(JSON.stringify(device), before);
});

test('BTHome official CO2, current and energy examples decode with their declared widths', () => {
  for (const [hex, label, expected] of [['12e204', 'CO2', '1250 ppm'], ['434e34', 'Current', '13.39 A'], ['0a138a14', 'Energy', '1346.067 kWh'], ['4d12138a14', 'Energy', '344593.17 kWh']]) {
    assert.equal(fields(bthome('40' + hex))[label], expected);
    assert.equal(bthome('40' + hex.slice(0, -2)).confidence, 'Malformed frame');
  }
});
