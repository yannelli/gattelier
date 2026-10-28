'use strict';

const NanoLab = (() => {
  let latest = { ble: {}, services: [], devices: [] }, online = false, initialized = false, acting = false, fast = false;
  let eventsTimer, eventsInFlight = false, capture = NanoPackets.createCapture();
  let background = false, eventFailures = 0;
  let connectionAction = null;
  let generation = 0;
  const eventListeners = new Set(), stateListeners = new Set();
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  function assertCurrent(token) {
    if (token !== generation) throw Object.assign(new Error('Board connection changed.'), { name: 'AbortError' });
  }
  async function request(path, options = {}, timeout = 10000, token = generation) {
    assertCurrent(token);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await NanoAPI.fetch(path, { ...options, signal: controller.signal });
      assertCurrent(token);
      const body = await response.json();
      assertCurrent(token);
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
    if (path === 'cancel-connect') return cancelConnect(body);
    if (acting || latest.ble.busy) throw new Error('Wait for the current BLE operation to finish.');
    const token = generation;
    let connecting;
    if (path === 'connect') {
      const target = body.address ? body : latest.devices?.find(device => device.id === body.id);
      let resolve, reject; const accepted = new Promise((yes, no) => { resolve = yes; reject = no; }); accepted.catch(() => {});
      connecting = connectionAction = { address: String(target?.address || '').toLowerCase(), addressType: target?.addressType, accepted, resolve, reject, cancellation: null };
    }
    acting = true; NanoConsole.update(latest, online);
    document.dispatchEvent(new CustomEvent('nanoscope:busy', { detail: true }));
    try {
      const deadline = Date.now() + 45000;
      const result = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 10000, token);
      assertCurrent(token);
      connecting?.resolve(result.body);
      while (Date.now() < deadline) {
        const { body: state } = await request('state', {}, Math.min(10000, deadline - Date.now()), token);
        assertCurrent(token);
        update(state, true);
        document.dispatchEvent(new CustomEvent('nanoscope:state', { detail: state }));
        if (!state.ble.busy) {
          if (result.status === 202 && state.ble.error) throw new Error(state.ble.error);
          const characteristic = state.services?.flatMap(service => service.characteristics || []).find(item => item.handle === body.handle);
          if (path === 'read' && characteristic?.readError) throw new Error(characteristic.readError);
          return state;
        }
        await sleep(120);
        assertCurrent(token);
      }
      throw new Error('BLE operation timed out after 45 seconds. Check board status before sending another command.');
    } catch (error) { connecting?.reject(error); throw error; }
    finally {
      if (connecting && connectionAction === connecting) connectionAction = null;
      if (token === generation) {
        acting = false; NanoConsole.update(latest, online);
        document.dispatchEvent(new CustomEvent('nanoscope:busy', { detail: false }));
      }
    }
  }
  async function cancelConnect(body) {
    const token = generation;
    const target = String(body.address || '').toLowerCase();
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(target) || !Number.isInteger(body.addressType) || body.addressType < 0 || body.addressType > 3) throw new Error('Choose the device whose connection is in progress.');
    const connecting = connectionAction && connectionAction.address === target && connectionAction.addressType === body.addressType ? connectionAction : null;
    if (connecting?.cancellation) return connecting.cancellation;
    const operation = async () => {
      const scope = connecting ? await connecting.accepted : body;
      assertCurrent(token);
      const attempt = scope.connectionAttempt;
      if (!Number.isInteger(attempt) || attempt < 1 || attempt > 0xffffffff || connecting && (String(scope.address).toLowerCase() !== target || scope.addressType !== body.addressType) || body.connectionAttempt !== undefined && body.connectionAttempt !== attempt) throw new Error('This connection attempt is no longer active.');
      if (!connecting) {
        const ble = latest.ble;
        if (!ble.busy || !['connecting', 'discovering', 'cancelling'].includes(ble.operation) || String(ble.address).toLowerCase() !== target || ble.addressType !== body.addressType || ble.connectionAttempt !== attempt) throw new Error('This connection attempt is no longer active.');
      }
      await request('cancel-connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: target, addressType: body.addressType, connectionAttempt: attempt }) }, 10000, token);
      assertCurrent(token);
      const { body: state } = await request('state', {}, 10000, token);
      assertCurrent(token); update(state, true);
      document.dispatchEvent(new CustomEvent('nanoscope:state', { detail: state }));
      return state;
    };
    const promise = operation();
    if (connecting) connecting.cancellation = promise;
    try { return await promise; } finally { if (connecting?.cancellation === promise) connecting.cancellation = null; }
  }
  async function pollEvents() {
    clearTimeout(eventsTimer);
    if (eventsInFlight) return;
    if (document.hidden && !fast && !background) { NanoTraffic.connection('Capture paused in background'); return; }
    const token = generation;
    eventsInFlight = true;
    try {
      const { body } = await request(`events?after=${capture.snapshot().nextSeq}`, {}, 10000, token);
      assertCurrent(token);
      const result = capture.ingest(body);
      eventFailures = 0;
      emit(eventListeners, result.events, result.meta);
      NanoTraffic.connection(fast ? 'Live transfer capture' : document.hidden ? latest.ble?.connected ? 'Connected session capture' : 'Background capture · checked every 30 seconds' : 'Event journal connected');
      NanoTraffic.refresh();
    } catch (error) {
      if (token !== generation) return;
      eventFailures = Math.min(eventFailures + 1, 5);
      NanoTraffic.connection(error.name === 'AbortError' ? 'Capture request timed out; retrying' : `Capture unavailable: ${error.message}`);
    } finally {
      if (token === generation) {
        eventsInFlight = false;
        const active = latest.ble?.connected || latest.ble?.captureAddress;
        const delay = fast ? 100 : eventFailures ? Math.min(30000, 1500 * 2 ** eventFailures) : active ? document.hidden ? 1000 : 350 : document.hidden ? 30000 : 5000;
        eventsTimer = setTimeout(pollEvents, delay);
      }
    }
  }
  function init() {
    if (initialized) return;
    initialized = true;
    NanoConsole.mount(document.getElementById('command-panel'), api);
    NanoTraffic.mount(document.getElementById('traffic-panel'), () => capture.snapshot());
    document.addEventListener('visibilitychange', () => { if (!eventsInFlight) pollEvents(); });
    globalThis.addEventListener('nanoscope:api-change', () => {
      generation++; clearTimeout(eventsTimer); eventsInFlight = false; eventFailures = 0;
      connectionAction?.reject(Object.assign(new Error('Board connection changed.'), { name: 'AbortError' })); connectionAction = null;
      latest = { ble: {}, services: [], devices: [] }; online = false; acting = false; capture = NanoPackets.createCapture();
      emit(stateListeners, latest, false);
      document.dispatchEvent(new CustomEvent('nanoscope:busy', { detail: false }));
      pollEvents();
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
