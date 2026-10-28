'use strict';

// Request/notify transfers over one write and one notify characteristic. Any gap, reboot, disconnect or timeout
// poisons the link until the device reconnects, because a stale response could otherwise answer a later request.
const NanoNotifyClient = (() => {
  function create(lab, p, { name, text, connection, timeout, chunk, check, writeResponse, reset, onFrame }) {
    let current = lab.getState(), online = false, target = '', boot = '', cursor = 0, gaps, pending = null, priming = null;
    let running = false, failure = '', poisoned = false, lastConnection = '', targetConnection = '';
    const connectionKey = state => state.ble?.connected ? `${state.ble.address?.toLowerCase()}/${state.ble.addressType}/${state.ble.connectionAttempt}` : '';
    function fail(message) {
      if (!running || failure) return;
      failure = message; poisoned = Boolean(target && connectionKey(current) === targetConnection); reset('fail');
      pending?.reject(new Error(message)); priming?.reject(new Error(message));
    }
    function guard() {
      if (failure) throw new Error(failure);
      if (!online || !targetConnection || connectionKey(current) !== targetConnection) throw new Error(text.changed);
      const handles = p.handles(current); check(handles); return handles;
    }
    function wait(holder, label) {
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
      const item = { promise, after: cursor, timer: setTimeout(() => fail(`${label} timed out. Reconnect before retrying.`), timeout) };
      const finish = (fn, value) => { clearTimeout(item.timer); if (holder === 'pending') pending = null; else priming = null; fn(value); };
      item.resolve = value => finish(resolve, value); item.reject = error => finish(reject, error); return item;
    }
    async function request(kind, label, build) {
      const handles = guard(), frame = build(), item = wait('pending', label);
      item.kind = kind; item.frame = frame; item.assembler = new p.Assembler(); pending = item;
      try {
        const size = Math.min(chunk, Math.max(1, (current.ble.mtu || 23) - 3)), response = writeResponse(handles);
        for (let offset = 0; offset < frame.length; offset += size) { guard(); await lab.action('write', { handle: handles.write.handle, hex: p.hex(frame.slice(offset, offset + size)), response }); }
        guard(); return await item.promise;
      } catch (error) { fail(error.message); item.reject(error); throw error; }
    }
    const offEvents = lab.onEvents((events, meta = {}) => {
      const changedBoot = boot && meta.bootId && boot !== meta.bootId;
      if (changedBoot) { reset('boot'); poisoned = false; if (target) fail(`The board restarted during the ${name} transfer.`); }
      if (meta.bootId) boot = meta.bootId;
      if (running && !priming && (meta.dropped || gaps !== undefined && Number(meta.gaps) > gaps)) fail(`${name} packet capture has a gap. Reconnect before retrying.`);
      gaps = Number(meta.gaps) || 0;
      for (const event of events) {
        cursor = Math.max(cursor, event.seq || 0);
        if (!pending || event.seq <= pending.after || event.address?.toLowerCase() !== target) continue;
        if (event.addressType !== undefined && event.addressType !== current.ble?.addressType || event.connectionAttempt !== undefined && event.connectionAttempt !== current.ble?.connectionAttempt) continue;
        if (event.kind === 'disconnect') { fail(text.disconnect); continue; }
        const handles = p.handles(current);
        if (!handles || event.handle !== handles.notify.handle || !['notification', 'indication'].includes(event.kind)) continue;
        if (event.truncated || event.redacted || event.success === false) { fail(`${name} notification is incomplete or unavailable.`); continue; }
        try {
          const item = pending;
          for (const frame of item.assembler.append(event.hex)) { if (pending !== item) break; onFrame(frame, item); }
        } catch (error) { fail(error.message); }
      }
      cursor = meta.reboot ? meta.cursor || meta.nextSeq || 0 : Math.max(cursor, meta.cursor || meta.nextSeq || 0);
      priming?.resolve();
    });
    const offState = lab.onState((state, available = true) => {
      const key = connectionKey(state);
      if (key !== lastConnection) { reset('address'); poisoned = false; lastConnection = key; }
      current = state; online = available;
      if (running && target && (!online || key !== targetConnection)) fail(text.moved);
    });
    function onApiChange() {
      fail(text.moved); reset('address'); poisoned = false; lastConnection = ''; online = false;
      boot = ''; cursor = 0; gaps = undefined;
    }
    globalThis.addEventListener?.('nanoscope:api-change', onApiChange);
    async function prime() { priming = wait('priming', 'Live packet capture'); const ready = priming.promise; lab.setFastCapture(true); await ready; guard(); }
    async function subscribe() { const handles = guard(); await lab.action('subscribe', { handle: handles.notify.handle, mode: 'notify' }); guard(); }
    async function run(device, body) {
      if (running || lab.isActing()) throw new Error('Wait for the current Bluetooth operation to finish.');
      if (!device?.address) throw new Error(text.select);
      running = true; failure = ''; target = ''; targetConnection = '';
      try {
        current = await connection.ensure(device); target = device.address.toLowerCase();
        targetConnection = `${target}/${device.addressType}/${current.ble?.connectionAttempt}`; guard();
        if (poisoned) throw new Error(text.poisoned);
        return await body(target);
      } catch (error) { if (pending || priming) fail(error.message); throw error; }
      finally { pending?.reject(new Error(`${name} read ended.`)); priming?.reject(new Error(`${name} read ended.`)); running = false; target = ''; targetConnection = ''; lab.setFastCapture(false); }
    }
    return { run, prime, subscribe, request, fail, busy: () => running, close(message) { fail(message); offEvents?.(); offState?.(); globalThis.removeEventListener?.('nanoscope:api-change', onApiChange); } };
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = NanoNotifyClient;
