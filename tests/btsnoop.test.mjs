import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const p = createRequire(import.meta.url)('../web/btsnoop.js');
const epoch = 0x00dcddb30f2f8000n, origin = 1700000000123456n;
function header(linktype = 1002, version = 1) {
  const data = Buffer.alloc(16); data.write('btsnoop\0'); data.writeUInt32BE(version, 8); data.writeUInt32BE(linktype, 12); return data;
}
function record(payload, { flags = 1, time = origin, drops = 0, original = payload.length, included = payload.length } = {}) {
  const data = Buffer.alloc(24); data.writeUInt32BE(original, 0); data.writeUInt32BE(included, 4); data.writeUInt32BE(flags, 8); data.writeUInt32BE(drops, 12); data.writeBigInt64BE(epoch + time, 16);
  return Buffer.concat([data, payload]);
}
function acl(att, { handle = 5, boundary = 2, raw = false } = {}) {
  const value = Buffer.from(att), l2cap = Buffer.alloc(4), hci = Buffer.alloc(4);
  l2cap.writeUInt16LE(value.length); l2cap.writeUInt16LE(4, 2);
  const payload = raw ? value : Buffer.concat([l2cap, value]);
  hci.writeUInt16LE(handle | boundary << 12); hci.writeUInt16LE(payload.length, 2);
  return Buffer.concat([hci, payload]);
}
const packet = (att, options = {}) => record(Buffer.concat([Buffer.of(2), acl(att, options)]), options);
const capture = (...records) => Buffer.concat([header(), ...records]);
const decode = (...records) => p.parse(capture(...records));
const discovery = () => [packet([8, 1, 0, 255, 255, 3, 0x28], { flags: 0 }), packet([9, 7, 0x10, 0, 8, 0x11, 0, 0xb1, 0x2b])];

test('Android H4 import retains exact microseconds, direction and existing event structure', () => {
  const result = decode(packet([0x0a, 0x11, 0], { flags: 0 }), packet([0x0b, 0xaa], { time: origin + 7n }));
  assert.equal(result.complete, true); assert.equal(result.format, 'btsnoop'); assert.equal(result.startedAt, '2023-11-14T22:13:20.123Z');
  assert.equal(result.events[0].source, 'btsnoop'); assert.equal(result.events[0].protocolDirection, 'TX');
  assert.equal(result.events[1].protocolDirection, 'RX'); assert.equal(result.events[1].handle, 17); assert.equal(result.events[1].hex, 'aa');
  assert.equal(result.events[1].ms, 0.007); assert.equal(result.events[1].timestampMicros, (origin + 7n).toString()); assert.equal(result.events[1].elapsedMicros, '7');
  assert.equal(result.metadata.firstTimestampMicros, origin.toString()); assert.equal(result.metadata.linktype, 1002);
  assert.ok(p.sources.every(source => /(?:ebfeca0a62633b4951ff9588dfd4ab272b686239|a0752ed1f75e75ea252d34d7e02a02100205e387)/.test(source.url)));
});

test('unencapsulated H1 derives command/event and ACL types from flags', () => {
  const data = Buffer.concat([header(1001), record(acl([0x52, 8, 0, 0xaa]), { flags: 0 }), record(Buffer.from([5, 4, 0, 5, 0, 0x13]), { flags: 3 }), record(acl([0x1b, 8, 0, 0xbb]), { flags: 1 })]);
  const result = p.parse(data);
  assert.deepEqual(result.events.map(event => [event.kind, event.protocolDirection, event.session]), [['write', 'TX', 1], ['notification', 'RX', 2]]);
  assert.equal(result.metadata.encapsulation, 'HCI unencapsulated (H1)'); assert.equal(result.complete, true);
  const wrapped = Buffer.concat([Buffer.from([1, 2, 3]), data, Buffer.of(4)]), view = wrapped.subarray(3, -1);
  assert.equal(p.parse(view).events.length, 2);
  assert.equal(p.parse(view.buffer.slice(view.byteOffset, view.byteOffset + view.length)).events.length, 2);
});

test('shared decoder retains UUID discovery and authentication redaction', () => {
  const secret = 'TESTkey123456789';
  const result = decode(...discovery(), packet([0x52, 0x11, 0, 0x10, 0xfe, 3, 0, 0xaa], { flags: 0 }), packet(Buffer.concat([Buffer.from([0x52, 9, 0]), Buffer.from(`APP&SK&${secret}`)]), { flags: 0 }));
  assert.equal(result.events[0].uuid, '0x2bb1'); assert.equal(result.events[0].redacted, true); assert.equal(result.events[0].hex, '');
  assert.equal(result.events[1].redacted, true); assert.deepEqual(result.pocketKeys, [secret]); assert.equal(result.counts.redacted, 2);
  assert.equal(JSON.stringify(result.events).includes(secret), false);
});

test('ACL fragments reassemble across records with original first-fragment timestamp', () => {
  const body = Buffer.from([5, 0, 4, 0, 0x1b, 8, 0, 0xaa, 0xbb]);
  const result = decode(packet(body.subarray(0, 6), { raw: true }), packet(body.subarray(6), { raw: true, boundary: 1, time: origin + 20n }));
  assert.equal(result.events[0].hex, 'aabb'); assert.equal(result.events[0].timestampMicros, origin.toString()); assert.equal(result.complete, true);
});

test('cumulative drops invalidate outstanding requests, UUID maps and session identity', () => {
  const result = decode(...discovery(), packet([0x1b, 0x11, 0, 1]), packet([0x0a, 0x11, 0], { flags: 0 }), packet([0x0b, 2], { drops: 3 }), packet([0x1b, 0x11, 0, 3], { drops: 3 }));
  assert.deepEqual(result.events.filter(event => event.kind === 'notification').map(event => [event.uuid, event.session]), [['0x2bb1', 1], ['', 2]]);
  assert.equal(result.events.filter(event => event.kind === 'read').length, 1); assert.match(result.warnings.join(' '), /Unmatched ATT read response/);
  assert.equal(result.metadata.observedDrops, 3); assert.equal(result.metadata.cumulativeDrops, 3); assert.equal(result.complete, false);
  const reset = decode(packet([0x1b, 8, 0, 1], { drops: 5 }), packet([0x1b, 8, 0, 2], { drops: 1 }), packet([0x1b, 8, 0, 3], { drops: 4 }));
  assert.equal(reset.metadata.dropCounterResets, 1); assert.equal(reset.metadata.observedDrops, 8); assert.equal(reset.metadata.cumulativeDrops, 4);
});

test('snaplen truncation skips the partial packet and prevents continuation across gaps', () => {
  const body = Buffer.from([5, 0, 4, 0, 0x1b, 8, 0, 0xaa, 0xbb]);
  const result = decode(packet(body.subarray(0, 6), { raw: true }), record(Buffer.from([2, 1]), { original: 10 }), packet(body.subarray(6), { raw: true, boundary: 1 }));
  assert.equal(result.events.length, 0); assert.equal(result.metadata.truncatedRecords, 1); assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /continuation without a start/);
  const full = capture(packet([0x1b, 8, 0, 1]));
  const partial = p.parse(full.subarray(0, -1)); assert.equal(partial.events.length, 0); assert.equal(partial.metadata.truncatedRecords, 1); assert.equal(partial.errors.length, 1);
  assert.equal(p.parse(Buffer.concat([header(), Buffer.of(0, 1)])).complete, false);
});

test('disconnect, connection-complete and controller reset establish fresh sessions', () => {
  const reset = record(Buffer.from([1, 3, 0x0c, 0]), { flags: 2 });
  const disconnect = record(Buffer.from([4, 5, 4, 0, 5, 0, 0x13]), { flags: 3 });
  const connected = record(Buffer.from([4, 0x3e, 4, 1, 0, 5, 0]), { flags: 3 });
  const result = decode(...discovery(), packet([0x1b, 0x11, 0, 1]), reset, packet([0x1b, 0x11, 0, 2]), disconnect, connected, packet([0x1b, 0x11, 0, 3]));
  assert.deepEqual(result.events.map(event => event.session), [1, 2, 3]); assert.deepEqual(result.events.map(event => event.uuid), ['0x2bb1', '', '']);
});

test('clock regression preserves raw timestamp precision and clears UUID context', () => {
  const result = decode(...discovery(), packet([0x1b, 0x11, 0, 1]), packet([0x1b, 0x11, 0, 2], { time: origin - 1n }));
  assert.equal(result.metadata.timeRegressions, 1); assert.equal(result.events[1].timestampMicros, (origin - 1n).toString()); assert.equal(result.events[1].ms, -0.001);
  assert.equal(result.events[1].uuid, ''); assert.notEqual(result.events[0].session, result.events[1].session);
  assert.equal(decode(packet([0x1b, 8, 0, 1], { time: -1n })).startedAt, '1969-12-31T23:59:59.999Z');
});

test('invalid lengths, timestamps, H4 types and directions fail without partial events', () => {
  for (const options of [{ original: 1, included: 2 }, { original: 65541 }, { flags: 4 }, { time: 9000000000000000000n }]) {
    const result = decode(record(Buffer.of(2, 0), options)); assert.equal(result.complete, false); assert.equal(result.events.length, 0); assert.ok(result.errors.length);
  }
  for (const [data, flags] of [[Buffer.from([99, 0]), 1], [Buffer.from([4, 5, 4, 0]), 3], [Buffer.from([1, 3, 0x0c, 0]), 3], [Buffer.from([4, 0x10, 0]), 0]]) {
    const result = decode(record(data, { flags })); assert.equal(result.complete, false); assert.equal(result.events.length, 0);
  }
  const result = decode(packet([0x0a, 8, 0], { flags: 0 }), packet([0x1b, 8]), packet([0x0b, 0xaa]));
  assert.equal(result.events.length, 1); assert.match(result.warnings.join(' '), /Unmatched/);
});

test('discovery replies after a gap require their matching request', () => {
  const result = decode(packet([4, 1, 0, 255, 255], { flags: 0 }), packet([5, 1, 8, 0, 0xb1, 0x2b], { drops: 1 }), packet([0x1b, 8, 0, 0xaa], { drops: 1 }));
  assert.equal(result.events[0].uuid, ''); assert.match(result.warnings.join(' '), /Unmatched ATT Find Information/);
  const valid = decode(packet([4, 1, 0, 255, 255], { flags: 0 }), packet([5, 1, 8, 0, 0xb1, 0x2b]), packet([0x1b, 8, 0, 0xaa]));
  assert.equal(valid.events[0].uuid, '0x2bb1');
});

test('format detection rejects unsupported files and diagnostics remain bounded', () => {
  assert.equal(p.matches(header()), true); assert.equal(p.matches(Buffer.from('btsnooz')), false);
  for (const [input, message] of [[Buffer.from('btsnooz compressed'), /uncompressed.*btsnooz/], [Buffer.from('btsnoop\0'), /Truncated/], [header(2001), /linktype 2001/], [header(1002, 2), /version 2/]]) assert.throws(() => p.parse(input), message);
  assert.throws(() => p.parse('btsnoop'), /ArrayBuffer/);
  const result = decode(...Array.from({ length: 1000 }, () => record(Buffer.of(99))));
  assert.equal(result.counts.records, 1000); assert.equal(result.counts.malformedPackets, 1000); assert.equal(result.complete, false);
  assert.ok(result.errors.length + result.warnings.length <= 201); assert.match(result.warnings.at(-1), /diagnostics omitted/);
});
