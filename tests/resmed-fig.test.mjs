import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url), p = require('../web/resmed-fig.js');
const fixture = {
  request: 'bebafeca93035b0069f773b29bab54447b226a736f6e727063223a22322e30222c226d6574686f64223a225265717565737453657373696f6e222c226964223a372c22706172616d73223a7b22636c69656e744964223a225055424c49432d53594e544845544943227d7d',
  notification: 'bebafeca92032600a97a921130e358a87b226a736f6e727063223a22322e30222c226d6574686f64223a22486561727442656174227d',
  version: 'bebafeca9203dc00ccbd51037eab27977b226a736f6e727063223a22322e30222c226964223a392c22726573756c74223a7b22466c6f7747656e657261746f72223a7b224964656e74696669636174696f6e50726f66696c6573223a7b22536f667477617265223a7b224170706c69636174696f6e4964656e746966696572223a2253594e5448455449432d312e30227d2c224861726477617265223a7b2248617264776172654964656e746966696572223a225055424c49432d54455354227d7d2c22525043223a7b2247657456657273696f6e223a22322e30222c22476574223a22312e30227d7d7d7d',
  state: 'bebafeca92034a00cad1ce650061b66a7b226a736f6e727063223a22322e30222c226964223a31302c22726573756c74223a7b22446576696365436f6e74726f6c223a7b2246475374617465223a225374616e646279227d7d7d',
  error: 'bebafeca92034e0006efdb0aef20f1097b226a736f6e727063223a22322e30222c226964223a31312c226572726f72223a7b22636f6465223a2d33323630312c226d657373616765223a224d6574686f64204e6f7420466f756e64227d7d',
  ncp: 'bebafeca90030b000bca454a9f06b341020086070500fd08aabbcc',
  unknown: 'bebafeca777704001386b98b493b909900010203',
  encrypted: 'bebafeca960320008a7e2691474ed422000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  wrongenc: 'bebafeca9603370010506342602efd4e7b226a736f6e727063223a22322e30222c226964223a312c22726573756c74223a7b2246475374617465223a225374616e646279227d7d',
};
const fields = values => Object.fromEntries(values.map(item => [item.label, item.value]));

test('documented service and ResMed prefix produce conservative model candidates', () => {
  for (const value of ['fd56', '0xfd56', p.service.toUpperCase()]) {
    const profile = p.identify({ services: [value] });
    assert.equal(profile.confidence, 'Service match'); assert.equal(profile.category, 'medical');
    assert.match(profile.limitations.join(' '), /does not establish the device model/);
    assert.match(profile.limitations.join(' '), /fresh AES-256 session/);
  }
  assert.equal(p.identify({ name: 'ResMed_SYNTHETIC' }).confidence, 'Name candidate');
  assert.equal(p.manufacturer, false); assert.equal(p.captureLabel, 'FIG capture HEX');
  for (const device of [null, {}, { services: 'fd56' }, { name: 'Some ResMed device' }, { services: ['a6220001-35f1-4b20-afae-cb089d2044aa'] }]) assert.equal(p.identify(device), null);
  assert.ok(p.sources.every(item => item.url.includes('/d6474221a1940970c1eaa3878618a9dd1813dba9/')));
});

test('synthetic FIG packets expose verified CRCs, VCIDs, lengths and JSON message roles', () => {
  const report = p.inspect(fixture.request + fixture.notification + fixture.version + fixture.error);
  assert.equal(report.complete, true); assert.equal(report.pendingBytes, 0); assert.deepEqual(report.issues, []); assert.equal(report.frames.length, 4);
  const [request, notification, reply, error] = report.frames;
  assert.equal(request.vcid, '0x0393'); assert.equal(request.direction, 'Host to device'); assert.equal(request.payloadLength, 91);
  assert.equal(request.role, 'Request'); assert.equal(request.rpc.id, 7); assert.equal(request.rpc.method, 'RequestSession');
  assert.equal(notification.role, 'Notification'); assert.equal(notification.rpc.method, 'HeartBeat');
  assert.equal(reply.role, 'Reply'); assert.equal(reply.rpc.id, 9);
  assert.equal(fields(reply.fields)['FlowGenerator Software'], '{"ApplicationIdentifier":"SYNTHETIC-1.0"}');
  assert.equal(fields(reply.fields)['Advertised RPC capabilities'], '{"GetVersion":"2.0","Get":"1.0"}');
  assert.equal(error.role, 'Error reply'); assert.match(fields(error.fields)['RPC error'], /Method Not Found/);
  assert.equal(fields(p.inspect(fixture.state).frames[0].fields).DeviceControl, '{"FGState":"Standby"}');
});

test('FIG fragments are retained at each boundary and emitted only after the complete payload', () => {
  for (let split = 1; split < fixture.request.length / 2; split++) {
    const decoder = p.createDecoder(), first = decoder.feed(fixture.request.slice(0, split * 2));
    assert.equal(first.frames.length, 0); assert.equal(first.complete, false); assert.equal(first.pendingBytes, split);
    assert.equal(first.pendingHex, fixture.request.slice(0, split * 2));
    const final = decoder.feed(fixture.request.slice(split * 2));
    assert.equal(final.frames.length, 1); assert.equal(final.complete, true); assert.equal(final.frames[0].rpc.id, 7);
  }
  const decoder = p.createDecoder(); decoder.feed('bebafe'); decoder.reset();
  assert.equal(decoder.feed(fixture.notification).frames.length, 1);
  const partial = p.inspect(fixture.request.slice(0, 60)); assert.equal(partial.expectedBytes, 107);
  const imported = fields(p.decode(p.characteristics.rx, fixture.request.slice(0, 60)));
  assert.equal(imported['Retained fragment bytes'], '30'); assert.equal(imported['Incomplete prefix HEX'], fixture.request.slice(0, 60));
});

test('CRC failures and damaged lengths do not expose unverified RPC payloads', () => {
  const damagedHeader = Buffer.from(fixture.version, 'hex'); damagedHeader[6] ^= 1;
  const damagedPayload = Buffer.from(fixture.version, 'hex'); damagedPayload[20] ^= 1;
  for (const [frame, expected] of [[damagedHeader, /header CRC32/], [damagedPayload, /payload CRC32/]]) {
    const report = p.inspect(frame.toString('hex') + fixture.notification);
    assert.equal(report.frames.length, 1); assert.equal(report.frames[0].rpc.method, 'HeartBeat');
    assert.match(report.issues.join(' '), expected);
    assert.equal(report.frames.some(frame => frame.rpc?.result), false);
  }
  const truncated = p.inspect(fixture.version.slice(0, -2));
  assert.equal(truncated.frames.length, 0); assert.equal(truncated.complete, false); assert.equal(truncated.expectedBytes, 236);
  const noise = p.inspect('010203' + fixture.notification + 'ffbeba');
  assert.equal(noise.frames.length, 1); assert.equal(noise.pendingHex, 'beba'); assert.match(noise.issues.join(' '), /Discarded/);
});

test('unknown FIG lanes and encrypted session payloads retain opaque original bytes', () => {
  const unknown = p.inspect(fixture.unknown).frames[0];
  assert.equal(unknown.encoding, 'Unknown VCID'); assert.equal(unknown.payloadHex, '00010203'); assert.equal(unknown.rpc, undefined);
  const encrypted = p.inspect(fixture.encrypted).frames[0];
  assert.equal(encrypted.encrypted, true); assert.equal(encrypted.ivHex, '000102030405060708090a0b0c0d0e0f');
  assert.equal(encrypted.ciphertextHex, '101112131415161718191a1b1c1d1e1f'); assert.equal(encrypted.rpc, undefined);
  assert.match(encrypted.issues.join(' '), /not session authentication/);
  const looksLikeJSON = p.inspect(fixture.wrongenc).frames[0];
  assert.equal(looksLikeJSON.rpc, undefined); assert.deepEqual(looksLikeJSON.fields, []); assert.match(looksLikeJSON.issues.join(' '), /length/);
});

test('plaintext NCP records expose command IDs, echoed tags and exact record completeness', () => {
  const frame = p.inspect(fixture.ncp).frames[0];
  assert.deepEqual(frame.records, [
    { length: 2, command: '0x0086', role: 'Reply', tag: 7, method: 'GetVersion', suppressReply: false, bodyHex: '' },
    { length: 5, command: '0x00fd', role: 'Error reply', tag: 8, method: 'Unknown command', suppressReply: false, bodyHex: 'aabbcc' },
  ]);
  assert.deepEqual(frame.issues, []);
  assert.equal(fields(p.decode(p.characteristics.rx, fixture.ncp))['Frame 1 NCP records'], JSON.stringify(frame.records));
  for (const hex of ['bebafeca90030300309558fa4f4d27d9010086', 'bebafeca90030600b1edf35d2367ac83060086070102', 'bebafeca90030500582fbb5137d0720d0100860700']) {
    const invalid = p.inspect(hex).frames[0]; assert.deepEqual(invalid.records, []); assert.match(invalid.issues.join(' '), /NCP record/);
  }
});

test('explicit plaintext JSON inspection preserves documented fields and rejects invalid envelopes', () => {
  const reply = p.decodePlaintext('{"jsonrpc":"2.0","id":2,"result":{"IdentificationProfiles":{"Product":{"SerialNumber":"SYNTHETIC"}},"FGState":"Standby","dateTime":"2026-08-12T14:25:31.000Z"}}');
  assert.equal(fields(reply.fields).FGState, 'Standby'); assert.match(fields(reply.fields).IdentificationProfiles, /SYNTHETIC/);
  for (const value of ['[]', '{}', '{"jsonrpc":"2.0","id":{},"result":1}', '{"jsonrpc":"2.0","id":1,"result":1,"error":{}}', '{"jsonrpc":"2.0","method":"Get","id":1,"result":{}}', '{']) assert.throws(() => p.decodePlaintext(value));
  for (const value of ['0', 'zz', '00'.repeat(262145)]) assert.throws(() => p.inspect(value), /hexadecimal/);
  assert.deepEqual(p.decode('00002a19-0000-1000-8000-00805f9b34fb', fixture.request), []);
  assert.equal(fields(p.decode(p.characteristics.tx, fixture.request))['Frame 1 RPC message ID'], '7');
  const unencryptedApplication = p.inspect('bebafeca93032e008b89ff688d1792cc7b226a736f6e727063223a22322e30222c226d6574686f64223a2247657456657273696f6e222c226964223a317d').frames[0];
  assert.match(unencryptedApplication.issues.join(' '), /requires an encrypted session/);
  assert.match(p.inspect('bebafeca93030100000000ffce4a9b13ff').frames[0].issues.join(' '), /JSON decode failed/);
});

test('offline request previews use documented JSON contracts and preserve omitted parameters', () => {
  const expected = [
    ['get-version', { jsonrpc: '2.0', method: 'GetVersion', id: 7 }],
    ['get-identity', { jsonrpc: '1.0', method: 'Get', id: 7, params: ['IdentificationProfiles'] }],
    ['get-state', { jsonrpc: '1.0', method: 'Get', id: 7, params: ['DeviceControl'] }],
    ['get-date-time', { jsonrpc: '1.0', method: 'GetDateTime', id: 7 }],
  ];
  for (const [id, request] of expected) {
    const plan = p.buildCommand(id, { rpcId: '7', device: { services: ['fd56'] } });
    assert.deepEqual(plan.request, request); assert.equal(plan.offlineOnly, true); assert.equal(plan.requiresAuthentication, true);
    assert.equal(plan.frameTemplate.requestVCID, '0x0397'); assert.equal(plan.frameTemplate.replyVCID, '0x0396');
    assert.equal(plan.steps, undefined); assert.equal(plan.hex, undefined); assert.equal(plan.stockBLEPermitted, true);
    assert.deepEqual(JSON.parse(Buffer.from(plan.applicationPayloadHex, 'hex').toString()), request);
    const prefixed = Buffer.from(plan.plaintextLengthPrefixedHex, 'hex'), length = prefixed.readUInt16LE(0);
    assert.equal(prefixed.length % 16, 0); assert.equal(length, Buffer.from(plan.applicationPayloadHex, 'hex').length);
    assert.deepEqual(JSON.parse(prefixed.subarray(2, 2 + length).toString()), request);
    assert.ok(prefixed.subarray(2 + length).every(byte => byte === 0));
  }
  assert.equal(Object.hasOwn(p.buildCommand('get-version').request, 'params'), false);
  for (const rpcId of [0, -1, 1.5, '', true, '01', 2147483648]) assert.throws(() => p.buildCommand('get-version', { rpcId }), /message ID/);
  assert.throws(() => p.buildCommand('get-version', { device: { name: 'Unrelated' } }), /candidate/);
  assert.throws(() => p.buildCommand('enter-therapy'), /Unsupported/);
});

test('documented writable clock template reports stock BLE permission denial', () => {
  const plan = p.buildCommand('set-date-time', { dateTime: '2026-08-12T14:25:31.000Z' });
  assert.deepEqual(plan.request, { jsonrpc: '1.1', method: 'SetDateTime', id: 1, params: { dateTime: '2026-08-12T14:25:31.000Z' } });
  assert.equal(plan.stockBLEPermitted, false); assert.equal(plan.steps, undefined); assert.match(plan.warnings.join(' '), /stock BLE rejects/);
  for (const dateTime of ['', '2026-02-30T14:25:31.000Z', '2026-08-12T25:25:31.000Z', '2026-08-12', null]) assert.throws(() => p.buildCommand('set-date-time', { dateTime }), /valid UTC timestamp/);
});

test('capture inspection and every request preview run with all network/device APIs trapped', () => {
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('Device or network access forbidden'); };
  const context = vm.createContext({ module: { exports: {} }, TextDecoder, TextEncoder, fetch: forbidden, WebSocket: forbidden, XMLHttpRequest: forbidden, navigator: { bluetooth: { requestDevice: forbidden }, serial: { requestPort: forbidden } } });
  vm.runInContext(readFileSync(new URL('../web/resmed-fig.js', import.meta.url), 'utf8'), context);
  const offline = context.module.exports;
  offline.inspect(fixture.version); offline.decode(offline.characteristics.rx, fixture.encrypted);
  for (const command of offline.commands) offline.buildCommand(command.id, { dateTime: '2026-08-12T14:25:31.000Z' });
  assert.equal(calls, 0);
});
