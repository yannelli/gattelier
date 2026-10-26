'use strict';

const NanoSleepMcr = (() => {
  const protocol = () => typeof NanoSleepMcrProtocol !== 'undefined' ? NanoSleepMcrProtocol : require('./sleep-mcr-protocol.js');
  function createClient(lab, options = {}) {
    const p = protocol(), connection = options.connection || NanoConnection, timeout = options.timeoutMs ?? 10000;
    let current = lab.getState(), online = false, target = '', boot = '', cursor = 0, gaps, pending = null, priming = null;
    let session = null, running = false, failure = '', poisoned = false, lastAddress = '';
    function fail(message) {
      if (!running) return;
      failure = message; poisoned = Boolean(target); session = null;
      pending?.reject(new Error(message)); priming?.reject(new Error(message));
    }
    function guard() {
      if (failure) throw new Error(failure);
      if (!online || !current.ble?.connected || current.ble.address?.toLowerCase() !== target) throw new Error('Sleep Number connection changed. Reconnect the selected bed.');
      const handles = p.handles(current);
      if (!handles) throw new Error('The connected device does not expose the documented Sleep Number MCR transport.');
      if (!handles.write.properties?.some(property => ['write', 'write-no-response'].includes(property)) || !handles.notify.properties?.includes('notify')) throw new Error('MCR requires a writable command characteristic and a notification characteristic.');
      return handles;
    }
    function wait(holder, label) {
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
      const item = { promise, after: cursor, timer: setTimeout(() => fail(`${label} timed out. Reconnect before retrying.`), timeout) };
      const finish = (fn, value) => { clearTimeout(item.timer); if (holder === 'pending') pending = null; else priming = null; fn(value); };
      item.resolve = value => finish(resolve, value); item.reject = error => finish(reject, error); return item;
    }
    async function query(kind, identifier) {
      const handles = guard(), frame = p.request(kind, session || {}, identifier), item = wait('pending', `MCR ${kind} response`);
      item.kind = kind; item.assembler = new p.Assembler(); pending = item;
      try {
        const size = Math.min(244, Math.max(1, (current.ble.mtu || 23) - 3)), response = handles.write.properties.includes('write');
        for (let offset = 0; offset < frame.length; offset += size) { guard(); await lab.action('write', { handle: handles.write.handle, hex: p.hex(frame.slice(offset, offset + size)), response }); }
        guard(); return await item.promise;
      } catch (error) { fail(error.message); item.reject(error); throw error; }
    }
    const offEvents = lab.onEvents((events, meta = {}) => {
      const changedBoot = boot && meta.bootId && boot !== meta.bootId;
      if (changedBoot) { session = null; poisoned = false; if (target) fail('The board restarted during the MCR transfer.'); }
      if (meta.bootId) boot = meta.bootId;
      if (running && !priming && (meta.dropped || gaps !== undefined && Number(meta.gaps) > gaps)) fail('MCR packet capture has a gap. Reconnect before retrying.');
      gaps = Number(meta.gaps) || 0;
      for (const event of events) {
        cursor = Math.max(cursor, event.seq || 0);
        if (!pending || event.seq <= pending.after || event.address?.toLowerCase() !== target) continue;
        if (event.kind === 'disconnect') { fail('The bed disconnected during the MCR transfer.'); continue; }
        const handles = p.handles(current);
        if (!handles || event.handle !== handles.notify.handle || !['notification', 'indication'].includes(event.kind)) continue;
        if (event.truncated || event.redacted || event.success === false) { fail('MCR notification is incomplete or unavailable.'); continue; }
        try {
          const item = pending;
          for (const frame of item.assembler.append(event.hex)) { if (pending !== item) break; if (p.matches(frame, item.kind, session || {})) item.resolve(frame); }
        } catch (error) { fail(error.message); }
      }
      cursor = meta.reboot ? meta.cursor || meta.nextSeq || 0 : Math.max(cursor, meta.cursor || meta.nextSeq || 0);
      priming?.resolve();
    });
    const offState = lab.onState((state, available = true) => {
      const address = state.ble?.connected ? state.ble.address?.toLowerCase() || '' : '';
      if (address !== lastAddress) { session = null; poisoned = false; lastAddress = address; }
      current = state; online = available;
      if (running && target && (!online || address !== target)) fail('Sleep Number connection changed during the transfer.');
    });
    async function read(kind, device) {
      if (kind !== 'firmness') throw new Error('This MCR reader supports firmness and pump status.');
      if (running || lab.isActing()) throw new Error('Wait for the current Bluetooth operation to finish.');
      if (!device?.address) throw new Error('Select an MCR bed first.');
      running = true; failure = ''; target = '';
      try {
        current = await connection.ensure(device); target = device.address.toLowerCase(); guard();
        if (poisoned) throw new Error('Reconnect the bed after the interrupted transfer before reading again.');
        const identifier = p.identity(options.storage || globalThis.localStorage, target, options.crypto || globalThis.crypto);
        priming = wait('priming', 'Live packet capture'); const prime = priming.promise; lab.setFastCapture(true); await prime; guard();
        if (!session) { const handles = guard(); await lab.action('subscribe', { handle: handles.notify.handle, mode: 'notify' }); guard(); session = p.bind(await query('bind', identifier)); }
        const result = p.firmness(await query('firmness'));
        return { kind, ...result, fields: [{ label: 'Left firmness value', value: result.left }, { label: 'Right firmness value', value: result.right }, { label: 'Pump', value: result.adjusting ? 'Adjusting' : 'Idle' }, { label: 'Chamber status', value: result.dualChamber ? 'Dual' : 'Single' }] };
      } catch (error) { if (pending || priming) fail(error.message); throw error; }
      finally { pending?.reject(new Error('MCR read ended.')); priming?.reject(new Error('MCR read ended.')); running = false; target = ''; lab.setFastCapture(false); }
    }
    return { read, stop: () => fail('MCR read stopped. Reconnect before retrying.'), busy: () => running, destroy() { fail('MCR reader closed.'); offEvents?.(); offState?.(); } };
  }
  function mount(container, lab, options = {}) {
    if (!container) return;
    const connection = options.connection || NanoConnection, getDevice = options.getDevice || (() => connection.snapshot().selected), client = createClient(lab, { ...options, connection });
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    const heading = el('div', 'panel-heading'), body = el('div', 'detail'), selected = el('p', 'hint'), status = el('p', 'hint', 'Read firmness and pump status from the selected MCR bed.'); status.setAttribute('role', 'status');
    const controls = el('div', 'inspector-shortcuts'), results = el('dl', 'metadata'); heading.append(el('h2', '', 'Sleep Number MCR'), el('span', 'badge', 'Read only'));
    let selectedAddress = String(getDevice()?.address || '').toLowerCase(), selectionVersion = 0;
    const readButton = el('button', 'button secondary', 'Read firmness'), stop = el('button', 'button quiet', 'Stop');
    for (const button of [readButton, stop]) button.type = 'button';
    function render() {
      const device = getDevice(), context = connection.snapshot(), address = String(device?.address || '').toLowerCase();
      if (address !== selectedAddress) { selectedAddress = address; selectionVersion++; if (client.busy()) client.stop(); results.replaceChildren(); status.textContent = 'Read firmness and pump status from the selected MCR bed.'; }
      selected.textContent = device ? `Selected: ${device.label || device.name || device.address}` : 'Select an MCR bed in Discover.';
      readButton.disabled = !device || client.busy() || !context.online || context.pending || context.state.ble?.busy; stop.hidden = !client.busy();
    }
    async function run() {
      render(); const version = selectionVersion;
      results.replaceChildren(); status.textContent = 'Reading the MCR bed…'; const operation = client.read('firmness', getDevice()); render();
      try { const result = await operation; if (version !== selectionVersion) return; for (const field of result.fields) { const row = el('div'); row.append(el('dt', '', field.label), el('dd', '', field.value)); results.append(row); } status.textContent = `Read completed at ${new Date().toLocaleTimeString()}.`; return result; }
      catch (error) { if (version === selectionVersion) status.textContent = error.message; }
      finally { render(); }
    }
    readButton.addEventListener('click', run); stop.addEventListener('click', () => client.stop());
    controls.append(readButton, stop);
    const source = el('a', 'vendor-note', 'Sleep Number MCR protocol source'); source.href = 'https://github.com/kristofferR/ha-adjustable-bed/blob/main/custom_components/adjustable_bed/beds/sleep_number_mcr.py'; source.target = '_blank'; source.rel = 'noopener noreferrer';
    const help = el('details'); help.append(el('summary', '', 'About this reader'), el('p', 'vendor-note', 'The browser saves a client identity for session binding. The reader sends binding and status queries. Security requirements are reported by the connected bed.'), source);
    body.append(selected, controls, status, results, help); container.replaceChildren(heading, body);
    const off = lab.onState(render); document.addEventListener('nanoscope:selection', render); document.addEventListener('nanoscope:busy', render); render();
    return { read: run, stop: client.stop, destroy() { client.destroy(); off?.(); document.removeEventListener('nanoscope:selection', render); document.removeEventListener('nanoscope:busy', render); } };
  }
  return { createClient, mount };
})();
if (typeof module !== 'undefined') module.exports = NanoSleepMcr;
