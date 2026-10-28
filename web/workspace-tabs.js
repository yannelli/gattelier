'use strict';

const NanoWorkspaceTabs = (() => {
  const storageKey = 'nanoscope.workspace.tabs.v1';
  const validTarget = device => typeof device?.address === 'string' && /^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(device.address) && Number.isInteger(device.addressType) && device.addressType >= 0 && device.addressType <= 3;
  const key = device => validTarget(device) ? `${device.address.toLowerCase()}/${device.addressType}` : '';
  function connected(device, state = {}) {
    if (typeof NanoDeviceLibrary !== 'undefined') return NanoDeviceLibrary.connected(device, state);
    return Boolean(state.ble?.connected && device?.address && state.ble.address && device.address.toLowerCase() === state.ble.address.toLowerCase() && device.addressType === state.ble.addressType);
  }
  function target(device) {
    if (!key(device)) return null;
    const services = (Array.isArray(device.services) ? device.services : []).filter(value => typeof value === 'string' && /^(?:(?:0x)?(?:[\da-f]{4}|[\da-f]{8})|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(value)).slice(0, 32);
    return { address: device.address, addressType: device.addressType,
      name: String(device.name || '').slice(0, 128), gattName: String(device.gattName || '').slice(0, 128), label: String(device.label || '').slice(0, 128),
      manufacturerName: String(device.manufacturerName || '').slice(0, 128), glyph: String(device.glyph || '').slice(0, 4),
      services, serviceData: [], payloadHex: '', manufacturer: '', rssi: null, connectable: typeof device.connectable === 'boolean' ? device.connectable : undefined };
  }
  function identity(tab) { return `${tab.kind}:${tab.module || ''}:${key(tab.target).toLowerCase()}`; }
  function appearance(tab) {
    const name = [tab.target?.label, tab.target?.name, tab.target?.gattName].find(value => typeof value === 'string' && value.trim())?.trim() || tab.target?.address || tab.title;
    const manufacturer = tab.target?.manufacturerName || tab.module || name || 'Device';
    let hash = 0;
    for (const character of manufacturer) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    const glyph = tab.target?.glyph || (tab.target?.manufacturerName || tab.module || 'BT').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase();
    return { name, glyph, hue: hash % 360 };
  }
  function create(options = {}) {
    let storage; try { storage = options.storage ?? globalThis.localStorage; } catch {}
    let items = [], active = '', sequence = 0;
    try {
      const raw = storage?.getItem(storageKey) || 'null';
      const saved = raw.length <= 131072 ? JSON.parse(raw) : null;
      const seen = new Set();
      for (const item of Array.isArray(saved?.items) ? saved.items.slice(0, 24) : []) {
        if (!['device', 'app'].includes(item?.kind) || item.kind === 'app' && !options.modules?.[item.module]) continue;
        const entry = { id: `session-${++sequence}`, kind: item.kind, module: item.kind === 'app' ? item.module : '',
          title: item.kind === 'app' ? options.modules[item.module] : 'Device', target: target(item.target) };
        if (item.target && !entry.target || entry.kind === 'device' && !entry.target || seen.has(identity(entry))) continue;
        seen.add(identity(entry)); items.push(entry);
        if (saved.active === item.id) active = entry.id;
      }
    } catch {}
    function save() { try { storage?.setItem(storageKey, JSON.stringify({ items, active })); } catch {} }
    function changed() { save(); options.changed?.(); }
    function select(id, restore = true) {
      const item = items.find(value => value.id === id);
      if (!item) return false;
      active = id; changed(); if (restore) options.selected?.(item); return true;
    }
    function open(kind, module, device) {
      if (kind === 'app' && !options.modules?.[module] || kind === 'device' && !key(device)) return null;
      const entry = { kind, module: module || '', title: kind === 'app' ? options.modules[module] : 'Device', target: target(device) };
      let item = items.find(value => identity(value) === identity(entry));
      if (!item) {
        if (items.length >= 24) items.splice(items.findIndex(value => value.id !== active), 1);
        item = { ...entry, id: `session-${++sequence}` }; items.push(item);
      }
      else item.target = entry.target;
      select(item.id, false); return item;
    }
    function close(id) {
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return false;
      const selected = active === id;
      items.splice(index, 1);
      if (selected) active = items[Math.min(index, items.length - 1)]?.id || '';
      changed();
      if (selected) options.selected?.(items.find(item => item.id === active) || null);
      return true;
    }
    function setTarget(device) {
      const item = items.find(value => value.id === active);
      if (!item || item.kind === 'device' || !key(device)) return;
      const next = target(device);
      if (JSON.stringify(item.target) === JSON.stringify(next)) return;
      const duplicate = items.find(value => value !== item && identity(value) === identity({ ...item, target: next }));
      if (duplicate) { active = duplicate.id; duplicate.target = next; items = items.filter(value => value !== item); }
      else item.target = next;
      changed();
    }
    return { open, close, select, setTarget, list: () => items.map(item => ({ ...item, target: item.target && { ...item.target } })),
      current: () => items.find(item => item.id === active) || null, deactivate() { active = ''; changed(); } };
  }
  function mount(root, model) {
    let signature = '', activeId = '';
    function reveal() {
      const tab = document.getElementById(model.current()?.id)?.parentElement?.getBoundingClientRect?.(), viewport = root.getBoundingClientRect?.();
      if (tab && viewport) root.scrollLeft += tab.left < viewport.left ? tab.left - viewport.left : tab.right > viewport.right ? tab.right - viewport.right : 0;
    }
    globalThis.addEventListener?.('resize', reveal);
    function render({ state = {}, online = false } = {}) {
      const items = model.list(), current = model.current()?.id;
      const next = JSON.stringify([items, current, online, state.ble?.connected, state.ble?.address, state.ble?.addressType]);
      if (next === signature) return;
      signature = next;
      const focus = root.contains(document.activeElement) ? document.activeElement?.dataset : null;
      const content = document.createDocumentFragment();
      if (!items.length) {
        const empty = document.createElement('span'); empty.className = 'session-tabs-empty';
        empty.textContent = 'Open a device or app to keep it here'; content.append(empty);
      }
      for (const item of items) {
        const look = appearance(item), selected = current === item.id;
        const linked = online && connected(item.target, state);
        const group = document.createElement('div'); group.className = 'session-tab'; group.dataset.active = String(selected);
        group.style.setProperty('--tab-hue', look.hue);
        const button = document.createElement('button'); button.type = 'button'; button.id = item.id;
        button.className = 'session-tab-select'; button.dataset.tab = item.id; button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(selected)); button.setAttribute('aria-controls', `view-${item.kind === 'app' ? 'apps' : 'device'}`);
        button.tabIndex = selected || !current && item === items[0] ? 0 : -1;
        const label = item.kind === 'app' ? `${item.title}${item.target ? `: ${look.name}` : ''}` : look.name;
        button.setAttribute('aria-label', `${label}${linked ? ', connected' : ''}`); button.title = label;
        const glyph = document.createElement('span'); glyph.className = 'session-glyph'; glyph.textContent = look.glyph; glyph.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span'); text.className = 'session-tab-label';
        const title = document.createElement('strong'); title.textContent = item.kind === 'app' ? item.title : look.name;
        const subtitle = document.createElement('small'); subtitle.textContent = item.kind === 'app' ? item.target ? look.name : 'Choose a device' : item.target?.manufacturerName || 'Device';
        const dot = document.createElement('span'); dot.className = `session-dot${linked ? ' connected' : ''}`; dot.setAttribute('aria-hidden', 'true');
        text.append(title, subtitle); button.append(glyph, text, dot);
        button.addEventListener('click', () => model.select(item.id));
        button.addEventListener('keydown', event => {
          const index = items.findIndex(value => value.id === item.id);
          const nextIndex = { ArrowRight: (index + 1) % items.length, ArrowLeft: (index + items.length - 1) % items.length, Home: 0, End: items.length - 1 }[event.key];
          if (nextIndex !== undefined) { event.preventDefault(); model.select(items[nextIndex].id); document.getElementById(items[nextIndex].id)?.focus(); }
          if (event.key === 'Delete') { event.preventDefault(); model.close(item.id); focusCurrent(); }
        });
        const close = document.createElement('button'); close.type = 'button'; close.className = 'session-tab-close'; close.textContent = '×';
        close.dataset.closeTab = item.id; close.setAttribute('aria-label', `Close ${label}`); close.title = 'Close tab (Delete)';
        close.addEventListener('click', () => { model.close(item.id); focusCurrent(); });
        group.append(button, close); content.append(group);
      }
      root.replaceChildren(content);
      if (current !== activeId) { activeId = current; reveal(); }
      if (focus?.tab) document.getElementById(focus.tab)?.focus({ preventScroll: true });
      if (focus?.closeTab) [...root.querySelectorAll('[data-close-tab]')].find(item => item.dataset.closeTab === focus.closeTab)?.focus({ preventScroll: true });
    }
    function focusCurrent() { (document.getElementById(model.current()?.id) || root.querySelector('[role="tab"]') || document.getElementById('tab-discover'))?.focus(); }
    return { render };
  }
  return { create, mount, key, appearance, connected };
})();
if (typeof module !== 'undefined') module.exports = NanoWorkspaceTabs;
