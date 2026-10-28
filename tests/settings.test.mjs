import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture(saved = 'app', initialVisible = true) {
  const names = ['connection', 'wifi', 'workspace', 'history', 'collection', 'libraries', 'credentials', 'board', 'app'];
  const handlers = {}, globalHandlers = {}, panels = new Map(), menus = [];
  let visible = initialVisible, width = 300, focused = null;
  const nav = { scrollLeft: 0, get clientWidth() { return visible ? width : 0; }, getBoundingClientRect: () => ({ left: 0, right: width }) };
  const buttons = names.map((section, index) => ({
    dataset: { section }, attributes: { 'aria-controls': `settings-${section}` }, parentElement: nav, listeners: {},
    setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key]; },
    getBoundingClientRect: () => ({ left: index * 90 - nav.scrollLeft, right: index * 90 + 85 - nav.scrollLeft }),
    addEventListener(type, callback) { this.listeners[type] = callback; }, focus() { focused = this; },
  }));
  const context = vm.createContext({
    localStorage: { getItem: () => saved, setItem() {} },
    addEventListener: (type, callback) => { globalHandlers[type] = callback; },
    document: { querySelectorAll: selector => selector.startsWith('.settings-nav') ? buttons : menus.filter(menu => menu.open),
      addEventListener: (type, callback) => { handlers[type] = callback; },
      getElementById(id) { if (!panels.has(id)) panels.set(id, {}); return panels.get(id); } },
  });
  vm.runInContext(readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8') + '\nglobalThis.settings = NanoSettings;', context);
  context.settings.mount();
  return { nav, buttons, menus, handlers, focused: () => focused, enter() { visible = true; handlers['nanoscope:workspace']({ detail: { view: 'settings' } }); },
    resize(value) { width = value; globalHandlers.resize(); } };
}

test('a restored Settings section is revealed when its previously hidden view opens', () => {
  const f = fixture('app', false), current = f.buttons.at(-1);
  assert.equal(f.nav.scrollLeft, 0);
  f.enter();
  assert.ok(current.getBoundingClientRect().left >= 0);
  assert.ok(current.getBoundingClientRect().right <= f.nav.clientWidth);
  assert.equal(f.focused(), null);
});

test('keyboard section changes reveal both ends of the tab strip', () => {
  const f = fixture('connection');
  f.buttons[0].listeners.keydown({ key: 'End', preventDefault() {} });
  assert.equal(f.focused(), f.buttons.at(-1));
  assert.ok(f.nav.scrollLeft > 0);
  f.buttons.at(-1).listeners.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(f.focused(), f.buttons[0]);
  assert.equal(f.nav.scrollLeft, 0);
});

test('narrower viewports and returning to Settings reveal its selected section', () => {
  const f = fixture();
  f.resize(200);
  assert.ok(f.buttons.at(-1).getBoundingClientRect().right <= 200);
  f.nav.scrollLeft = 0;
  f.enter();
  assert.ok(f.buttons.at(-1).getBoundingClientRect().right <= 200);
});

test('outside clicks dismiss the header connection menu', () => {
  const f = fixture(), inside = {};
  const menu = { open: true, contains: item => item === inside };
  f.menus.push(menu);
  f.handlers.click({ target: inside }); assert.equal(menu.open, true);
  f.handlers.click({ target: {} }); assert.equal(menu.open, false);
});

test('Escape dismisses a visible menu and restores summary focus without handling hidden menus', () => {
  const f = fixture(); let focused = false, prevented = false;
  const hidden = { open: true, getClientRects: () => [] };
  const visible = { open: true, getClientRects: () => [{}], querySelector: () => ({ focus: () => { focused = true; } }) };
  f.menus.push(hidden, visible);
  f.handlers.keydown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(hidden.open, true); assert.equal(visible.open, false);
  assert.equal(focused, true); assert.equal(prevented, true);
  visible.open = true;
  f.handlers.keydown({ key: 'Escape', defaultPrevented: true });
  assert.equal(visible.open, true);
});
