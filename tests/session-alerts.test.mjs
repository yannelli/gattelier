import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const alerts = require('../web/session-alerts.js');
const device = { address: 'AA:BB:CC:DD:EE:01', addressType: 0, name: 'Office sensor' };
const update = (connected, extra = {}) => ({ online: true, state: { ble: { connected, address: device.address, addressType: 0 }, devices: [device] }, ...extra });
function setup(permission = 'default') {
  const events = [], messages = [], saved = new Map(); let requests = 0;
  class Notification {
    static permission = permission;
    static async requestPermission() { requests++; return this.permission = 'granted'; }
    constructor(title, options) { messages.push({ title, ...options }); }
  }
  const options = { Notification, hidden: () => true, onEvent: event => events.push(event), storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } };
  return { controller: alerts.create(options), options, events, messages, saved, requests: () => requests };
}

test('alerts default off and initialization does not request permission or emit', () => {
  const { controller, events, messages, requests } = setup();
  controller.update(update(true)); controller.update(update(true));
  assert.equal(requests(), 0); assert.equal(events.length, 0); assert.equal(messages.length, 0);
  assert.deepEqual(controller.preferences(), { notifications: false, connect: false, disconnect: false, error: false });
});

test('opt-in notification preference persists and transition messages name the device', async () => {
  const { controller, options, events, messages, requests } = setup();
  assert.equal(await controller.setNotifications(true), true); assert.equal(requests(), 1);
  controller.update(update(false)); controller.update(update(true)); controller.update(update(true)); controller.update(update(false));
  assert.deepEqual(events.map(item => item.kind), ['connect', 'disconnect']);
  assert.deepEqual(messages.map(item => item.body), ['Office sensor connected', 'Office sensor disconnected']);
  assert.equal(alerts.create(options).preferences().notifications, true);
  await controller.setNotifications(false); assert.equal(alerts.create(options).preferences().notifications, false);
});

test('denied and unavailable notifications do not become enabled', async () => {
  const denied = setup('denied'); assert.equal(await denied.controller.setNotifications(true), false); assert.equal(denied.requests(), 0);
  const unsupported = alerts.create({ Notification: {} });
  assert.equal(unsupported.permission(), 'unsupported'); assert.equal(await unsupported.setNotifications(true), false);
});

test('notification permission finishing after opt-out preserves opt-out', async () => {
  let grant;
  const controller = alerts.create({ Notification: { permission: 'default', requestPermission: () => new Promise(resolve => { grant = resolve; }) } });
  const pending = controller.setNotifications(true); await controller.setNotifications(false); grant('granted'); await pending;
  assert.equal(controller.preferences().notifications, false);
});

test('repeated errors are deduplicated and foreground notifications are suppressed', async () => {
  const fixture = setup('granted'); fixture.options.hidden = () => false;
  const controller = alerts.create(fixture.options); await controller.setNotifications(true);
  controller.update(update(false)); controller.update(update(true, { error: 'Read failed' })); controller.update(update(true, { error: 'Read failed' }));
  controller.update(update(true)); controller.update(update(true, { error: 'Read failed' }));
  assert.deepEqual(fixture.events.map(item => item.kind), ['connect', 'error', 'error']); assert.equal(fixture.messages.length, 0);
});

test('address type changes emit disconnect/connect and case changes do not', () => {
  const { controller, events } = setup();
  controller.update(update(true));
  controller.update({ online: true, state: { ble: { connected: true, address: device.address.toLowerCase(), addressType: 0 } } });
  assert.equal(events.length, 0);
  controller.update({ online: true, state: { ble: { connected: true, address: device.address, addressType: 1 } } });
  assert.deepEqual(events.map(item => item.kind), ['disconnect', 'connect']);
});

test('board loss reports unknown connection state once', () => {
  const { controller, events } = setup();
  controller.update(update(true)); controller.update(update(true, { online: false })); controller.update(update(true, { online: false }));
  assert.equal(events.length, 1); assert.match(events[0].body, /status is unknown/);
});

test('sound requires opt-in and resumes audio from the setting interaction', async () => {
  let starts = 0, resumes = 0;
  const parameter = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
  class AudioContext {
    state = 'suspended'; currentTime = 1;
    async resume() { resumes++; this.state = 'running'; }
    createOscillator() { return { frequency: parameter, connect() {}, start() { starts++; }, stop() {} }; }
    createGain() { return { gain: parameter, connect() {} }; }
  }
  const controller = alerts.create({ AudioContext });
  controller.update(update(false)); controller.update(update(true)); assert.equal(starts, 0);
  assert.equal(await controller.setSound('connect', true), true); assert.equal(resumes, 1);
  controller.update(update(false)); controller.update(update(true)); assert.equal(starts, 1);
  assert.equal(await controller.setSound('unknown', true), false);
});

test('mobile notifications use the existing service worker when construction fails', async () => {
  const messages = [];
  class Notification { static permission = 'granted'; constructor() { throw new Error('Use service worker'); } }
  const controller = alerts.create({ Notification, hidden: () => true, serviceWorker: { getRegistration: async () => ({ showNotification: async (title, options) => messages.push({ title, ...options }) }) } });
  await controller.setNotifications(true); controller.update(update(false)); controller.update(update(true));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1); assert.equal(messages[0].body, 'Office sensor connected'); assert.equal(messages[0].silent, true);
});

test('restricted storage leaves alert settings usable', async () => {
  const context = { module: { exports: {} } };
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('SecurityError'); } });
  vm.runInNewContext(readFileSync(new URL('../web/session-alerts.js', import.meta.url), 'utf8'), context);
  const controller = context.module.exports.create();
  assert.equal(await controller.setSound('error', true), true);
});

test('service worker notification click focuses the open workspace without reloading', async () => {
  const listeners = {}; let focused = 0, opened = 0, closed = 0, completion;
  const self = { location: { origin: 'https://gattelier.test' }, addEventListener: (key, action) => { listeners[key] = action; },
    clients: { matchAll: async () => [{ url: 'https://gattelier.test/', focus: async () => focused++ }], openWindow: async () => opened++ } };
  vm.runInNewContext(readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8'), { self, URL });
  listeners.notificationclick({ notification: { close() { closed++; } }, waitUntil(value) { completion = value; } });
  await completion; assert.equal(focused, 1); assert.equal(opened, 0); assert.equal(closed, 1);
});
