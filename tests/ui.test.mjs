import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deviceKey, visibleDevices, canScan, canConnect, canRead, uuidName, operationLabel, scanAction, scanStatus, lastSeenLabel } = require('../web/app.js');
const idle = { ble: { busy: false, connected: false } };
const device = { id: 1, address: 'AA:BB:CC:DD:EE:FF', addressType: 0, name: 'Pocket Recorder', rssi: -50, connectable: true };

test('search matches names and addresses without changing device order', () => {
  const devices = [{ ...device, rssi: -80 }, { ...device, id: 2, address: '11:22:33:44:55:66', name: 'PLAUD', rssi: -40 }];
  assert.deepEqual(visibleDevices(devices, '  plaud ').map(item => item.id), [2]);
  assert.deepEqual(visibleDevices(devices, 'aa:bb').map(item => item.id), [1]);
  assert.deepEqual(visibleDevices(devices, '').map(item => item.id), [2, 1]);
  assert.deepEqual(devices.map(item => item.id), [1, 2]);
});

test('selection identity includes address type and survives changing scan IDs', () => {
  assert.equal(deviceKey(device), deviceKey({ ...device, id: 9 }));
  assert.notEqual(deviceKey(device), deviceKey({ ...device, addressType: 1 }));
});

test('scan and connection actions require an idle, connected board', () => {
  assert.equal(canScan(idle, true, false), true);
  assert.equal(canScan(idle, false, false), false);
  assert.equal(canScan(idle, true, true), false);
  assert.equal(canScan({ ble: { busy: true, connected: false } }, true, false), false);
  assert.equal(canScan({ ble: { busy: false, connected: true } }, true, false), false);
  assert.equal(canConnect(idle, device, true, false), true);
  assert.equal(canConnect(idle, { ...device, connectable: false }, true, false), false);
});

test('reads require a connection and a readable characteristic', () => {
  const connected = { ble: { busy: false, connected: true } };
  assert.equal(canRead(connected, { properties: ['read'] }, true, false), true);
  assert.equal(canRead(connected, { properties: ['notify'] }, true, false), false);
  assert.equal(canRead(idle, { properties: ['read'] }, true, false), false);
  assert.equal(canRead(connected, { properties: ['read'] }, true, true), false);
  assert.equal(canRead(connected, { properties: ['read'] }, false, false), false);
});

test('standard UUID labels do not mislabel vendor UUIDs with matching prefixes', () => {
  assert.equal(uuidName('180f', 'Custom service'), 'Battery Service');
  assert.equal(uuidName('0x1800', 'Custom service'), 'Generic Access');
  assert.equal(uuidName('0x2a00', 'Characteristic'), 'Device Name');
  assert.equal(uuidName('0000180F-0000-1000-8000-00805F9B34FB', 'Custom service'), 'Battery Service');
  assert.equal(uuidName('0000180f-1234-5678-8000-00805f9b34fb', 'Custom service'), 'Custom service');
});

test('firmware operation states display their current progress', () => {
  assert.equal(operationLabel('scanning'), 'Scanning continuously');
  assert.equal(operationLabel('connecting'), 'Connecting…');
  assert.equal(operationLabel('discovering'), 'Discovering services…');
  assert.equal(operationLabel('reading'), 'Reading value…');
  assert.equal(operationLabel('disconnecting'), 'Disconnecting…');
  assert.equal(operationLabel('unknown'), 'Working…');
});

test('continuous scanning permits connection and toggles to stop', () => {
  const live = { ble: { busy: false, connected: false, scanning: true, scanEnabled: true, operation: 'scanning' } };
  assert.equal(canConnect(live, device, true, false), true);
  assert.equal(canScan(live, true, false), true);
  assert.equal(scanAction(live.ble), 'stop-scan');
  assert.equal(scanStatus(live.ble), 'Scanning continuously');
  assert.equal(scanAction({ scanning: false }), 'scan');
});

test('connected scan state reports pause and blocks scan controls', () => {
  const paused = { ble: { busy: false, connected: true, scanning: false, scanEnabled: true } };
  assert.equal(scanStatus(paused.ble), 'Scanning paused while connected');
  assert.equal(canScan(paused, true, false), false);
  assert.equal(scanStatus({ ...paused.ble, scanEnabled: false }), 'Scanning stopped');
  assert.equal(scanStatus({ busy: true, operation: 'discovering' }), 'Discovering services…');
});

test('last-seen age uses seconds since boot and handles missing timestamps', () => {
  assert.equal(lastSeenLabel({ lastSeen: 100 }, 101), 'Seen just now');
  assert.equal(lastSeenLabel({ lastSeen: 100 }, 112), 'Seen 12s ago');
  assert.equal(lastSeenLabel({ lastSeen: 100 }, 220), 'Seen 2m ago');
  assert.equal(lastSeenLabel({ lastSeen: 0 }, 12), 'Seen 12s ago');
  assert.equal(lastSeenLabel({}, 12), '');
});
