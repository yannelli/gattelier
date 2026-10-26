import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { identify, identifyDecrypted, sources } = require('../web/sensor-profiles.js');
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
  const unknown = bthome('400161660002c409');
  assert.equal(unknown.confidence, 'Partial decode'); assert.match(unknown.limitations[0], /Unsupported object 0x66/);
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

test('BTHome additional official numeric examples expose chart metadata', () => {
  const examples = [
    ['065e1f', 'Mass', 80.3, 'kg'], ['073e1d', 'Mass', 74.86, 'lb'], ['08ca06', 'Dewpoint', 17.38, '°C'],
    ['0d120c', 'PM2.5', 3090, 'µg/m³'], ['0e021c', 'PM10', 7170, 'µg/m³'], ['133301', 'TVOC', 307, 'µg/m³'],
    ['14020c', 'Moisture', 30.74, '%'], ['2f23', 'Moisture', 35, '%'], ['3f020c', 'Rotation', 307.4, '°'],
    ['400c00', 'Distance', 12, 'mm'], ['414e00', 'Distance', 7.8, 'm'], ['424e3400', 'Duration', 13.39, 's'],
    ['444e34', 'Speed', 133.9, 'm/s'], ['4632', 'UV index', 5, ''], ['478756', 'Volume', 2215.1, 'L'],
    ['48dc87', 'Volume', 34780, 'mL'], ['49dc87', 'Volume flow rate', 34.78, 'm³/hr'],
    ['4b138a14', 'Gas', 1346.067, 'm³'], ['4c41018a01', 'Gas', 25821.505, 'm³'],
    ['4e87562a01', 'Volume', 19551.879, 'L'], ['4f87562a01', 'Water', 19551.879, 'L'],
    ['518756', 'Acceleration', 22.151, 'm/s²'], ['528756', 'Gyroscope', 22.151, '°/s'],
    ['5587562a01', 'Volume storage', 19551.879, 'L'], ['56e803', 'Conductivity', 1000, 'µS/cm'],
    ['5d02ea', 'Current', -5.63, 'A'], ['5e9f8c', 'Direction', 359.99, '°'], ['5fa00f', 'Precipitation', 400, 'mm'],
    ['61ac0d', 'Rotational speed', 3500, 'rpm'], ['624099dfff', 'Speed', -2.123456, 'm/s'],
    ['630057d0ff', 'Acceleration', -3.123456, 'm/s²'],
  ];
  for (const [hex, label, numericValue, unit] of examples) {
    const result = bthome('40' + hex), field = result.fields.find(item => item.label === label);
    assert.equal(result.protocol, 'bthome'); assert.equal(result.confidence, 'Decoded format', hex);
    assert.equal(field.numericValue, numericValue, hex); assert.equal(field.unit, unit, hex);
    assert.equal(bthome('40' + hex.slice(0, -2)).confidence, 'Malformed frame', hex);
  }
  const repeated = bthome('4002c409022efb').fields.filter(item => item.numericValue !== undefined);
  assert.deepEqual(repeated.map(({ label, numericValue, unit }) => [label, numericValue, unit]), [['Temperature', 25, '°C'], ['Temperature 2', -12.34, '°C']]);
  assert.match(sources.parser.url, /18e1c664c8595ac5f7e2daa63e9a90516ccd3800/);
});

test('BTHome binary object range preserves names and validated 0/1 chart values', () => {
  for (const id of [0x0f, 0x10, 0x11, ...Array.from({ length: 25 }, (_, index) => 0x15 + index)]) {
    const hex = id.toString(16).padStart(2, '0');
    for (const value of [0, 1]) {
      const result = bthome(`40${hex}0${value}`), field = result.fields.at(-1);
      assert.equal(result.confidence, 'Decoded format', hex); assert.equal(field.numericValue, value); assert.equal(field.unit, '');
    }
    assert.equal(bthome(`40${hex}02`).confidence, 'Malformed frame');
  }
});

test('BTHome variable strings, raw bytes, events and device metadata remain nonnumeric', () => {
  const result = bthome('4000093a023b0103053c0103505d396164530ce4bda0e5a5bd20776f726c64540300ff80600164026503f00100f100010204f2000106');
  assert.equal(result.confidence, 'Decoded format');
  assert.deepEqual(fields(result), { 'BTHome version': 2, Encryption: 'Unencrypted', 'Update mode': 'Periodic',
    'Packet ID': 9, Button: 'Double press', Command: 'Step up (arguments 05)', Dimmer: 'Rotate left (3 steps)',
    Timestamp: '2023-05-14T19:41:17.000Z', Text: '你好 world', Raw: '00ff80', Channel: 1,
    'Light level': 'Bright', 'Settings revision': 3, 'Device type ID': 1, 'Firmware version': '4.2.1.0', 'Firmware version 2': '6.1.0' });
  assert.ok(result.fields.every(field => field.numericValue === undefined));
  for (const packet of ['53', '53034142', '5402ff', '3b', '3b0103', '3c01', 'f10001']) assert.equal(bthome('40' + packet).confidence, 'Malformed frame', packet);
  assert.match(bthome('405301ff').limitations[0], /UTF-8/);
  assert.match(bthome('403b2001').limitations[0], /reserved/);
});

test('Ruuvi numeric metadata excludes unavailable readings and measurement sequence', () => {
  const result = ruuvi('0512fc5394c37c0004fffc040cac364200cdcbb8334c884f');
  assert.equal(result.protocol, 'ruuvi');
  assert.deepEqual(result.fields[0], { label: 'Temperature', value: '24.3 °C', numericValue: 24.3, unit: '°C' });
  assert.deepEqual(result.fields.find(field => field.label === 'Measurement sequence'), { label: 'Measurement sequence', value: 205 });
  const unavailable = ruuvi('058000ffffffff800080008000ffffffffffffffffffffff');
  assert.ok(unavailable.fields.every(field => field.numericValue === undefined));
});

test('Authenticated BTHome wrapper exposes readings after official MIC verification', async () => {
  const device = { address: '54:48:e6:8f:80:a5', serviceData: [{ uuid: 'fcd2', hex: '41e445f3c9962b332211006c7c4519' }] };
  const before = JSON.stringify(device), result = await identifyDecrypted(device, '231d39c1d7cc1ab1aee224cd096db932');
  assert.equal(result.authenticated, true); assert.equal(result.counter, 1122867); assert.equal(result.protocol, 'bthome');
  assert.equal(fields(result).Encryption, 'Encrypted'); assert.equal(fields(result).Authentication, 'Verified MIC');
  assert.equal(fields(result).Temperature, '25.06 °C'); assert.equal(result.fields.find(field => field.label === 'Temperature').numericValue, 25.06);
  assert.equal(JSON.stringify(device), before);
  await assert.rejects(identifyDecrypted(device, '00000000000000000000000000000000'), /authentication failed/);
  await assert.rejects(identifyDecrypted({}, '231d39c1d7cc1ab1aee224cd096db932'), /encrypted BTHome/);
});
