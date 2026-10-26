import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import apps from '../web/device-apps.js';
import recipes from '../web/recipe-model.js';
const source = readFileSync(new URL('../web/protocol-app.js', import.meta.url), 'utf8');
const coffee = { address: '02:00:00:00:00:01', addressType: 0, name: 'Vertuo_CV6_020000000001', services: ['06aa1910-f22a-11e3-9daa-0002a5d5c51b'], manufacturer: '0225000900000000', rssi: -60, lastSeenMs: 1000 };
function harness(id, initial = coffee) {
  let selected = initial, downloads = 0, forbiddenCalls = 0, exportBlob;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.classList = { add() {} }; this.ownText = ''; this.hidden = false; this.value = ''; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent || '').join(''); }
    append(...children) { this.children.push(...children); if (this.tag === 'select' && !this.value) this.value = children[0]?.value || ''; }
    replaceChildren(...children) { this.children = children; this.ownText = ''; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute() {}
    click() { if (this.tag === 'a') downloads++; this.listeners.click?.(); }
  }
  const events = {}, container = new Element('section');
  const forbidden = () => { forbiddenCalls++; throw new Error('Device access is forbidden in protocol apps.'); };
  const context = { Object, JSON, Blob, URL: { createObjectURL: blob => { exportBlob = blob; return 'blob:fixture'; }, revokeObjectURL() {} }, setTimeout: callback => callback(),
    NanoRecipeModel: recipes, NanoDeviceApps: apps, NanoInsights: { age: () => 'Seen just now' }, NanoWorkspace: { view: () => 'discover', module: () => '' },
    NanoDevicePage: { open() {} }, NanoLab: { action: forbidden }, NanoConnection: { ensure: forbidden }, fetch: forbidden,
    document: { createElement: tag => new Element(tag), addEventListener: (type, callback) => { events[type] = callback; } } };
  vm.runInNewContext(source + '\nthis.protocolApp = NanoProtocolApp;', context);
  const app = context.protocolApp.mount(container, id, { selected: () => selected }); app.render(selected, {});
  const all = () => { const nodes = []; const visit = element => { nodes.push(element); element.children.forEach(visit); }; visit(container); return nodes; };
  const label = text => all().find(node => node.tag === 'label' && node.ownText === text).children[0];
  const button = text => all().find(node => node.tag === 'button' && node.ownText === text);
  const submit = () => all().find(node => node.tag === 'form').listeners.submit({ preventDefault() {} });
  return { app, container, label, button, submit, all, events, calls: () => forbiddenCalls, downloads: () => downloads, exported: () => exportBlob.text(), select(device) { selected = device; app.render(selected, {}); } };
}
test('Vertuo settings previews preserve other fields and issue no device request', async () => {
  const h = harness('nespresso'), operation = h.label('Operation'); operation.value = 'water-hardness'; operation.listeners.change();
  h.label('Current settings HEX').value = '2c010218'; h.label('Water hardness level').value = '4'; h.submit();
  const output = JSON.parse(h.all().find(node => node.className?.includes('protocol-command-preview')).textContent);
  assert.equal(output.steps[0].hex, '2c010418'); assert.equal(h.calls(), 0);
  h.button('Export command plan').click(); assert.equal(h.downloads(), 1); assert.equal(h.calls(), 0);
  const recipe = recipes.validate(JSON.parse(await h.exported())); assert.equal(recipe.address, coffee.address); assert.equal(recipe.steps[0].hex, '2c010418');
});
test('authentication secrets cannot export and clear on leaving the app or changing target', () => {
  const h = harness('nespresso'); h.label('Authorized CMID key (16 HEX characters)').value = '8011223344556677'; h.submit();
  assert.equal(h.button('Export command plan').disabled, true); h.button('Export command plan').click(); assert.equal(h.downloads(), 0);
  h.events['nanoscope:workspace'](); assert.equal(h.label('Authorized CMID key (16 HEX characters)').value, '');
  assert.equal(h.all().find(node => node.className?.includes('protocol-command-preview')).hidden, true);
  h.label('Authorized CMID key (16 HEX characters)').value = '8011223344556677'; h.submit();
  h.select({ ...coffee, address: '02:00:00:00:00:02' }); assert.equal(h.label('Authorized CMID key (16 HEX characters)').value, ''); assert.equal(h.calls(), 0);
});
test('cloud command preview and imported purifier status stay local', () => {
  const h = harness('vesync', { name: 'Core200S', manufacturer: 'd00601', address: '02:00:00:00:00:03', addressType: 0 });
  const operation = h.label('Operation'); operation.value = 'fan-speed'; operation.listeners.change(); h.label('Fan speed').value = '3'; h.submit();
  assert.equal(JSON.parse(h.all().find(node => node.className?.includes('protocol-command-preview')).textContent).request.body.payload.data.level, 3);
  const format = h.label('Data format'); format.value = 'status'; format.listeners.change(); h.label('Captured value').value = '{"enabled":true,"level":2,"mode":"manual","filter_life":83}';
  h.button('Decode locally').click(); assert.match(h.container.textContent, /83%/); assert.equal(h.calls(), 0);
});
test('Samsung saved service data decodes locally without device requests', () => {
  const h = harness('samsung', { manufacturer: '750042040180', address: '02:00:00:00:00:04', addressType: 0 });
  const format = h.label('Data format'); format.value = 'service'; format.listeners.change();
  h.label('Service UUID').value = '0xfd5a'; h.label('Captured value').value = '120102030405060708090a0b0380000001020304';
  h.button('Decode locally').click(); assert.match(h.container.textContent, /Battery bandFull/); assert.equal(h.calls(), 0);
});
test('Samsung packet fields sit under a collapsed disclosure', () => {
  const h = harness('samsung', { address: '02:00:00:00:00:05', addressType: 0, serviceData: [{ uuid: 'fd5a', hex: '120102030405060708090a0b0380000001020304' }] });
  const details = h.all().find(node => node.tag === 'details' && node.children[0].textContent === 'Packet details');
  assert.equal(details.hidden, false); assert.notEqual(details.open, true);
  assert.match(details.textContent, /Rotating privacy ID/); assert.doesNotMatch(details.textContent, /Battery band/);
  assert.match(h.container.textContent, /Reported tag stateOffline/); assert.equal(h.calls(), 0);
});
