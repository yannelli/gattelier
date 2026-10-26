import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { delta, previous, filter } = createRequire(import.meta.url)('../web/analysis.js');
test('byte differences preserve offsets, length changes and changed bits', () => {
  assert.deepEqual(delta('0001ff', '0002'), [{ offset: 1, before: '01', after: '02', mask: '03' }, { offset: 2, before: 'ff', after: '—', mask: null }]);
  assert.deepEqual(delta('', 'aa'), [{ offset: 0, before: '—', after: 'aa', mask: null }]);
  assert.deepEqual(delta('AB00', 'ab00'), []);
  assert.throws(() => delta('f', 'ff')); assert.throws(() => delta('gg', '00'));
});
test('comparison stays within one boot, device, handle and direction', () => {
  const base = { bootId: 'a', address: 'one', handle: 12, kind: 'notification', hex: '00', seq: 1 };
  const events = [base, { ...base, seq: 2, kind: 'write' }, { ...base, seq: 3, bootId: 'b' }, { ...base, seq: 4, address: 'two' }, { ...base, seq: 5, truncated: true }];
  assert.equal(previous(events, { ...base, seq: 6 }), base);
  assert.equal(previous(events, base), null);
});
test('direction and UUID filtering combine without changing source', () => {
  const events = [{ kind: 'read', uuid: '0x2a19' }, { kind: 'write', uuid: '0x2a19' }, { kind: 'connect' }];
  assert.deepEqual(filter(events, 'RX', '2a19'), [events[0]]);
  assert.deepEqual(filter(events, 'EVENT', ''), [events[2]]);
  assert.equal(events.length, 3);
});
