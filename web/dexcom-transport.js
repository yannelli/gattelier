'use strict';

const NanoDexcomTransport = (() => {
  function create(lab, options = {}) {
    const p = typeof NanoDexcomProtocol !== 'undefined' ? NanoDexcomProtocol : require('./dexcom-protocol.js');
    const commands = typeof NanoDexcomCommands !== 'undefined' ? NanoDexcomCommands : require('./dexcom-commands.js');
    const timeout = options.timeoutMs ?? 15000, waiters = new Set(), queue = [];
    let state = lab.getState(), online = false, target = null, mapping, attempt, boot = '', cursor = 0, gaps = 0, priming = null, failed = '', bootWallTime = null;
    function fail(message) {
      if (!target || failed) return;
      failed = message; queue.length = 0;
      for (const item of [...waiters]) item.reject(new Error(message));
      options.onFailure?.(new Error(message));
    }
    function guard() {
      if (failed) throw new Error(failed);
      if (!target || !online || !state.ble?.connected || state.ble.address?.toLowerCase() !== target.address || state.ble.addressType !== undefined && state.ble.addressType !== target.addressType || state.ble.connectionAttempt !== attempt) throw new Error('Dexcom connection changed. Reconnect the selected sensor.');
      return mapping;
    }
    function wait(channel, accepts = () => true, milliseconds = timeout) {
      guard();
      const index = queue.findIndex(item => item.channel === channel && accepts(item.data));
      if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]);
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
      const item = { channel, accepts, timer: null, resolve(value) { clearTimeout(item.timer); waiters.delete(item); resolve(value); }, reject(error) { clearTimeout(item.timer); waiters.delete(item); reject(error); } };
      item.timer = setTimeout(() => { item.reject(new Error(`Dexcom ${channel} response timed out.`)); fail(`Dexcom ${channel} response timed out.`); }, milliseconds); waiters.add(item);
      return promise;
    }
    async function collect(channel, length) {
      if (!Number.isInteger(length) || length < 1 || length > 4096) throw new Error('Invalid Dexcom response length.');
      const result = new Uint8Array(length); let offset = 0;
      while (offset < length) {
        const { data } = await wait(channel); guard();
        if (!data.length || offset + data.length > length) throw new Error('Dexcom fragmented response exceeded its declared length.');
        result.set(data, offset); offset += data.length;
      }
      return result;
    }
    const offEvents = lab.onEvents((events, meta = {}) => {
      const changedBoot = boot && meta.bootId && boot !== meta.bootId;
      if (target && changedBoot) fail('The board restarted during the Dexcom session.');
      if (changedBoot) { cursor = 0; bootWallTime = null; }
      if (meta.bootId) boot = meta.bootId;
      if (target && !priming && (meta.dropped || Number(meta.gaps || 0) > gaps)) fail('Dexcom capture has a gap. Reconnect before continuing.');
      gaps = Number(meta.gaps) || 0;
      for (const event of events) {
        const floor = cursor;
        cursor = Math.max(cursor, event.seq || 0);
        if (!target || failed || priming || !Number.isInteger(event.seq) || event.seq <= floor || event.address?.toLowerCase() !== target.address) continue;
        if (event.bootId && boot && event.bootId !== boot) continue;
        if (event.kind === 'disconnect') { fail('Dexcom disconnected.'); continue; }
        if (!['notification', 'indication'].includes(event.kind)) continue;
        const entry = Object.entries(mapping).find(([, item]) => item.handle === event.handle);
        if (!entry) continue;
        const [channel, characteristic] = entry;
        if (event.uuid?.toLowerCase() !== characteristic.uuid.toLowerCase()) { fail('Dexcom notification UUID does not match the discovered handle.'); continue; }
        if (event.truncated || event.redacted || event.success === false) { fail('Dexcom notification is incomplete or redacted.'); continue; }
        try {
          const data = p.bytes(event.hex);
          if (event.length !== undefined && event.length !== data.length) throw new Error('Dexcom notification length does not match the captured bytes.');
          const wallTime = options.now?.() ?? Date.now();
          const receivedAt = bootWallTime !== null && Number.isFinite(event.ms) ? bootWallTime + event.ms : wallTime;
          if (receivedAt > wallTime + 1000) throw new Error('Dexcom packet timestamp exceeds the current board clock.');
          const packet = { channel, data, event, receivedAt: Math.min(wallTime, receivedAt) };
          options.onPacket?.(packet);
          const pending = [...waiters].find(item => item.channel === channel && item.accepts(data));
          if (pending) pending.resolve(packet);
          else { if (queue.length >= 512) throw new Error('Dexcom receive queue overflowed.'); queue.push(packet); }
        } catch (error) { fail(error.message); }
      }
      cursor = Math.max(cursor, Number(meta.cursor || meta.nextSeq) || 0);
      if (priming) { const resolve = priming; priming = null; resolve(); }
    });
    const offState = lab.onState((next, available = true) => {
      state = next; online = available;
      if (Number.isFinite(state.uptime)) bootWallTime = (options.now?.() ?? Date.now()) - state.uptime * 1000;
      if (target && !failed) { try { guard(); } catch (error) { fail(error.message); } }
    });
    async function begin(device) {
      if (target) stop();
      mapping = commands.handles(state); target = { address: device.address.toLowerCase(), addressType: device.addressType };
      attempt = state.ble.connectionAttempt; failed = ''; queue.length = 0; guard();
      const sync = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { priming = null; reject(new Error('Dexcom packet capture did not synchronize.')); }, timeout);
        priming = () => { clearTimeout(timer); resolve(); };
      });
      lab.setFastCapture?.(true); await sync; guard();
      return mapping;
    }
    async function write(channel, data, response = true) {
      const characteristic = guard()[channel];
      const result = await lab.action('write', { handle: characteristic.handle, hex: p.hex(data), response }); guard(); return result;
    }
    async function sendExtra(data) {
      for (let offset = 0; offset < data.length; offset += 20) {
        await new Promise(resolve => setTimeout(resolve, options.chunkDelayMs ?? 40)); guard(); await write('extra', data.slice(offset, offset + 20), false);
      }
    }
    async function subscribe(channel, mode) { await lab.action('subscribe', { handle: guard()[channel].handle, mode }); guard(); }
    function stop() {
      for (const item of [...waiters]) item.reject(new Error('Dexcom session cancelled.'));
      target = null; failed = ''; queue.length = 0;
      if (priming) { const resolve = priming; priming = null; resolve(); }
      lab.setFastCapture?.(false);
    }
    return { begin, guard, wait, collect, write, sendExtra, subscribe, state: () => state, clear(channel) { for (let i = queue.length - 1; i >= 0; i--) if (!channel || queue[i].channel === channel) queue.splice(i, 1); }, stop, destroy() { stop(); offEvents?.(); offState?.(); } };
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcomTransport;
