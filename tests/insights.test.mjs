import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import profiles from '../web/profiles.js';
import ui from '../web/app.js';

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.open = false;
    this.listeners = {};
    this.ownText = '';
    this.classList = { toggle() {} };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) {
    if (this.contains(this.ownerDocument?.activeElement)) this.ownerDocument.activeElement = null;
    this.children = nodes;
  }
  contains(node) { return all(this).includes(node); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) {
    return all(this).slice(1).filter(item => {
      if (selector === '[data-focus]') return item.dataset.focus !== undefined;
      if (selector === 'details[data-persist]') return item.tag === 'details' && item.dataset.persist !== undefined;
      if (selector === 'details[open][data-persist]') return item.tag === 'details' && item.open && item.dataset.persist !== undefined;
      return false;
    });
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
const all = root => [root, ...root.children.flatMap(all)];
const target = { address: 'aa:bb:cc:dd:ee:01', addressType: 0, services: ['fd5a'], gattName: 'Remembered tracker', rssi: -50 };
function harness(extra = {}) {
  const context = vm.createContext({
    NanoProfiles: profiles,
    document: {
      createElement: tag => new Element(tag),
      createDocumentFragment: () => new Element('fragment'),
      createElementNS(namespaceURI, tag) { const element = new Element(tag); element.namespaceURI = namespaceURI; return element; }
    },
    ...extra
  });
  vm.runInContext(readFileSync(new URL('../web/insights.js', import.meta.url), 'utf8'), context);
  return vm.runInContext('NanoInsights', context);
}
function render(insights, device = target) {
  const container = new Element('div'), selected = [], filtered = [];
  insights.render(container, device, [device], item => selected.push(item), category => filtered.push(category));
  return { container, selected, filtered };
}

test('unknown timestamps do not claim a recent observation', () => {
  const insights = harness();
  for (const timestamp of [undefined, null, 0, -1, NaN, Infinity, 'yesterday']) {
    assert.equal(insights.age(timestamp), 'Last seen unknown');
  }
  assert.equal(insights.age(Date.now()), 'Seen just now');
  assert.match(insights.age(Date.now() - 120000), /^Seen 2m ago$/);
  const { container } = render(insights);
  assert.match(container.textContent, /Last seen unknown/);
  assert.doesNotMatch(container.textContent, /Seen just now|NaN/);
});

test('heading and tracker row use the shared device identity and preserve navigation', () => {
  const calls = [], insights = harness({ deviceDisplayName(device) { calls.push(device); return 'Shared identity'; } });
  const { container, selected, filtered } = render(insights);
  const heading = all(container).find(item => item.tag === 'h2');
  const row = all(container).find(item => item.className === 'tracker-row');
  assert.equal(heading.textContent, 'Shared identity');
  assert.match(row.textContent, /^Shared identity/);
  assert.deepEqual(calls, [target, target]);
  row.listeners.click();
  assert.deepEqual(selected, [target]);
  const catalog = all(container).find(item => item.className === 'profile-catalog');
  const tracker = catalog.children.find(item => item.attributes['aria-label'].startsWith('BLE trackers:'));
  assert.match(tracker.attributes['aria-label'], /1 seen/);
  tracker.listeners.click();
  assert.deepEqual(filtered, ['tracker']);
});

test('standalone rendering retains remembered names and skips whitespace labels', () => {
  const insights = harness();
  const { container } = render(insights, { ...target, label: ' ', name: '' });
  assert.equal(all(container).find(item => item.tag === 'h2').textContent, 'Remembered tracker');
  assert.match(all(container).find(item => item.className === 'tracker-row').textContent, /^Remembered tracker/);
});

test('real shared display naming is used for stored GATT identities', () => {
  const insights = harness({ deviceDisplayName: device => ui.deviceDisplayName(device, null) });
  const { container } = render(insights);
  assert.equal(all(container).find(item => item.tag === 'h2').textContent, 'Remembered tracker');
});

test('signal trace is unfilled, chronological, accessible, and leaves stored history intact', () => {
  const history = [{ at: 3000, rssi: -50 }, { at: 1000, rssi: -70 }, { at: 2000, rssi: -60 },
    { rssi: -20 }, { at: NaN, rssi: -10 }, { at: 4000, rssi: Infinity }, null];
  const before = structuredClone(history);
  const section = harness().signalChart({ history, observations: 42 });
  const svg = all(section).find(item => item.tag === 'svg');
  const line = all(svg).find(item => item.tag === 'polyline');
  assert.equal(line.attributes.fill, 'none');
  assert.equal(svg.attributes.role, 'img');
  assert.match(svg.attributes['aria-label'], /-70 to -50 dBm across 3 observations/);
  assert.deepEqual(line.attributes.points.split(' ').map(point => Number(point.split(',')[0])), [12, 300, 588]);
  assert.doesNotMatch(line.attributes.points, /NaN|Infinity/);
  assert.match(section.textContent, /3 recent samples · 42 total observations/);
  assert.deepEqual(history, before);
});

test('signal chart requires two valid samples and handles identical timestamps', () => {
  const insights = harness();
  const empty = insights.signalChart({ history: [{ at: 1000, rssi: -50 }, { rssi: -40 }] });
  assert.match(empty.textContent, /Keep scanning/);
  assert.equal(all(empty).some(item => item.tag === 'svg'), false);
  const duplicate = insights.signalChart({ history: [{ at: 1000, rssi: -50 }, { at: 1000, rssi: -50 }] });
  const line = all(duplicate).find(item => item.tag === 'polyline');
  assert.doesNotMatch(line.attributes.points, /NaN|Infinity/);
});

function refreshHarness() {
  const document = { activeElement: null };
  document.createElement = tag => { const element = new Element(tag); element.ownerDocument = document; return element; };
  document.createDocumentFragment = () => document.createElement('fragment');
  document.createElementNS = (namespaceURI, tag) => { const element = document.createElement(tag); element.namespaceURI = namespaceURI; return element; };
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('function replacePreservingFocus('), source.indexOf('\nfunction empty('));
  const replacePreservingFocus = vm.runInNewContext(`(${helper})`, { document });
  return { document, insights: harness({ document, replacePreservingFocus }) };
}

test('refresh preserves disclosure and keyboard focus without carrying disclosure to another device', () => {
  const { document, insights } = refreshHarness(), container = document.createElement('div');
  const refresh = (device = target) => insights.render(container, device, [target], () => {}, () => {});
  refresh();
  all(container).find(item => item.tag === 'details').open = true;
  all(container).find(item => item.className === 'profile-tool').focus();
  refresh();
  assert.equal(all(container).find(item => item.tag === 'details').open, true);
  assert.equal(document.activeElement?.className, 'profile-tool');
  assert.ok(container.contains(document.activeElement));
  all(container).find(item => item.className === 'tracker-row').focus();
  refresh({ ...target, address: target.address.toUpperCase() });
  assert.equal(document.activeElement?.className, 'tracker-row');
  assert.equal(all(container).find(item => item.tag === 'details').open, true);
  all(container).find(item => item.tag === 'summary').focus();
  refresh();
  assert.equal(document.activeElement?.tag, 'summary');
  refresh({ ...target, addressType: 1 });
  assert.equal(all(container).find(item => item.tag === 'details').open, false);
  all(container).find(item => item.tag === 'details').open = true;
  refresh({ ...target, address: 'aa:bb:cc:dd:ee:02', addressType: 1 });
  assert.equal(all(container).find(item => item.tag === 'details').open, false);
});

test('connected GATT identification updates selected profile and category counts for matching address and type', () => {
  const insights = harness(), container = new Element('div');
  const device = { address: target.address, addressType: 0 };
  const boardState = { ble: { connected: true, address: target.address.toUpperCase(), addressType: 0 }, services: [{ uuid: '181a', characteristics: [] }] };
  const devices = [device, { ...device, addressType: 1 }, { ...device, address: 'aa:bb:cc:dd:ee:02' }];
  const refresh = (selected, state) => insights.render(container, selected, devices, () => {}, () => {}, state);
  const count = category => all(container).find(item => item.dataset.focus === `insights-category-${category}`).children.find(item => item.className === 'profile-count').textContent;
  refresh(device, boardState);
  assert.match(all(container).find(item => item.className === 'profile-card').textContent, /BLE environmental sensor/);
  assert.equal(count('sensor'), '1');
  assert.equal(count('other'), '2');
  refresh(devices[1], boardState);
  assert.match(all(container).find(item => item.className === 'profile-card').textContent, /Unclassified/);
  refresh(devices[2], boardState);
  assert.match(all(container).find(item => item.className === 'profile-card').textContent, /Unclassified/);
  refresh(device, { ...boardState, ble: { ...boardState.ble, connected: false } });
  assert.equal(count('sensor'), '0');
  refresh(device);
  assert.equal(count('other'), '3');
});
