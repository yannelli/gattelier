'use strict';

const NanoLab = (() => {
  let latest = { ble: {}, services: [], devices: [] }, online = false, initialized = false, acting = false, fast = false;
  let eventsTimer, eventsInFlight = false, capture = NanoPackets.createCapture();
  let background = false, eventFailures = 0;
  const eventListeners = new Set(), stateListeners = new Set();
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function request(path, options = {}, timeout = 10000) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await NanoAPI.fetch(path, { ...options, signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
      return { status: response.status, body };
    } finally { clearTimeout(timer); }
  }
  function emit(listeners, ...args) {
    for (const listener of listeners) {
      try { listener(...args); } catch (error) { console.error('NanoScope listener failed:', error.message); }
    }
  }
  function update(state, available) {
    const changed = state !== latest || available !== online;
    latest = state; online = available;
    if (initialized) NanoConsole.update(state, available);
    if (changed) emit(stateListeners, state, available);
  }
  async function action(path, body = {}) {
    if (!online) throw new Error('The board is unavailable.');
    if (acting || latest.ble.busy) throw new Error('Wait for the current BLE operation to finish.');
    acting = true; NanoConsole.update(latest, online);
    document.dispatchEvent(new CustomEvent('nanoscope:busy', { detail: true }));
    try {
      const deadline = Date.now() + 45000;
      const result = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      while (Date.now() < deadline) {
        const { body: state } = await request('state', {}, Math.min(10000, deadline - Date.now()));
        update(state, true);
        document.dispatchEvent(new CustomEvent('nanoscope:state', { detail: state }));
        if (!state.ble.busy) {
          if (result.status === 202 && state.ble.error) throw new Error(state.ble.error);
          const characteristic = state.services?.flatMap(service => service.characteristics || []).find(item => item.handle === body.handle);
          if (path === 'read' && characteristic?.readError) throw new Error(characteristic.readError);
          return state;
        }
        await sleep(120);
      }
      throw new Error('BLE operation timed out after 45 seconds. Check board status before sending another command.');
    } finally {
      acting = false; NanoConsole.update(latest, online);
      document.dispatchEvent(new CustomEvent('nanoscope:busy', { detail: false }));
    }
  }
  async function pollEvents() {
    clearTimeout(eventsTimer);
    if (eventsInFlight) return;
    if (document.hidden && !fast && !background) { NanoTraffic.connection('Capture paused in background'); return; }
    eventsInFlight = true;
    try {
      const { body } = await request(`events?after=${capture.snapshot().nextSeq}`);
      const result = capture.ingest(body);
      eventFailures = 0;
      emit(eventListeners, result.events, result.meta);
      NanoTraffic.connection(fast ? 'Live transfer capture' : document.hidden ? 'Background capture · checked every 30 seconds' : 'Event journal connected');
      NanoTraffic.refresh();
    } catch (error) {
      eventFailures = Math.min(eventFailures + 1, 5);
      NanoTraffic.connection(error.name === 'AbortError' ? 'Capture request timed out; retrying' : `Capture unavailable: ${error.message}`);
    } finally {
      eventsInFlight = false;
      const active = latest.ble?.connected || latest.ble?.captureAddress;
      const delay = fast ? 100 : eventFailures ? Math.min(30000, 1500 * 2 ** eventFailures) : document.hidden ? 30000 : active ? 350 : 5000;
      eventsTimer = setTimeout(pollEvents, delay);
    }
  }
  function init() {
    if (initialized) return;
    initialized = true;
    NanoConsole.mount(document.getElementById('command-panel'), api);
    NanoTraffic.mount(document.getElementById('traffic-panel'), () => capture.snapshot());
    document.addEventListener('visibilitychange', () => { if (!eventsInFlight) pollEvents(); });
    globalThis.addEventListener('nanoscope:api-change', () => {
      latest = { ble: {}, services: [], devices: [] }; online = false; acting = false; capture = NanoPackets.createCapture();
      emit(stateListeners, latest, false);
      document.dispatchEvent(new CustomEvent('nanoscope:busy', { detail: false }));
    });
    pollEvents();
  }
  const api = {
    init, update, action, getState: () => latest, isActing: () => acting,
    onEvents(callback) { eventListeners.add(callback); return () => eventListeners.delete(callback); },
    onState(callback) { stateListeners.add(callback); callback(latest, online); return () => stateListeners.delete(callback); },
    setBackgroundCapture(enabled) { const next = Boolean(enabled); if (next === background) return; background = next; if (initialized && !eventsInFlight) pollEvents(); },
    setFastCapture(enabled) { fast = Boolean(enabled); if (!eventsInFlight) { clearTimeout(eventsTimer); eventsTimer = setTimeout(pollEvents, 0); } }
  };
  return api;
})();
globalThis.NanoLab = NanoLab;
