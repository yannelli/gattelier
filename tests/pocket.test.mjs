import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const p = require('../web/pocket-protocol.js');

test('Pocket replies split concatenated frames and preserve opaque recording names', () => {
  const replies = p.messages(p.encode('MCU&F&2026-10-25&PH261025140000&45MCU&LIST&1\0'));
  assert.deepEqual(p.listing(replies), { files: [{ date: '2026-10-25', name: 'PH261025140000', seconds: 45 }], complete: true });
});
test('truncated and malformed directory lists do not become complete', () => {
  assert.equal(p.listing(['MCU&F&2026-10-25&recording&45']).complete, false);
  assert.equal(p.listing(['MCU&F&2026-10-25&../other&45', 'MCU&LIST&1']).complete, false);
  assert.equal(p.listing(['MCU&LIST&0']).complete, true);
});
test('recording bytes need an exact announced size and no capture gaps', () => {
  const transfer = new p.Transfer();
  transfer.append('4944'); assert.equal(transfer.complete, false);
  transfer.announce('3'); transfer.append('33'); assert.equal(transfer.complete, true);
  transfer.lost++; assert.equal(transfer.complete, false);
});
test('excess bytes and truncated packets fail transfer integrity', () => {
  const transfer = new p.Transfer(); transfer.announce('2'); transfer.append('000102');
  assert.equal(transfer.complete, false); assert.ok(transfer.error);
  const clipped = new p.Transfer(); clipped.announce('1'); clipped.append('00', true);
  assert.equal(clipped.complete, false);
});
test('handles are discovered by UUID instead of hardcoded connection handles', () => {
  const state = { services: [{ uuid: p.uuid('a0'), characteristics: [
    { uuid: p.uuid('a2'), handle: 99 }, { uuid: p.uuid('a1'), handle: 3 }, { uuid: p.uuid('a3'), handle: 2 }
  ] }] };
  assert.deepEqual(p.handles(state), { command: 99, response: 2, audio: 3 });
});
