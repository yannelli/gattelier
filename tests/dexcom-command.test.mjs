import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), c = require('../web/dexcom-commands.js'), p = require('../web/dexcom-protocol.js');

test('G7 read commands preserve native current/backfill framing and identity CRC', () => {
  assert.equal(p.hex(c.current()), '4e'); assert.equal(p.hex(c.identity()), '4a8ee9');
  const request = c.history(20000, 3);
  assert.equal(request.start, 9200); assert.equal(request.end, 20000);
  assert.equal(p.hex(request.bytes), '59f0230000204e0000');
  assert.equal(c.history(100, 24).start, 1);
  for (const hours of [0, -1, 25, NaN, Infinity]) assert.throws(() => c.history(100, hours), /window/);
  for (const clock of [0, -1, 1.5, 2 ** 32]) assert.throws(() => c.history(clock, 3), /current/);
  assert.throws(() => c.history(1, 3), /earlier/);
});

test('certificate framing uses u32LE outgoing length and bounded peer u16LE length', () => {
  assert.equal(p.hex(c.certificate(1, 1024)), '0b0100040000');
  assert.equal(c.certificateSize(p.bytes('0b0001cd010000'), 1), 461);
  for (const input of ['0b0002cd010000', '0b0101cd010000', '0b000100000000', '0b000101100000', '0b0001cd01']) assert.throws(() => c.certificateSize(p.bytes(input), 1));
});
