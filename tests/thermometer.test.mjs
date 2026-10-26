import test from 'node:test';
import assert from 'node:assert/strict';
import gatt from '../web/gatt-values.js';

test('health thermometer FLOAT values use signed mantissa, exponent and unit flags', () => {
  assert.deepEqual(gatt.decode('2a1c', '006d0100ff'), [{ label: 'Temperature measurement', value: '36.5 °C' }]);
  assert.equal(gatt.decode('2a1e', '01da0300ff')[0].value, '98.6 °F');
  assert.equal(gatt.decode('2a1c', '0083fffffe')[0].value, '-1.25 °C');
  assert.equal(gatt.decode('2a1c', '00ffff7f00')[0].value, 'Not a number');
});
test('temperature optional timestamp and location require complete fields', () => {
  const fields = gatt.decode('2a1c', '066d0100ffea070a190c223806');
  assert.equal(fields[1].value, '2026-10-25 12:34:56'); assert.equal(fields[2].value, 'Mouth');
  for (const value of ['066d0100ff', '086d0100ff', '006d0100ff00', '026d0100ffea070d190c2238']) assert.deepEqual(gatt.decode('2a1c', value), []);
});
test('thermometer interval, location, pressure and device name decode without changing settings', () => {
  assert.equal(gatt.decode('2a21', '3c00')[0].value, '60 seconds');
  assert.equal(gatt.decode('2a1d', '03')[0].value, 'Ear');
  assert.equal(gatt.decode('2a6d', '02200700')[0].value, '46694.6 Pa');
  assert.equal(gatt.decode('2a00', '426564')[0].value, 'Bed');
});
