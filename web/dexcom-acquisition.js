'use strict';

const NanoDexcomAcquisition = (() => {
  const WINDOW_MS = 10 * 60 * 1000;
  const same = (a, b) => Boolean(a?.address && b?.address && a.address.toLowerCase() === b.address.toLowerCase() && a.addressType === b.addressType);
  const transient = reason => /^(?:Connection timed out\.|Connection failed \(BLE code \d+\)\. Retry using this device's known address\.|Connect failed(?: \(BLE code \d+\))?\.?|Device disconnected \(BLE code \d+\)\.|Dexcom disconnected\.|Dexcom (?:auth|extra|control|backfill) response timed out\.|The device did not establish a connection\. Try again\.)$/i.test(reason?.message || '');
  function create(lab, options = {}) {
    const now = options.now || Date.now, packets = typeof NanoPackets !== 'undefined' ? NanoPackets : require('./packets.js');
    const streams = typeof NanoScanStream !== 'undefined' ? NanoScanStream : require('./scan-stream.js');
    let target = null, active = false, startedAt = 0, deadline = 0, lastSeenAt = null, lastAttemptAt = null, attempts = 0, attemptStatus = '', lastAttemptStatus = '';
    let timer = null, pollTimer = null, stream = null, waiter = null, controller = null, scanning = false, scanOwned = false, epoch = 0, polling = null;
    let boot = null, cursor = 0, afterMs = 0, capture = packets.createCapture(), eventBoot = null, eventCursor = 0, eventPrimed = false;
    let state = lab.getState(), online = false, captureGaps = 0, initialGaps = null, restoreOwned = false, lifetime = new AbortController();
    const changed = () => options.onChange?.(snapshot());
    const remaining = () => Math.max(0, deadline - now());
    function snapshot() { return { active, startedAt, deadline, remainingMs: active ? remaining() : 0, lastSeenAt, lastAttemptAt, attempts, attemptStatus, lastAttemptStatus, packetCount: capture.snapshot().events.length }; }
    function guard() {
      if (!active) throw new Error('Dexcom acquisition cancelled.');
      if (remaining() <= 0) { expire(); throw new Error('The ten-minute G7 acquisition window ended.'); }
      if (!online) throw new Error('The board is unavailable.');
      if (state.ble?.connected && !same(state.ble, target)) throw new Error('Another device is connected. Disconnect it before acquiring G7.');
      if (state.collection?.enabled) throw new Error('Stop collection before acquiring G7.');
    }
    function finishWait(error, value) {
      if (!waiter) return;
      const pending = waiter; waiter = null; clearTimeout(pollTimer); pollTimer = null;
      if (error) pending.reject(error); else pending.resolve(value);
    }
    function close(message = 'Dexcom acquisition cancelled.') {
      const wasActive = active;
      restoreOwned ||= scanOwned && online; epoch++;
      active = false; scanning = false; scanOwned = false; polling = null;
      lifetime.abort(new Error(message));
      clearInterval(timer); timer = null; clearTimeout(pollTimer); pollTimer = null;
      controller?.abort(); controller = null; stream?.destroy(); stream = null;
      finishWait(new Error(message)); if (wasActive) lab.setFastCapture?.(false); changed();
      return releaseScan();
    }
    function releaseScan() {
      if (restoreOwned && !active && online && !lab.isActing?.() && !lab.getState().ble?.busy && !lab.getState().ble?.connected && lab.getState().ble?.scanEnabled) {
        restoreOwned = false;
        return Promise.resolve(lab.action('stop-scan')).catch(error => { attemptStatus = error.message; changed(); });
      }
      return Promise.resolve();
    }
    function until(operation) {
      const signal = lifetime.signal;
      if (signal.aborted) { Promise.resolve(operation).catch(() => {}); return Promise.reject(signal.reason); }
      let abort;
      const stopped = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
      return Promise.race([operation, stopped]).finally(() => signal.removeEventListener('abort', abort));
    }
    function expire() {
      if (!active) return;
      const error = new Error('The ten-minute G7 acquisition window ended.');
      close(error.message); options.onExpire?.(error);
    }
    const offState = lab.onState((next, available = true) => {
      state = next; online = available;
      if (active && (!online || state.ble?.connected && !same(state.ble, target))) {
        const error = new Error(online ? 'Another device is connected. G7 acquisition stopped.' : 'The board is unavailable.');
        close(error.message); options.onExpire?.(error);
      }
    });
    const offEvents = lab.onEvents((events, meta = {}) => {
      const reboot = eventBoot && meta.bootId && eventBoot !== meta.bootId;
      if (reboot) eventCursor = 0;
      if (meta.bootId) eventBoot = meta.bootId;
      const floor = eventCursor;
      eventCursor = Math.max(eventCursor, Number(meta.cursor || meta.nextSeq) || 0, ...events.map(event => event.seq || 0));
      if (!active) return;
      if (remaining() <= 0) { expire(); return; }
      if (reboot || meta.reboot) { const error = new Error('The board restarted during G7 acquisition.'); close(error.message); options.onExpire?.(error); return; }
      if (!eventPrimed) { eventPrimed = true; initialGaps = Number(meta.gaps) || 0; return; }
      captureGaps = Math.max(0, (Number(meta.gaps) || 0) - initialGaps);
      const fresh = events.filter(event => event.seq > floor && event.address?.toLowerCase() === target.address.toLowerCase()
        && (event.addressType === undefined ? same(state.ble, target) : event.addressType === target.addressType));
      capture.ingest({ ...meta, bootId: eventBoot, events: fresh, oldestSeq: floor + 1 });
      if (fresh.length) changed();
    });
    function ingestAdvertisements(batch) {
      const previous = cursor; cursor = Math.max(cursor, Number(batch.cursor || batch.nextSeq) || 0);
      if (!active) return { cursor };
      if (remaining() <= 0) { expire(); return { cursor }; }
      if (boot && batch.bootId !== boot) { const error = new Error('The board restarted during G7 acquisition.'); close(error.message); options.onExpire?.(error); return { cursor }; }
      boot = batch.bootId;
      for (const record of batch.devices || []) {
        if (!Number.isInteger(record.seq) || record.seq <= previous || !same(record, target) || !Number.isFinite(record.ms) || !Number.isFinite(batch.uptime)) continue;
        const age = batch.uptime * 1000 - record.ms;
        if (record.ms <= afterMs || age < -1000 || age > 2000) continue;
        afterMs = record.ms; lastSeenAt = now() - Math.max(0, age); attemptStatus = record.connectable === false ? 'Sensor seen; advertisement is not connectable' : 'Sensor advertisement received'; changed();
        if (record.connectable !== false && waiter && !state.ble?.busy && !lab.isActing?.()) finishWait(null, record);
      }
      return { cursor };
    }
    async function readScan(token) {
      if (!active || !waiter || token !== epoch) return;
      try {
        guard();
        if (options.fetch || typeof NanoAPI !== 'undefined') {
          const current = controller = new AbortController();
          const timeout = setTimeout(() => current.abort(), Math.min(8000, remaining()));
          try {
            const response = await (options.fetch || ((...args) => NanoAPI.fetch(...args)))('state?devices=0', { signal: current.signal });
            const next = await response.json();
            if (!active || token !== epoch) return;
            if (!response.ok) throw new Error(next.error || 'G7 board status request failed.');
            state = next; lab.update?.(next, true); guard();
          } finally { clearTimeout(timeout); if (controller === current) controller = null; }
        }
        if (!state.ble?.connected && !state.ble?.busy && !lab.isActing?.()) {
          if (!state.ble?.scanning && !scanning) {
            scanning = true; const ownScan = !state.ble?.scanEnabled; scanOwned ||= ownScan;
            try { state = await lab.action('scan'); } finally { scanning = false; }
            if (!active || token !== epoch) { if (ownScan && !active && !state.ble?.connected) await lab.action('stop-scan'); return; }
          }
          await stream.poll();
          if (!active || token !== epoch) return;
          if (stream.status().supported === false) throw new Error('G7 acquisition requires the advertisement stream. Update the board firmware.');
          if (stream.status().error) { attemptStatus = stream.status().error; changed(); }
        }
      } catch (error) {
        if (!active || token !== epoch) return;
        if (/Another device|collection|requires the advertisement/.test(error.message)) { close(error.message); options.onExpire?.(error); return; }
        attemptStatus = error.message; changed();
      }
      if (active && waiter && token === epoch) pollTimer = setTimeout(() => poll(token), options.scanPollMs ?? 200);
    }
    function poll(token = epoch) {
      if (polling || !active || !waiter) return polling || Promise.resolve();
      clearTimeout(pollTimer); pollTimer = null;
      const operation = readScan(token); polling = operation;
      operation.finally(() => { if (polling === operation) polling = null; });
      return operation;
    }
    function open(device) {
      if (active) throw new Error('A G7 acquisition window is already running.');
      if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(device?.address || '') || !Number.isInteger(device.addressType) || device.addressType < 0 || device.addressType > 3) throw new Error('Choose a G7 sensor with a usable Bluetooth address type.');
      target = { ...device }; active = true; lifetime = new AbortController(); startedAt = now(); deadline = startedAt + Math.min(WINDOW_MS, options.windowMs ?? WINDOW_MS);
      try { guard(); } catch (error) { active = false; throw error; }
      attempts = 0; lastSeenAt = lastAttemptAt = null; lastAttemptStatus = ''; attemptStatus = 'Waiting for a matching sensor advertisement';
      boot = null; cursor = afterMs = captureGaps = 0; capture = packets.createCapture(); eventPrimed = false; initialGaps = null; epoch++;
      stream = streams.create({ ingestAdvertisements }, { fetch: options.fetch, now });
      timer = setInterval(() => { if (remaining() <= 0) expire(); else changed(); }, Math.min(1000, options.windowMs ?? WINDOW_MS));
      lab.setFastCapture?.(true); changed();
    }
    function next(reuse = false) {
      guard();
      if (reuse && state.ble?.connected && same(state.ble, target) && !state.ble?.busy) return Promise.resolve(state.ble);
      if (waiter) throw new Error('Already waiting for a G7 advertisement.');
      attemptStatus = 'Waiting for a matching sensor advertisement'; changed();
      const promise = new Promise((resolve, reject) => { waiter = { resolve, reject }; });
      poll(epoch); return promise;
    }
    function attempted(message = 'Connecting to the observed sensor') { attempts++; lastAttemptAt = now(); lastAttemptStatus = attemptStatus = message; changed(); }
    function captureSnapshot() { const saved = capture.snapshot(); return { ...saved, stats: { ...saved.stats, gaps: captureGaps }, scope: target, acquisition: snapshot() }; }
    return { open, next, guard, close, snapshot, captureSnapshot, attempted, same, transient, poll, until, releaseScan,
      result(message) { lastAttemptStatus = attemptStatus = message; changed(); },
      destroy() { close(); offState?.(); offEvents?.(); } };
  }
  return { create, WINDOW_MS, same, transient };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcomAcquisition;
