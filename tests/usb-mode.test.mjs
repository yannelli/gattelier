import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const usb = require('../web/usb-mode.js');
test('USB controller status reports startup, readiness and errors', () => {
  assert.equal(usb.summary({ mode: 'hci', ready: true }), 'USB controller ready');
  assert.equal(usb.summary({ mode: 'hci', ready: false }), 'Starting USB controller');
  assert.equal(usb.summary({ mode: 'hci', error: 'Controller initialization failed' }), 'Controller initialization failed');
  assert.equal(usb.summary({ mode: 'workbench', restarting: true }), 'Restarting board');
});
