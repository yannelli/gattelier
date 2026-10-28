import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.handlers = {}; this.value = ''; this.classList = { toggle() {} }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  get childElementCount() { return this.children.length; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  scrollIntoView() {}
}
const peer = { address: '02:00:00:00:00:01', addressType: 0 };
const characteristic = (properties, subscription = 'off') => ({ handle: 12, uuid: '2a19', properties, subscription, descriptors: [{ handle: 13, uuid: '2902' }] });
function fixture(item, withEvents = true) {
  const nodes = [], ids = new Map(), calls = [], handlers = {};
  let listener, acting = false;
  const document = {
    createElement(tag) { const node = new Element(tag); nodes.push(node); return node; },
    getElementById: id => ids.get(id),
    querySelectorAll: () => nodes.filter(node => node.dataset.notificationKey),
  };
  for (const id of ['handle', 'response', 'send', 'replay', 'limit', 'history', 'status']) ids.set(`console-${id}`, new Element('div'));
  ids.get('console-response').options = [{}, {}]; ids.get('console-response').selectedOptions = [];
  const context = vm.createContext({ document, addEventListener: (name, callback) => { handlers[name] = callback; }, removeEventListener() {}, NanoDeviceLibrary: { connected: (target, state) => state.ble.connected && target.address === state.ble.address && target.addressType === state.ble.addressType } });
  vm.runInContext(readFileSync(new URL('../web/console.js', import.meta.url), 'utf8') + '\nglobalThis.consoleUI = NanoConsole;', context);
  const ui = context.consoleUI;
  ui.mount(new Element('div'), { isActing: () => acting, action: async (path, body) => calls.push({ path, ...body }), ...(withEvents ? { onEvents: callback => { listener = callback; } } : {}) });
  const state = (ble = {}) => ({ uptime: 10, ble: { ...peer, connectionAttempt: 1, connected: true, ...ble }, services: [{ characteristics: [item] }] });
  ui.update(state(), true);
  return { ui, calls, state, apiChange: () => handlers['nanoscope:api-change'](), listener: () => listener, setActing: value => { acting = value; }, emit: (events, meta) => listener(events, meta), render: readOnly => ui.characteristicActions(item, readOnly) };
}
const all = root => [root, ...root.children.flatMap(all)];
const toggle = root => all(root).find(node => node.dataset.focus === '12-subscription');

test('subscription toggles notify on and off with stable focus and pressed state', async () => {
  const item = characteristic(['notify']), f = fixture(item);
  const first = toggle(f.render());
  assert.equal(first.textContent, 'Subscribe'); assert.equal(first.attributes['aria-pressed'], 'false');
  await first.handlers.click();
  assert.deepEqual(f.calls, [{ path: 'subscribe', handle: 12, mode: 'notify' }]);
  item.subscription = 'notify';
  const second = toggle(f.render());
  assert.equal(second.textContent, 'Subscribed'); assert.equal(second.disabled, false);
  assert.equal(second.attributes['aria-pressed'], 'true'); assert.equal(second.dataset.focus, first.dataset.focus);
  await second.handlers.click(); assert.equal(f.calls[1].mode, 'off');
});

test('indicate-only defaults to indicate; dual support offers a notify-default choice', async () => {
  for (const properties of [['indicate'], ['notify', 'indicate']]) {
    const f = fixture(characteristic(properties)), root = f.render();
    const choice = all(root).find(node => node.tagName === 'select');
    assert.equal(Boolean(choice), properties.length === 2);
    if (choice) assert.equal(choice.value, 'notify');
    await toggle(root).handlers.click(); assert.equal(f.calls[0].mode, properties[0]);
    if (choice) {
      choice.value = 'indicate'; choice.handlers.change(); await toggle(root).handlers.click();
      assert.equal(f.calls[1].mode, 'indicate');
    }
  }
});

test('read-only controls disable write, subscription, mode choice, and descriptor reads', async () => {
  const f = fixture(characteristic(['write', 'notify', 'indicate'])), root = f.render(true);
  const controls = all(root).filter(node => ['button', 'select'].includes(node.tagName));
  assert.equal(controls.length, 4); assert.ok(controls.every(node => node.disabled));
  for (const control of controls) await control.handlers.click?.();
  assert.deepEqual(f.calls, []);
});

test('retained controls reject another address, another address type, offline and busy state', async () => {
  for (const change of [{ address: '02:00:00:00:00:02' }, { addressType: 1 }, { connected: false }, { busy: true }, { acting: true }, { offline: true }]) {
    const f = fixture(characteristic(['write', 'notify'])), root = f.render();
    f.ui.update(f.state(change), !change.offline); f.setActing(Boolean(change.acting));
    for (const control of all(root).filter(node => node.tagName === 'button')) await control.handlers.click();
    assert.deepEqual(f.calls, []);
  }
});

const notification = (seq, fields = {}) => ({ address: peer.address, uuid: '2a19', handle: 12, kind: 'notification', seq, ms: 11000 + seq, ...fields });
const count = f => all(f.render()).find(node => node.dataset.notificationKey);
const baseline = f => f.emit([], { bootId: 'one' });

test('counts only current-session events after the initial journal and state timestamp', () => {
  const f = fixture(characteristic(['notify']));
  f.emit([notification(1)], { bootId: 'one' });
  assert.equal(count(f).textContent, '');
  f.emit([notification(2, { ms: 10999 }), notification(3), notification(4, { kind: 'indication' }), notification(5, { kind: 'read' }), notification(6, { handle: 99 }), notification(7, { success: false })], { bootId: 'one' });
  assert.equal(count(f).textContent, 'Captured notifications: 2');
  f.emit([notification(3)], { bootId: 'one' }); assert.equal(count(f).textContent, 'Captured notifications: 2');
  const unsupported = fixture(characteristic(['notify']), false);
  assert.equal(all(unsupported.render()).some(node => node.dataset.notificationKey), false);
});

test('connection address, type, attempt, offline, and disconnect changes reset counts', () => {
  for (const change of [{ address: '02:00:00:00:00:02' }, { addressType: 1 }, { connectionAttempt: 2 }, { connected: false }, { offline: true }]) {
    const f = fixture(characteristic(['notify'])); baseline(f);
    f.emit([notification(1)], { bootId: 'one' }); const displayed = count(f);
    assert.equal(displayed.textContent, 'Captured notifications: 1');
    f.ui.update({ ...f.state(change), uptime: 20 }, !change.offline);
    assert.equal(displayed.textContent, '');
    f.emit([notification(2)], { bootId: 'one' }); assert.equal(count(f).textContent, '');
  }
});

test('same-address reconnection rejects old type, attempt, timestamps, and board events', () => {
  const f = fixture(characteristic(['notify'])); baseline(f);
  f.emit([notification(1)], { bootId: 'one' });
  f.ui.update({ ...f.state({ addressType: 1, connectionAttempt: 2 }), uptime: 20 }, true);
  f.emit([notification(2), notification(3, { ms: 21001, addressType: 0 }), notification(4, { ms: 21002, connectionAttempt: 1 }), notification(5, { ms: 21003, bootId: 'old' }), notification(6, { ms: 21004, address: '02:00:00:00:00:02' })], { bootId: 'one' });
  assert.equal(count(f).textContent, '');
  f.emit([notification(7, { ms: 21005 })], { bootId: 'one' }); assert.equal(count(f).textContent, 'Captured notifications: 1');
});

test('connect and disconnect event order blocks attribution until state identifies a new connection', () => {
  for (const kind of ['connect', 'disconnect']) {
    const f = fixture(characteristic(['notify'])); baseline(f);
    f.emit([notification(1), notification(2, { kind }), notification(3)], { bootId: 'one' });
    assert.equal(count(f).textContent, '');
    f.ui.update(f.state(), true);
    f.emit([notification(4)], { bootId: 'one' }); assert.equal(count(f).textContent, '');
    f.ui.update({ ...f.state({ connectionAttempt: 2 }), uptime: 20 }, true);
    f.emit([notification(5, { ms: 21001 })], { bootId: 'one' }); assert.equal(count(f).textContent, 'Captured notifications: 1');
  }
});

test('API change rejects old callbacks and waits for fresh state and journal', () => {
  const f = fixture(characteristic(['notify'])); baseline(f);
  f.emit([notification(1)], { bootId: 'one' }); const oldListener = f.listener();
  f.apiChange(); oldListener([notification(2)], { bootId: 'one' });
  assert.equal(count(f).textContent, '');
  f.ui.update(f.state(), true);
  f.emit([notification(1)], { bootId: 'two' }); assert.equal(count(f).textContent, '');
  f.emit([notification(2)], { bootId: 'two' }); assert.equal(count(f).textContent, 'Captured notifications: 1');
});

test('reboot resets counts and needs a fresh state timestamp', () => {
  const f = fixture(characteristic(['notify'])); baseline(f);
  f.emit([notification(1)], { bootId: 'one' });
  f.emit([notification(1)], { bootId: 'two', reboot: true });
  assert.equal(count(f).textContent, '');
  f.ui.update({ ...f.state(), uptime: 2 }, true);
  f.emit([notification(2, { ms: 3000 })], { bootId: 'two' }); assert.equal(count(f).textContent, 'Captured notifications: 1');
});

test('missing timestamp evidence leaves notification counts unavailable', () => {
  const f = fixture(characteristic(['notify'])); baseline(f);
  f.ui.update({ ...f.state({ connectionAttempt: 2 }), uptime: undefined }, true);
  f.emit([notification(1)], { bootId: 'one' }); assert.equal(count(f).textContent, '');
});

test('a characteristic without attributable events stays empty when another receives events', () => {
  const item = characteristic(['notify']), f = fixture(item); baseline(f);
  f.emit([notification(1)], { bootId: 'one' });
  const other = { ...item, handle: 20 };
  const root = f.ui.characteristicActions(other);
  assert.equal(all(root).find(node => node.dataset.notificationKey).textContent, '');
});
