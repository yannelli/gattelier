import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import recorders from '../web/recorders.js';
import profiles from '../web/profiles.js';
import library from '../web/device-library.js';
import apps from '../web/device-apps.js';
const source = readFileSync(new URL('../web/modules.js', import.meta.url), 'utf8');
test('opening or selecting a passive app preserves an active G7 operation and global selection', () => {
  const globalDevice = { name: 'DXCMab', address: '02:00:00:00:00:01', addressType: 1 };
  const coffee = { name: 'Vertuo_CV6_TEST', address: '02:00:00:00:00:02', addressType: 0, manufacturer: '0225000900000000', services: ['06aa1910-f22a-11e3-9daa-0002a5d5c51b'] };
  let selectionCalls = 0, active = '', renderedTarget;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.classList = { add() {} }; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute() {}
    addEventListener(type, callback) { this.listeners[type] = callback; }
  }
  const ids = new Map(), get = id => { if (!ids.has(id)) ids.set(id, new Element('div')); return ids.get(id); };
  const context = { NanoRecorders: recorders, NanoProfiles: profiles, NanoDeviceLibrary: library, NanoDeviceApps: apps,
    NanoLab: { getState: () => ({ ble: { busy: true, connected: true, operation: 'authenticating', address: globalDevice.address, addressType: 1 } }) },
    NanoWorkspace: { module: () => active, openModule: id => { active = id; } },
    NanoConnection: { describe: () => ({}), controls: () => new Element('div') }, NanoDexcom: { mount() {} }, NanoDeviceSupport: { families: {} },
    NanoProtocolApp: { mount: (_panel, _id, hooks) => ({ render(device) { renderedTarget = device; assert.equal(hooks.selected(), device); } }) },
    NanoBeaconApp: { mount: () => ({ render() {} }) },
    NanoSensorApp: { mount: () => ({ render() {} }) },
    replacePreservingFocus: (element, content) => element.replaceChildren(content),
    document: { createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'), getElementById: get }
  };
  vm.runInNewContext(source + '\nthis.apps = NanoModules;', context);
  context.apps.mount({ selected: () => globalDevice, devices: () => [globalDevice, coffee], select: () => { selectionCalls++; } });
  context.apps.render(globalDevice, [globalDevice, coffee]);
  const nodes = []; const visit = element => { nodes.push(element); element.children.forEach(visit); }; visit(get('apps-catalog'));
  nodes.find(node => node.tag === 'button' && node.textContent === 'Open Nespresso').listeners.click();
  assert.equal(active, 'nespresso'); assert.equal(renderedTarget, coffee); assert.equal(selectionCalls, 0);
  const picker = nodes.find(node => node.tag === 'select' && node.dataset.focus === 'app-device-nespresso'); picker.value = `${coffee.address}/0`; picker.listeners.change();
  assert.equal(selectionCalls, 0); assert.equal(renderedTarget, coffee);
});
