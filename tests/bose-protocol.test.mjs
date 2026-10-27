import test from 'node:test';
import assert from 'node:assert/strict';
import bose from '../web/bose-protocol.js';

const qc = { name: 'Bose QuietComfort Ultra Headphones', manufacturer: '9e0001020304', services: ['0xfebe'] };
const max = { name: 'Bose SoundLink Max', manufacturer: '9e0001020304', services: ['0xfebe'] };
const identityHex = '00030303406601';
const values = fields => Object.fromEntries(fields.map(field => [field.label, field.value]));
const build = (id, options = {}) => bose.buildCommand(id, { device: qc, identityHex, characteristic: bose.characteristics.unsecure, ...options });

test('Bose manufacturer, service and name matches stay candidates including SoundLink Max', () => {
  assert.equal(bose.identify(max).title, 'Bose SoundLink Max candidate');
  assert.equal(bose.identify(max).family, 'unconfirmed');
  assert.ok(bose.identify(max).limitations.some(value => value.includes('unavailable for SoundLink Max')));
  assert.equal(bose.identify(qc).family, 'unconfirmed');
  assert.equal(bose.identify({ name: 'Bose test' }).confidence, 'Name candidate');
  assert.equal(bose.identify({ manufacturer: '9e00' }).confidence, 'Manufacturer match');
  assert.equal(bose.identify({ services: [bose.service] }).confidence, 'Service match');
  for (const device of [null, {}, { name: 'Other headphones' }, { manufacturer: '009e' }, { manufacturer: '9e00x' }, { services: ['feb9'] }]) assert.equal(bose.identify(device), null);
  assert.equal(values(bose.identify(max).fields)['Component 0 battery'], undefined);
});

test('BMAP headers retain unknown blocks, operators and payloads with strict declared lengths', () => {
  const parsed = bose.parse('fffe8f02aabb00030303406601');
  assert.equal(parsed.packets.length, 2);
  assert.equal(parsed.packets[0].block, 255); assert.equal(parsed.packets[0].operator, 15);
  assert.equal(parsed.packets[0].device, 2); assert.equal(parsed.packets[0].port, 0);
  const fields = values(bose.inspect('fffe8f02aabb'));
  assert.equal(fields['Frame 1 operator'], 'Unmapped (15)');
  assert.equal(fields['Frame 1 payload HEX'], 'aabb');
  for (const data of ['0003', '020203045aff']) {
    const inspected = values(bose.inspect(data));
    assert.ok(inspected['Frame error 1']); assert.equal(inspected['Captured BMAP HEX'], data);
  }
  for (const data of ['', '0', 'xy', null, '00'.repeat(4097)]) assert.throws(() => bose.parse(data));
});

test('QC payload fields require explicit layout or captured identity evidence', () => {
  const battery = '020203045affff00';
  assert.equal(values(bose.inspect(battery))['Frame 1 Component 0 battery'], undefined);
  for (const context of [{ model: 'qc-ultra-1' }, { identityHex }]) {
    const fields = values(bose.inspect(battery, context));
    assert.equal(fields['Frame 1 Component 0 battery'], '90%');
    assert.equal(fields['Frame 1 Component 0 battery auxiliary HEX'], 'ffff');
    assert.equal(fields['Frame 1 Remaining minutes'], undefined);
  }
  const sameCapture = values(bose.inspect(identityHex + battery));
  assert.equal(sameCapture['Frame 1 Product ID'], '0x4066');
  assert.equal(sameCapture['Frame 2 Component 0 battery'], '90%');
});

test('QC name, timer, mode and raw volume scale decode without product-wide assumptions', () => {
  const context = { model: 'qc-ultra-1' };
  const fields = values(bose.inspect('01020306005465737400010403031400001f03030102050503021f0f', context));
  assert.equal(fields['Frame 1 Reported device name'], 'Test');
  assert.equal(fields['Frame 2 Standby timer'], '20 minutes');
  assert.equal(fields['Frame 3 Audio mode index'], '2');
  assert.equal(fields['Frame 4 Volume scale byte'], '31');
  assert.equal(fields['Frame 4 Volume position byte'], '15');
  assert.equal(values(bose.inspect('0104030100', context))['Frame 1 Standby timer'], 'Disabled');
  assert.equal(values(bose.inspect('01020302ffff', context))['Frame 1 Reported device name'], undefined);
});

test('response operators and component boundaries prevent request/error bytes becoming status', () => {
  assert.equal(values(bose.inspect('020201045affff00', { model: 'qc-ultra-1' }))['Frame 1 Component 0 battery'], undefined);
  assert.match(values(bose.inspect('0202040105'))['Frame 1 BMAP error'], /Operator unsupported/);
  assert.equal(values(bose.inspect('020243045affff00', { model: 'qc-ultra-1' }))['Frame 1 Component 0 battery'], undefined);
  assert.equal(values(bose.inspect('020203035affff', { model: 'qc-ultra-1' }))['Frame 1 Component 0 battery'], undefined);
});

test('BLE framing strips one segmentation header with complete ordered reassembly', () => {
  assert.equal(bose.reassemble(['00' + identityHex]), identityHex);
  const raw = '01020315' + Buffer.from('Twenty-one byte name!').toString('hex');
  const segments = ['10' + raw.slice(0, 38), '11' + raw.slice(38)];
  assert.equal(bose.reassemble(segments), raw);
  const fields = values(bose.decodeStatus({ format: 'ble-segments', model: 'qc-ultra-1', segments }));
  assert.equal(fields['Frame 1 Reported device name'], 'Twenty-one byte name!');
  for (const entries of [[], ['10' + raw.slice(0, 38)], [...segments].reverse(), ['100102', segments[1]], ['00'], ['00' + 'aa'.repeat(20)]]) assert.throws(() => bose.reassemble(entries));
  assert.ok(values(bose.decodeStatus({ format: 'ble-segments', segments: [segments[0]] }))['BLE frame error']);
});

test('characteristic decoding distinguishes secure labels and preserves incomplete segment errors', () => {
  for (const characteristic of [bose.characteristics.unsecure, bose.characteristics.secure]) {
    const fields = values(bose.decode(characteristic, '00020203045affff00', { model: 'qc-ultra-1' }));
    assert.equal(fields['Frame 1 Component 0 battery'], '90%');
    assert.match(fields['Captured characteristic variant'], characteristic === bose.characteristics.secure ? /^Secure/ : /^Unsecure/);
  }
  assert.deepEqual(bose.decode('2a19', '50'), []);
  assert.ok(values(bose.decode(bose.characteristics.unsecure, '10020203045a'))['BLE frame error']);
  for (const value of [null, {}, { format: 'unknown' }, { format: 'bmap', hex: '00', model: 'soundlink-max' }]) assert.throws(() => bose.decodeStatus(value));
});

test('reference queries encode exact BMAP and single-segment BLE bytes without sendable steps', () => {
  for (const [id, hex] of [['product-id', '00030100'], ['name', '01020100'], ['battery', '02020100'], ['standby', '01040100'], ['current-mode', '1f030100'], ['power-off', '0704050100']]) {
    const plan = build(id);
    assert.equal(plan.hex, hex); assert.deepEqual(plan.framing.bleSegments, ['00' + hex]);
    assert.equal(plan.service, bose.service); assert.equal(plan.characteristic, bose.characteristics.unsecure);
    assert.equal(plan.execution, 'reference-preview'); assert.equal(plan.steps, undefined);
    assert.equal(plan.compatibility.productId, '0x4066'); assert.equal(plan.compatibility.hardwareValidatedHere, false);
    assert.ok(plan.prerequisites.some(value => value.includes('GET requests still require characteristic writes')));
  }
  assert.equal(build('set-standby', { minutes: '20' }).hex, '0104020114');
  assert.equal(build('select-mode', { mode: '3' }).hex, '1f0305020300');
  assert.equal(build('battery', { characteristic: bose.characteristics.secure }).characteristic, bose.characteristics.secure);
});

test('SoundLink Max, missing model/service evidence and unsupported operations reject previews', () => {
  assert.throws(() => build('battery', { device: max }), /unavailable for SoundLink Max/);
  assert.throws(() => build('battery', { identityHex: '00030303408201' }), /0x4066/);
  assert.throws(() => build('battery', { identityHex: '' }));
  assert.throws(() => build('battery', { device: { name: qc.name } }), /FEBE/);
  assert.throws(() => build('battery', { characteristic: 'unknown' }));
  assert.throws(() => build('battery', { token: 'unexpected' }));
  for (const id of ['set-volume', 'power-on', 'firmware', 'pair', 'unknown']) assert.throws(() => build(id));
  for (const minutes of [1, '21', '020', -1]) assert.throws(() => build('set-standby', { minutes }));
  for (const mode of [-1, '1.5', '01', 256, true]) assert.throws(() => build('select-mode', { mode }));
});

test('offline builders and decoders make no network calls and expose pinned source URLs', () => {
  const oldFetch = globalThis.fetch, oldSocket = globalThis.WebSocket;
  const forbidden = () => { throw new Error('Unexpected network call'); };
  globalThis.fetch = forbidden; globalThis.WebSocket = forbidden;
  try {
    for (const command of bose.commands) {
      const options = Object.fromEntries(command.inputs.map(input => [input.id, input.id === 'identityHex' ? identityHex : input.default]));
      assert.equal(build(command.id, options).execution, 'reference-preview');
    }
    assert.equal(bose.decodeStatus({ format: 'bmap', hex: identityHex }).length > 0, true);
  } finally { globalThis.fetch = oldFetch; globalThis.WebSocket = oldSocket; }
  assert.ok(bose.sources.every(source => /\/(?:blob|src)\/[0-9a-f]{40}\//.test(source.url)));
  assert.equal(bose.statusLabel, 'BMAP capture JSON');
});
