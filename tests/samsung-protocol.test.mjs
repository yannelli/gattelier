import test from 'node:test';
import assert from 'node:assert/strict';
import samsung from '../web/samsung-protocol.js';

const values = result => Object.fromEntries(result.fields.map(field => [field.label, field.value]));
const frame = (first = 0x12, flags = 0xaf, motion = 0x80, activity = 1) => Buffer.from([
  first, 0x56, 0x34, 0x12, 0, 1, 2, 3, 4, 5, 6, 7, flags, motion, 0, activity, 0xaa, 0xbb, 0xcc, 0xdd
]).toString('hex');
const device = hex => ({ serviceData: [{ uuid: samsung.service, hex }] });

test('observed Samsung prefix preserves bytes without inventing a television identity or status', () => {
  const manufacturer = '7500420401806e02000000000102000000000201000000000000';
  const result = samsung.identify({ manufacturer });
  assert.equal(result.title, 'Samsung BLE broadcast');
  assert.equal(result.confidence, 'Manufacturer match');
  assert.equal(values(result)['Manufacturer payload prefix'], '42040180');
  assert.equal(values(result)['Manufacturer payload HEX'], manufacturer.slice(4));
  assert.equal(values(result)['Manufacturer frame length'], '26 bytes');
  assert.equal(values(result)['Battery band'], undefined);
  assert.equal(samsung.commands.length, 0);
  assert.equal(samsung.buildCommand, undefined);
});

test('FD5A registered-tag format decodes status, coarse battery, counters and flags', () => {
  const result = samsung.identify(device(frame()));
  const fields = values(result);
  assert.equal(result.title, 'Samsung Offline Finding');
  assert.equal(result.confidence, 'Decoded broadcast');
  assert.equal(fields['Offline Finding version'], '1');
  assert.equal(fields['Reported tag state'], 'Offline');
  assert.equal(fields['Aging counter (raw)'], String(0x123456));
  assert.equal(fields['Rotating privacy ID'], '0001020304050607');
  assert.equal(fields['Region code'], '10');
  assert.equal(fields['Battery band'], 'Full');
  assert.equal(fields['UWB flag'], 'Yes');
  assert.equal(fields['Encryption flag'], 'Yes');
  assert.equal(fields['Motion detection flag'], 'Yes');
  assert.equal(fields['Activity tracking flag'], 'Yes');
  assert.equal(fields['Signature HEX (unverified)'], 'aabbccdd');
  assert.equal(fields['Battery percentage'], undefined);
});

test('all battery bands and state bits follow the supported field masks', () => {
  for (const [band, name] of ['Very low', 'Low', 'Medium', 'Full'].entries()) {
    const fields = values(samsung.decodeServiceData(frame(0x1d, band, 0x7f, 0xfe)));
    assert.equal(fields['Battery band'], name);
    assert.equal(fields['Reported tag state'], 'Connected to a non-owner');
    assert.equal(fields['Advertisement type bit'], '1');
    assert.equal(fields['UWB flag'], 'No');
    assert.equal(fields['Encryption flag'], 'No');
    assert.equal(fields['Motion detection flag'], 'No');
    assert.equal(fields['Activity tracking flag'], 'No');
  }
  assert.equal(values(samsung.decodeServiceData(frame(0x17)))['Reported tag state'], 'Unrecognized (7)');
});

test('unsupported versions and lengths retain raw data without decoding status', () => {
  for (const hex of [frame(0x22), frame().slice(0, -2), frame() + '00', '', '12']) {
    const result = samsung.decodeServiceData(hex);
    assert.equal(result.decoded, false);
    assert.equal(values(result)['Offline Finding frame HEX'], hex);
    assert.equal(values(result)['Battery band'], undefined);
    assert.ok(result.limitations.length);
  }
});

test('truncated observations suppress status and a service UUID alone stays a candidate', () => {
  const result = samsung.identify({ ...device(frame()), payloadTruncated: true });
  assert.equal(values(result)['Battery band'], undefined);
  assert.equal(result.confidence, 'Service match');
  assert.equal(values(result)['Offline Finding frame HEX'], frame());
  const empty = samsung.identify({ services: ['FD5A'] });
  assert.equal(empty.confidence, 'Service match');
  assert.equal(empty.fields.length, 0);
  assert.ok(empty.limitations.some(value => value.includes('No Offline Finding')));
});

test('unrelated companies, names, malformed bytes and UUIDs do not establish Samsung format support', () => {
  for (const manufacturer of ['4c00', '0075', '75', '750', '7500xz', null]) assert.equal(samsung.identify({ manufacturer }), null);
  assert.equal(samsung.identify({ name: 'Other television' }), null);
  assert.equal(samsung.identify(null), null);
  assert.equal(samsung.decodeServiceData('xy').decoded, false);
  assert.equal(samsung.decodeServiceData('00'.repeat(1651)).decoded, false);
  assert.deepEqual(samsung.decodeService('180f', frame()), []);
  assert.equal(values({ fields: samsung.decodeService('FD5A', frame()) })['Battery band'], 'Full');
});

test('source links pin the inspected decoder and company matcher to commits', () => {
  assert.ok(samsung.sources.every(source => /\/blob\/[0-9a-f]{40}\//.test(source.url)));
});

test('firmware 0xfd5a UUIDs match advertised services, service data and saved decoder input', () => {
  assert.equal(samsung.identify({ services: ['0xfd5a'] }).confidence, 'Service match');
  assert.equal(samsung.identify({ services: [{ uuid: '0xFD5A' }] }).confidence, 'Service match');
  const result = samsung.identify({ serviceData: [{ uuid: '0xfd5a', hex: frame() }] });
  assert.equal(result.confidence, 'Decoded broadcast');
  assert.equal(values(result)['Battery band'], 'Full');
  assert.equal(values({ fields: samsung.decodeService('0xFD5A', frame()) })['Battery band'], 'Full');
});

test('name-only library matches retain candidate evidence without inferred device fields', () => {
  for (const name of ['Samsung test device', '[TV] Samsung test device']) {
    const result = samsung.identify({ name });
    assert.equal(result.title, 'Samsung device candidate');
    assert.equal(result.confidence, 'Name candidate');
    assert.ok(result.evidence.includes(`Broadcast name: ${name}`));
    assert.equal(values(result)['Battery band'], undefined);
    assert.equal(values(result)['Model'], undefined);
    assert.ok(result.limitations.some(value => value.includes('does not identify the device type')));
  }
});

test('Samsung assigned services preserve library evidence without Offline Finding decoding', () => {
  for (const uuid of ['fddb', '0xfd7e', 'fd6c', 'fd69', 'fd59', 'fd4b', 'fd1d', 'fc91']) {
    const result = samsung.identify({ services: [uuid] });
    assert.equal(result.confidence, 'Service match');
    assert.equal(result.title, 'Samsung device candidate');
    assert.match(result.evidence[0], /^Service .* is present\.$/);
    assert.equal(values(result)['Reported tag state'], undefined);
    assert.ok(result.sources.some(source => source.title === 'Bluetooth SIG member service UUIDs'));
  }
});
