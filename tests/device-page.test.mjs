import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/device-page.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

class Element {
  constructor(tag, ownerDocument) {
    this.tag = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.dataset = {};
    this.open = false;
    this.textContent = '';
  }
  append(...children) { this.children.push(...children); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  replaceChildren(...children) {
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.children = children;
  }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
  addEventListener() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = item => {
      if (selector === '[data-focus]') return item.dataset.focus !== undefined;
      if (selector === 'details[open][data-persist]') return item.tag === 'details' && item.open && item.dataset.persist !== undefined;
      if (selector === 'details[data-persist]') return item.tag === 'details' && item.dataset.persist !== undefined;
      if (selector === 'details[data-collapse]:not([open])') return item.tag === 'details' && !item.open && item.dataset.collapse !== undefined;
      if (selector === 'details[data-collapse]') return item.tag === 'details' && item.dataset.collapse !== undefined;
      return item.tag === selector;
    };
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}

function harness() {
  const document = { createElement: tag => new Element(tag, document) };
  document.body = document.createElement('body'); document.activeElement = document.body;
  const header = document.createElement('div'), outside = document.createElement('button');
  document.body.append(header, outside);
  let device = { address: 'aa:bb:cc:dd:ee:01', addressType: 0, name: 'Fixture sensor' };
  let status = { status: 'Connected', details: 'Services ready', reason: '', enabled: true, label: 'Disconnect', connected: true };
  const state = { security: { status: 'idle', active: false } };
  const context = vm.createContext({
    document, state, online: true, $: () => header,
    selectedDevice: () => device, deviceDisplayName: item => item?.name || 'Device',
    NanoWorkspace: { view: () => 'discover' }, NanoDeviceLibrary: { connected: () => status.connected },
    NanoPairing: { update() {} }, NanoModules: { matches: () => [] },
    NanoConnection: {
      pendingDevice: () => null, connectedDevice: () => null, describe: () => status,
      controls: (item, key) => context.button(status.label, 'secondary', () => {}, !status.enabled, key),
    },
  });
  vm.runInContext(appSource.slice(appSource.indexOf('function node('), appSource.indexOf('\nfunction empty(')), context);
  vm.runInContext(source + '\nglobalThis.page = NanoDevicePage;', context);
  return {
    document, header, outside, state,
    render: () => context.page.render(),
    refresh(value = {}, security = {}) { status = { ...status, ...value }; Object.assign(state.security, security); context.page.render(); },
    clearDevice() { device = null; context.page.render(); },
    summary: () => header.querySelector('summary'), menu: () => header.querySelector('details'),
    action: key => header.querySelectorAll('[data-focus]').find(item => item.dataset.focus === key),
  };
}

for (const open of [false, true]) {
  test(`connection refresh preserves summary focus with disclosure ${open ? 'open' : 'closed'}`, () => {
    const h = harness(); h.render();
    h.menu().open = open; h.summary().focus();
    const previous = h.summary();
    h.refresh({ status: 'Disconnected', label: 'Connect', connected: false });
    assert.notEqual(h.summary(), previous);
    assert.equal(h.document.activeElement, h.summary());
    assert.equal(h.summary().focusOptions.preventScroll, true);
    assert.equal(h.menu().open, open);
    assert.equal(h.summary().children.at(-1).textContent, 'Disconnected');
  });

  test(`security refresh preserves summary focus with disclosure ${open ? 'open' : 'closed'}`, () => {
    const h = harness(); h.render();
    h.menu().open = open; h.summary().focus();
    const previous = h.summary();
    h.refresh({}, { status: 'pairing', active: true });
    assert.notEqual(h.summary(), previous);
    assert.equal(h.document.activeElement, h.summary());
    assert.equal(h.menu().open, open);
    assert.equal(h.action('header-pair').textContent, 'Pairing needs attention');
  });
}

for (const key of ['header-connect', 'header-view', 'header-pair']) {
  test(`security refresh preserves existing ${key} action focus`, () => {
    const h = harness(); h.render();
    h.menu().open = true; h.action(key).focus();
    const previous = h.action(key);
    h.refresh({}, { status: 'pairing', active: true });
    assert.notEqual(h.action(key), previous);
    assert.equal(h.document.activeElement, h.action(key));
    assert.equal(h.menu().open, true);
  });
}

test('connection refresh preserves the connection action when its label changes', () => {
  const h = harness(); h.render();
  h.menu().open = true; h.action('header-connect').focus();
  h.refresh({ status: 'Disconnected', label: 'Connect', connected: false });
  assert.equal(h.document.activeElement, h.action('header-connect'));
  assert.equal(h.action('header-connect').textContent, 'Connect');
  assert.equal(h.menu().open, true);
});

test('status refresh leaves focus outside the header intact', () => {
  const h = harness(); h.render(); h.outside.focus();
  h.refresh({}, { status: 'pairing' });
  assert.equal(h.document.activeElement, h.outside);
});

test('unchanged status leaves the focused summary in place', () => {
  const h = harness(); h.render(); h.summary().focus();
  const previous = h.summary();
  h.refresh();
  assert.equal(h.summary(), previous);
  assert.equal(h.document.activeElement, previous);
});

test('summary focus survives a status refresh without an active device', () => {
  const h = harness(); h.render(); h.clearDevice();
  h.menu().open = true; h.summary().focus();
  h.refresh({ status: 'Board offline' });
  assert.equal(h.document.activeElement, h.summary());
  assert.equal(h.menu().open, true);
  assert.equal(h.action('header-discover').textContent, 'Discover devices');
});
