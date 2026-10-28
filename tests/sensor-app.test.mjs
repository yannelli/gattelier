import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import sensorSession from '../web/sensor-session.js';
import sensorHistory from '../web/sensor-history.js';

const source = readFileSync(new URL('../web/sensor-app.js', import.meta.url), 'utf8');
const device = (at, extra = {}) => ({ address: '54:48:E6:8F:80:A5', addressType: 0, lastSeenMs: at, rssi: -60, serviceData: [{ uuid: 'fcd2', hex: '4002ca09' }], ...extra });

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.value = ''; this.classList = { add() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  insertAdjacentHTML() {}
  addEventListener(type, callback) { this.listeners[type] = callback; }
}

function harness() {
  const history = sensorHistory.create({ storage: null, now: () => 1e7 }), actions = [];
  let session;
  const context = vm.createContext({
    NanoSensorHistory: { create: () => history },
    NanoSensorSession: { create: (store, options) => { session = sensorSession.create(store, options); return session; } },
    NanoInsights: { age: String, profileCard: () => new Element('div') },
    document: { createElement: tag => new Element(tag), addEventListener() {} },
  });
  vm.runInContext(source + '\nthis.app = NanoSensorApp;', context);
  const view = context.app.mount(new Element('section'), { action: (...args) => actions.push(args) });
  return { app: context.app, view, session, history, actions };
}

test('sensor app updates case variants of its selected address and preserves address type', () => {
  const { app, view, session, history, actions } = harness(), selected = device(1000);
  view.render(selected);
  const latest = device(7000, { address: selected.address.toLowerCase() });
  const otherType = { ...latest, addressType: 1 }, otherAddress = { ...latest, address: '02:00:00:00:00:01' };
  app.update([otherType, otherAddress, latest]);
  assert.equal(session.status().device, latest);
  assert.deepEqual(history.samples(selected).map(sample => sample.at), [1000, 7000]);
  assert.deepEqual(history.samples(otherType), []); assert.deepEqual(history.samples(otherAddress), []);
  app.update([otherType, otherAddress]); assert.equal(session.status().device, latest);
  assert.deepEqual(actions, []);
});
