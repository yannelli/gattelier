import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { parse } = createRequire(import.meta.url)('../web/pklg.js');
function record(type, payload, { little = false, seconds = 100, micros = 0 } = {}) {
  const header = Buffer.alloc(13), method = little ? 'writeUInt32LE' : 'writeUInt32BE';
  header[method](payload.length + 9, 0); header[method](seconds, 4); header[method](micros, 8); header[12] = type;
  return Buffer.concat([header, payload]);
}
function acl(payload, { handle = 5, boundary = 2 } = {}) {
  const header = Buffer.alloc(4); header.writeUInt16LE(handle | (boundary << 12), 0); header.writeUInt16LE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
function l2cap(att, cid = 4) {
  const header = Buffer.alloc(4); header.writeUInt16LE(att.length, 0); header.writeUInt16LE(cid, 2);
  return Buffer.concat([header, att]);
}
const packet = (type, att, options = {}) => record(type, acl(l2cap(Buffer.from(att)), options), options);
const join = (...records) => Buffer.concat(records);

test('big-endian framing accepts ArrayBuffer and extracts notification handles', () => {
  const buffer = packet(3, [0x1b, 0x34, 0x12, 0xaa, 0xbb]);
  const input = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
  const result = parse(input);
  assert.equal(result.byteOrder, 'big'); assert.equal(result.complete, true);
  assert.equal(result.events[0].handle, 0x1234); assert.equal(result.events[0].hex, 'aabb');
  assert.equal(result.events[0].kind, 'notification'); assert.equal(result.events[0].protocolDirection, 'RX');
  assert.equal(result.events[0].source, 'PacketLogger'); assert.equal(result.events[0].connection, 5);
});

test('little-endian PacketLogger headers are detected without changing ACL byte order', () => {
  const result = parse(packet(2, [0x52, 0x02, 0x01, 0xff], { little: true }));
  assert.equal(result.byteOrder, 'little'); assert.equal(result.events[0].handle, 258);
  assert.equal(result.events[0].kind, 'write'); assert.equal(result.events[0].protocolDirection, 'TX');
  assert.equal(result.events[0].response, false);
});

test('fragmented ACL packets are reassembled per connection and direction', () => {
  const outbound = l2cap(Buffer.from([0x52, 0x08, 0x00, 0x41, 0x42, 0x43]));
  const inbound = l2cap(Buffer.from([0x1b, 0x09, 0x00, 0x44, 0x45]));
  const result = parse(join(
    record(2, acl(outbound.subarray(0, 5))), record(3, acl(inbound.subarray(0, 6))),
    record(2, acl(outbound.subarray(5), { boundary: 1 })), record(3, acl(inbound.subarray(6), { boundary: 1 }))
  ));
  assert.equal(result.events.length, 2); assert.equal(result.complete, true);
  assert.deepEqual(result.events.map(event => [event.handle, event.hex, event.protocolDirection]), [[8, '414243', 'TX'], [9, '4445', 'RX']]);
});

test('read and write responses use the matching request handle in both directions', () => {
  const result = parse(join(packet(2, [0x0a, 0x44, 0]), packet(3, [0x0b, 0x11, 0x22]),
    packet(3, [0x12, 0x55, 0, 0x33]), packet(2, [0x13]), packet(3, [0x1d, 0x66, 0, 0x77])));
  assert.deepEqual(result.events.map(event => [event.kind, event.handle, event.hex]), [
    ['read', 68, ''], ['read', 68, '1122'], ['write', 85, '33'], ['write-result', 85, ''], ['indication', 102, '77']
  ]);
  assert.equal(result.events[3].protocolDirection, 'TX');
});

test('authentication is redacted from events and unique valid keys are returned separately', () => {
  const secret = 'TESTkey123456789';
  const auth = Buffer.concat([Buffer.from([0x52, 8, 0]), Buffer.from(`APP&SK&${secret}`)]);
  const result = parse(join(packet(2, auth), packet(2, auth)));
  assert.deepEqual(result.pocketKeys, [secret]);
  assert.equal(result.counts.redacted, 2); assert.equal(result.counts.pocketKeys, 1);
  assert.equal(result.events.every(event => event.redacted && event.hex === ''), true);
  assert.equal(JSON.stringify(result.events).includes(secret), false);
  assert.equal(result.events[0].length, 23);
  const invalid = parse(packet(2, Buffer.concat([Buffer.from([0x52, 8, 0]), Buffer.from('APP&SK&invalid-key')])));
  assert.deepEqual(invalid.pocketKeys, []); assert.equal(invalid.events[0].redacted, true);
});

test('truncated frames and unfinished reassembly remain incomplete', () => {
  const full = packet(3, [0x1b, 8, 0, 0xaa]);
  const truncated = parse(full.subarray(0, full.length - 1));
  assert.equal(truncated.complete, false); assert.equal(truncated.events.length, 0); assert.equal(truncated.errors.length, 1);
  const body = l2cap(Buffer.from([0x1b, 8, 0, 0xaa]));
  const unfinished = parse(record(3, acl(body.subarray(0, 5))));
  assert.equal(unfinished.complete, false); assert.equal(unfinished.events.length, 0); assert.equal(unfinished.counts.incompletePackets, 1);
  const orphan = parse(record(3, acl(Buffer.from([0xaa]), { boundary: 1 })));
  assert.equal(orphan.complete, false); assert.equal(orphan.events.length, 0);
});

test('malformed ACL and ATT lengths produce errors without exposing partial payloads', () => {
  const badAcl = acl(l2cap(Buffer.from([0x1b, 8, 0, 0xaa]))); badAcl.writeUInt16LE(999, 2);
  const result = parse(record(3, badAcl));
  assert.equal(result.errors.length, 1); assert.equal(result.events.length, 0);
  assert.equal(parse(packet(3, [0x1b, 8])).errors.length, 1);
  assert.equal(parse(new Uint8Array([0, 1])).complete, false);
});

test('other HCI records and L2CAP channels are ignored with a no-ATT warning', () => {
  const result = parse(join(record(1, Buffer.from([1, 2, 3])), record(3, acl(l2cap(Buffer.from([1, 2, 3]), 5)))));
  assert.equal(result.counts.ignoredRecords, 1); assert.equal(result.counts.l2capPackets, 1);
  assert.equal(result.events.length, 0); assert.match(result.warnings.join(' '), /No ATT/);
});

test('ATT errors include the affected handle and read blobs retain offsets', () => {
  const result = parse(join(packet(2, [0x0c, 8, 0, 0x10, 0]), packet(3, [0x0d, 0xaa]), packet(3, [1, 0x12, 8, 0, 5])));
  assert.equal(result.events[1].valueOffset, 16); assert.equal(result.events[1].hex, 'aa');
  assert.equal(result.events[2].handle, 8); assert.equal(result.events[2].success, false);
});

test('characteristic discovery associates 16-bit UUIDs with value handles', () => {
  const result = parse(join(packet(2, [0x08, 1, 0, 0xff, 0xff, 3, 0x28]),
    packet(3, [0x09, 7, 0x10, 0, 8, 0x11, 0, 0xb1, 0x2b, 0x12, 0, 0x10, 0x13, 0, 0xb0, 0x2b]),
    packet(2, [0x12, 0x11, 0, 0xaa]), packet(3, [0x1b, 0x13, 0, 0xbb])));
  assert.equal(result.events[0].uuid, '0x2bb1'); assert.equal(result.events[1].uuid, '0x2bb0');
  assert.equal(result.counts.uuidMappedEvents, 2);
});

test('128-bit characteristic UUIDs and Find Information descriptor UUIDs are mapped', () => {
  const canonical = '001120a2-2233-4455-6677-889912345678';
  const value = Buffer.from(canonical.replaceAll('-', ''), 'hex').reverse();
  const declaration = Buffer.concat([Buffer.from([0x09, 21, 0x10, 0, 8, 0x11, 0]), value]);
  const result = parse(join(packet(2, [8, 1, 0, 0xff, 0xff, 3, 0x28]), packet(3, declaration),
    packet(3, [5, 1, 0x12, 0, 2, 0x29]), packet(2, [0x52, 0x11, 0, 0xaa]), packet(2, [0x12, 0x12, 0, 1, 0])));
  assert.equal(result.events[0].uuid, canonical); assert.equal(result.events[1].uuid, '0x2902');
});

test('separate HCI handles produce separate stream identities and UUID maps', () => {
  const result = parse(join(packet(3, [5, 1, 8, 0, 0xb0, 0x2b], { handle: 0x58 }),
    packet(3, [0x1b, 8, 0, 0xaa], { handle: 0x58 }), packet(3, [0x1b, 8, 0, 0xbb], { handle: 0x59 })));
  assert.notEqual(result.events[0].address, result.events[1].address);
  assert.equal(result.events[0].uuid, '0x2bb0'); assert.equal(result.events[1].uuid, '');
  assert.equal(result.events[0].address, 'HCI 0x0058 / session 1');
});

test('disconnect and connection-complete boundaries clear UUIDs and distinguish handle reuse', () => {
  const disconnect = record(1, Buffer.from([5, 4, 0, 5, 0, 0x13]));
  const complete = record(1, Buffer.from([0x3e, 4, 1, 0, 5, 0]));
  const result = parse(join(packet(3, [5, 1, 8, 0, 0xb0, 0x2b]), packet(3, [0x1b, 8, 0, 0xaa]),
    disconnect, complete, packet(3, [0x1b, 8, 0, 0xbb]), complete, packet(3, [0x1b, 8, 0, 0xcc])));
  assert.deepEqual(result.events.map(event => event.session), [1, 2, 3]);
  assert.deepEqual(result.events.map(event => event.uuid), ['0x2bb0', '', '']);
  assert.equal(new Set(result.events.map(event => event.address)).size, 3);
});

test('disconnect discards unfinished ACL fragments and outstanding request associations', () => {
  const body = l2cap(Buffer.from([0x1b, 8, 0, 0xaa]));
  const result = parse(join(packet(2, [0x0a, 8, 0]), record(3, acl(body.subarray(0, 5))),
    record(1, Buffer.from([5, 4, 0, 5, 0, 0x13])), record(3, acl(body.subarray(5), { boundary: 1 })), packet(3, [0x0b, 0x44])));
  assert.equal(result.events.length, 1); assert.equal(result.events[0].request, true);
  assert.equal(result.counts.incompletePackets, 2); assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /Unmatched ATT read response/);
});

test('imported PLAUD signatures are removed after characteristic discovery', () => {
  const result = parse(join(packet(2, [8, 1, 0, 0xff, 0xff, 3, 0x28]),
    packet(3, [9, 7, 0x10, 0, 8, 0x11, 0, 0xb1, 0x2b]),
    packet(2, [0x52, 0x11, 0, 0x10, 0xfe, 3, 0, 0xaa, 0xbb])));
  assert.equal(result.events[0].hex, ''); assert.equal(result.events[0].redacted, true);
  assert.equal(result.counts.redacted, 1); assert.deepEqual(result.pocketKeys, []);
});
