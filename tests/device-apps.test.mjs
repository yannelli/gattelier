import test from 'node:test';
import assert from 'node:assert/strict';
import apps from '../web/device-apps.js';
import modules from '../web/modules.js';
import profiles from '../web/profiles.js';
const purifier = { address: '02:00:00:00:00:01', addressType: 0, name: 'Core200S', manufacturer: 'd006010000000000000000000000', services: [] };
const coffee = { address: '02:00:00:00:00:02', addressType: 0, name: 'Vertuo_CV6_020000000002', manufacturer: '0225000900000000', services: ['06aa1910-f22a-11e3-9daa-0002a5d5c51b'] };
test('LG and ResMed route to their dedicated apps without changing scan evidence', () => {
  const tv = { name: 'LG TV (fixture)', services: ['0xfeb9'], manufacturer: 'c4000000' };
  assert.deepEqual(modules.matches(tv), ['lg']); assert.equal(profiles.identify(tv).category, 'appliance');
  assert.equal(profiles.identify({ manufacturer: 'c4000000' }).category, 'vendor');
  assert.deepEqual(modules.matches({ name: 'ResMed_FIXTURE', services: ['fd56'] }), ['resmed']);
  assert.equal(modules.catalog.filter(item => item.id === 'resmed').length, 1);
  assert.equal(modules.catalog.filter(item => item.id === 'lg').length, 1);
  assert.equal(apps.get('resmed').protocol.manufacturer, false);
});
test('new apps match current protocol evidence and participate in discovery profiles', () => {
  assert.deepEqual(modules.matches(purifier), ['vesync']); assert.deepEqual(modules.matches(coffee), ['nespresso']);
  assert.equal(profiles.identify(purifier).category, 'appliance');
  assert.equal(profiles.identify(coffee).title, 'Nespresso Vertuo');
  assert.deepEqual(modules.matches({ manufacturer: '4c001005071d000000' }), ['apple']);
  assert.equal(apps.identify({ name: 'Unrecognized' }), null);
});
test('cached values are scoped to the selected address and address type', () => {
  const state = { ble: { connected: true, address: purifier.address, addressType: 0 }, services: [{ characteristics: [{ uuid: '2a26', valueHex: '312e30' }] }] };
  assert.ok(apps.snapshot('vesync', purifier, state).fields.some(field => field.label === 'Firmware revision' && field.value === '1.0'));
  for (const ble of [{ ...state.ble, addressType: 1 }, { ...state.ble, address: coffee.address }, { ...state.ble, connected: false }]) assert.ok(!apps.snapshot('vesync', purifier, { ...state, ble }).fields.some(field => field.label === 'Firmware revision'));
});
test('malformed cached GATT values preserve the app and report their decode failure', () => {
  const result = apps.snapshot('vesync', purifier, { ble: { connected: true, address: purifier.address, addressType: 0 }, services: [{ characteristics: [{ uuid: '2a19', valueHex: 'ffff' }] }] });
  assert.ok(result.limitations.some(item => item.includes('Battery level')));
  assert.equal(apps.snapshot('nespresso', purifier), null);
});
test('field changes distinguish additions, removals and changed values', () => {
  assert.deepEqual(apps.changes({ fields: [{ label: 'Power', value: 'Off' }, { label: 'Old', value: 1 }] }, { fields: [{ label: 'Power', value: 'On' }, { label: 'New', value: 0 }] }), [
    { label: 'Power', before: 'Off', after: 'On' }, { label: 'New', before: 'Not observed', after: '0' }, { label: 'Old', before: '1', after: 'Not present in latest observation' }
  ]);
});

test('beacon and Bose apps match without duplicate catalog entries', () => {
  const beacon = { address: '02:00:00:00:00:08', addressType: 0, services: ['feaa'], history: [{ at: 1000, rssi: -70 }], observations: 3 };
  assert.deepEqual(modules.matches(beacon), ['tracker']);
  assert.equal(modules.catalog.filter(item => item.id === 'tracker').length, 1);
  assert.deepEqual(apps.snapshot('tracker', beacon).signalHistory, beacon.history);
  assert.equal(apps.snapshot('tracker', beacon).observations, 3);
  assert.deepEqual(modules.matches({ name: 'Bose SoundLink Max', services: ['febe'], manufacturer: '9e00' }), ['bose']);
});
