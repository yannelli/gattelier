import test from 'node:test';
import assert from 'node:assert/strict';
import sensors from '../web/sensor-profiles.js';
import historyModule from '../web/sensor-history.js';

const format6 = '06170c5668c79e007000c90501d9ffcd004c884f';
const formatE1 = 'e1170c5668c79e0065007004bd11ca00c90a0213e0acffffffdecdee01ffffffffffcbb8334c884f';
const identify = hex => sensors.identify({ manufacturer: '9904' + hex });
const fields = profile => Object.fromEntries(profile.fields.map(field => [field.label, field.value]));

test('Ruuvi Air format 6 matches the published example and chart units', () => {
  const profile = identify(format6), values = fields(profile);
  assert.equal(profile.title, 'Ruuvi Air · format 6'); assert.equal(profile.protocol, 'ruuvi');
  assert.deepEqual(values, { Temperature: '29.5 °C', Humidity: '55.3 %', Pressure: '101102 Pa', 'PM2.5': '11.2 µg/m³', CO2: '201 ppm', 'VOC index': 10, 'NOX index': 2, Illuminance: '13026.67 lx', 'Measurement sequence': 205, Calibration: 'Complete', 'Sensor MAC suffix': '4c:88:4f' });
  assert.deepEqual(profile.fields.find(field => field.label === 'PM2.5'), { label: 'PM2.5', value: '11.2 µg/m³', numericValue: 11.2, unit: 'µg/m³' });
});
test('Ruuvi Air E1 decodes complete extended advertisements', () => {
  const profile = identify(formatE1), values = fields(profile);
  assert.equal(profile.confidence, 'Decoded format'); assert.equal(values['PM1'], '10.1 µg/m³');
  assert.equal(values['PM2.5'], '11.2 µg/m³'); assert.equal(values['PM4'], '121.3 µg/m³'); assert.equal(values['PM10'], '455.4 µg/m³');
  assert.equal(values.Illuminance, '13027 lx'); assert.equal(values['VOC index'], 20); assert.equal(values['NOX index'], 4);
  assert.equal(values['Measurement sequence'], 14601710); assert.equal(values.Calibration, 'In progress'); assert.equal(values['Sensor MAC'], 'cb:b8:33:4c:88:4f');
  assert.match(profile.limitations[0], /Calibration/);
});
test('Air flags contribute low bits to gas indexes and preserve format-6 sequence 255', () => {
  for (const [source, offset, flagsAt] of [[format6, 11, 16], [formatE1, 17, 28]]) {
    const data = Buffer.from(source, 'hex'); data[offset] = 0x74; data[offset + 1] = 0x02; data[flagsAt] = 0xc1;
    const values = fields(identify(data.toString('hex')));
    assert.equal(values['VOC index'], 233); assert.equal(values['NOX index'], 5); assert.equal(values.Calibration, 'In progress');
  }
  const data = Buffer.from(format6, 'hex'); data[15] = 255;
  assert.equal(fields(identify(data.toString('hex')))['Measurement sequence'], 255);
});
test('unavailable Air readings stay out of charts and history', () => {
  for (const [format, length, flagsAt] of [[6, 20, 16], [0xe1, 40, 28]]) {
    const data = Buffer.alloc(length, 255); data[0] = format; data.writeInt16BE(-32768, 1); data[flagsAt] = 0xfe;
    const profile = identify(data.toString('hex'));
    assert.equal(profile.confidence, 'Decoded format'); assert.ok(profile.fields.every(field => field.numericValue === undefined));
    assert.equal(fields(profile).Calibration, 'Complete');
    const history = historyModule.create({ now: () => 1000, storage: null });
    assert.equal(history.ingest({ address: '02:00:00:00:00:01', addressType: 0, lastSeenMs: 1000 }, profile), false);
  }
});
test('Air rejects incomplete and oversized payloads without partial readings', () => {
  for (const source of [format6, formatE1]) {
    for (const packet of [source.slice(0, 2), source.slice(0, -2), source + '00']) {
      const profile = identify(packet); assert.equal(profile.confidence, 'Malformed frame'); assert.deepEqual(profile.fields, []);
    }
    const truncated = sensors.identify({ manufacturer: '9904' + source, payloadTruncated: true });
    assert.equal(truncated.confidence, 'Malformed frame'); assert.deepEqual(truncated.fields, []);
  }
  assert.equal(sensors.identify({ manufacturer: '0499' + format6 }), null);
});
test('Air signed temperatures and logarithmic light endpoints preserve precision', () => {
  const data = Buffer.from(format6, 'hex'); data.writeInt16BE(-451, 1); data[13] = 0;
  assert.equal(fields(identify(data.toString('hex'))).Temperature, '-2.255 °C');
  assert.equal(fields(identify(data.toString('hex'))).Illuminance, '0 lx');
  data[13] = 254; assert.equal(fields(identify(data.toString('hex'))).Illuminance, '65535 lx');
});
