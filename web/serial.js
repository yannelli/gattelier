'use strict';

var NanoSerial = (() => {
  const Wire = typeof module !== 'undefined' ? require('./serial-wire.js') : NanoSerialWire;

  function create(options = {}) {
    const navigator = options.navigator || globalThis.navigator;
    const timers = options.timers || globalThis;
    const secure = options.secureContext ?? globalThis.isSecureContext ?? true;
    const listeners = new Set();
    let wire, port, heartbeat, generation = 0, closePending;
    let state = 'disconnected', wifiSuspended = false, error = '';

    function status() {
      return { supported: Boolean(navigator?.serial || options.port), secure, state, connected: state === 'connected', wifiSuspended, error };
    }

    function notify() { for (const listener of listeners) listener(status()); }

    function stopHeartbeat() { timers.clearTimeout(heartbeat); }

    function lost(reason) {
      stopHeartbeat();
      if (state === 'closing' || state === 'disconnected') return;
      state = 'disconnected'; wifiSuspended = false;
      error = reason.message || 'USB connection lost. Reconnect USB to continue.';
      notify();
    }

    async function session(action, wifiOff, priority = false) {
      const response = await wire.fetch('/api/serial', {
        method: 'POST', body: JSON.stringify({ action, ...(wifiOff !== undefined ? { wifiOff } : {}) }),
        timeout: options.handshakeTimeout || 5000,
      }, priority);
      const body = await response.json();
      if (!response.ok || body.protocol !== 'gattelier-serial' || body.version !== 1 || (action !== 'close' && !body.active)) throw new Error(body.error || 'USB workbench session is unavailable. Update the board firmware and reconnect.');
      return body;
    }

    function scheduleHeartbeat(token) {
      heartbeat = timers.setTimeout(async () => {
        if (state !== 'connected' || generation !== token) return;
        try {
          const body = await session('ping');
          if (state !== 'connected' || generation !== token) return;
          wifiSuspended = Boolean(body.wifiSuspended); notify(); scheduleHeartbeat(token);
        } catch (reason) { if (generation === token) await wire.close(reason); }
      }, 10000);
    }

    async function connect({ wifiOff = true } = {}) {
      if (state === 'connected') return status();
      if (state === 'connecting' || state === 'closing') throw new Error('A USB connection change is already in progress.');
      if (!secure) throw new Error('USB requires HTTPS or localhost. Open the hosted app in Chrome.');
      if (!status().supported) throw new Error('Web Serial is unavailable. Open this app in desktop Chrome.');
      const token = ++generation;
      state = 'connecting'; error = ''; notify();
      let selected, opened = false, connection;
      try {
        selected = options.port || await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }] });
        if (generation !== token) throw new DOMException('USB connection canceled.', 'AbortError');
        if (wire) await wire.close();
        if (generation !== token) throw new DOMException('USB connection canceled.', 'AbortError');
        await selected.open({ baudRate: 115200, bufferSize: 4096, flowControl: 'none' });
        opened = true;
        if (generation !== token) throw new DOMException('USB connection canceled.', 'AbortError');
        try { await selected.setSignals({ requestToSend: false, dataTerminalReady: true }); } catch {}
        if (generation !== token) throw new DOMException('USB connection canceled.', 'AbortError');
        port = selected;
        const initialId = options.initialId || globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] || Math.floor(Math.random() * 0xffffffff) + 1;
        connection = wire = Wire.create(port, { ...options, synchronize: true, initialId, onClose: reason => { if (generation === token) lost(reason); } });
        const body = await session('open', wifiOff);
        if (generation !== token) throw new DOMException('USB connection canceled.', 'AbortError');
        wifiSuspended = Boolean(body.wifiSuspended); state = 'connected'; error = ''; notify();
        scheduleHeartbeat(token);
        return status();
      } catch (reason) {
        if (connection) await connection.close(reason);
        else if (opened) { try { await selected.close(); } catch {} }
        if (generation === token) {
          state = 'disconnected'; wifiSuspended = false;
          error = reason.name === 'NotFoundError' ? 'USB selection canceled.' : reason.name === 'NetworkError' || reason.name === 'InvalidStateError' ? 'USB port is unavailable. Close other serial tools, then reconnect.' : reason.message;
          notify();
        }
        throw new Error(error || reason.message);
      }
    }

    async function close() {
      if (closePending) return closePending;
      ++generation; stopHeartbeat();
      const connection = wire;
      state = 'closing'; notify();
      closePending = (async () => {
        if (connection) {
          connection.rejectQueued();
          try { await session('close', undefined, true); } catch {}
          await connection.close();
        }
        wire = null; port = null; state = 'disconnected'; wifiSuspended = false; error = ''; notify();
      })();
      try { await closePending; } finally { closePending = null; }
    }

    async function fetch(path, requestOptions) {
      if (state !== 'connected') throw new Error('USB is disconnected. Connect USB or select HTTP to continue.');
      const token = generation, connection = wire;
      const response = await connection.fetch(path, requestOptions);
      if (token !== generation || state !== 'connected') throw new DOMException('USB connection changed.', 'AbortError');
      if (response.status === 428) {
        const reason = new Error('USB session expired. Reconnect USB to continue.');
        await connection.close(reason); throw reason;
      }
      return response;
    }

    async function setWifiOff(value) {
      if (state !== 'connected') throw new Error('Connect USB before changing Wi-Fi.');
      const token = generation;
      try {
        const body = await session('open', Boolean(value));
        if (token !== generation || state !== 'connected') throw new DOMException('USB connection changed.', 'AbortError');
        wifiSuspended = Boolean(body.wifiSuspended); notify(); return status();
      } catch (reason) { if (token === generation) await wire.close(reason); throw reason; }
    }

    navigator?.serial?.addEventListener?.('disconnect', event => {
      if (event.target === port || event.port === port) wire?.close(new Error('USB board disconnected. Wi-Fi resumes when the board detects the disconnect or the session expires.'));
    });

    return { connect, close, fetch, status, setWifiOff, onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  }

  return { create };
})();
globalThis.NanoSerial = NanoSerial;
if (typeof module !== 'undefined') module.exports = NanoSerial;
