'use strict';

const NanoSleepMcr = (() => {
  const protocol = () => typeof NanoSleepMcrProtocol !== 'undefined' ? NanoSleepMcrProtocol : require('./sleep-mcr-protocol.js');
  function createClient(lab, options = {}) {
    const p = protocol(), notify = typeof NanoNotifyClient !== 'undefined' ? NanoNotifyClient : require('./notify-client.js');
    let session = null;
    const link = notify.create(lab, p, {
      name: 'MCR', connection: options.connection || NanoConnection, timeout: options.timeoutMs ?? 10000, chunk: 244,
      text: { changed: 'Sleep Number connection changed. Reconnect the selected bed.', moved: 'Sleep Number connection changed during the transfer.', disconnect: 'The bed disconnected during the MCR transfer.', select: 'Select an MCR bed first.', poisoned: 'Reconnect the bed after the interrupted transfer before reading again.' },
      check(handles) {
        if (!handles) throw new Error('The connected device does not expose the documented Sleep Number MCR transport.');
        if (!handles.write.properties?.some(property => ['write', 'write-no-response'].includes(property)) || !handles.notify.properties?.includes('notify')) throw new Error('MCR requires a writable command characteristic and a notification characteristic.');
      },
      writeResponse: handles => handles.write.properties.includes('write'),
      reset() { session = null; },
      onFrame(frame, item) { if (p.matches(frame, item.kind, session || {})) item.resolve(frame); }
    });
    const query = (kind, identifier) => link.request(kind, `MCR ${kind} response`, () => p.request(kind, session || {}, identifier));
    async function read(kind, device) {
      if (kind !== 'firmness') throw new Error('This MCR reader supports firmness and pump status.');
      return link.run(device, async target => {
        const identifier = p.identity(options.storage || globalThis.localStorage, target, options.crypto || globalThis.crypto);
        await link.prime();
        if (!session) { await link.subscribe(); session = p.bind(await query('bind', identifier)); }
        const result = p.firmness(await query('firmness'));
        return { kind, ...result, fields: [{ label: 'Left firmness value', value: result.left }, { label: 'Right firmness value', value: result.right }, { label: 'Pump', value: result.adjusting ? 'Adjusting' : 'Idle' }, { label: 'Chamber status', value: result.dualChamber ? 'Dual' : 'Single' }] };
      });
    }
    return { read, stop: () => link.fail('MCR read stopped. Reconnect before retrying.'), busy: link.busy, destroy: () => link.close('MCR reader closed.') };
  }
  function mount(container, lab, options = {}) {
    if (!container) return;
    const connection = options.connection || NanoConnection, getDevice = options.getDevice || (() => connection.snapshot().selected), client = createClient(lab, { ...options, connection });
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    const heading = el('div', 'panel-heading'), body = el('div', 'detail'), status = el('p', 'hint'); status.setAttribute('role', 'status');
    const controls = el('div', 'inspector-shortcuts'), results = el('dl', 'metadata'); heading.append(el('h2', '', 'Sleep Number MCR'));
    heading.insertAdjacentHTML('beforeend', '<details class="help"><summary aria-label="About the MCR reader"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Reads firmness and pump status. The browser saves a client identity to bind the session, then sends binding and status queries. The bed reports its own security requirements.</p><a href="https://github.com/kristofferR/ha-adjustable-bed/blob/main/custom_components/adjustable_bed/beds/sleep_number_mcr.py" target="_blank" rel="noopener noreferrer">Protocol source</a></div></details>');
    const key = device => JSON.stringify([String(device?.address || '').toLowerCase(), device?.addressType ?? null]);
    const connected = (device, context) => context.online && context.state.ble?.connected && key(device) === key(context.state.ble);
    let selectedKey = key(getDevice()), connectionScope = '', selectionVersion = 0, destroyed = false, reading = null;
    const readButton = el('button', 'button secondary', 'Read firmness'), stop = el('button', 'button quiet', 'Stop');
    for (const button of [readButton, stop]) button.type = 'button';
    function invalidate() {
      selectionVersion++; reading = null;
      if (client.busy()) client.stop();
      results.replaceChildren(); status.textContent = '';
    }
    function render() {
      if (destroyed) return;
      const device = getDevice(), context = connection.snapshot(), nextKey = key(device);
      const scope = JSON.stringify([Boolean(context.online), Boolean(context.state.ble?.connected), key(context.state.ble), context.state.ble?.connectionAttempt ?? null]);
      const connecting = reading?.connecting && context.online && nextKey === selectedKey;
      if (nextKey !== selectedKey || connectionScope && scope !== connectionScope && !connecting) invalidate();
      selectedKey = nextKey; connectionScope = scope;
      if (reading?.connecting && connected(device, context)) reading.connecting = false;
      readButton.disabled = !device || client.busy() || !context.online || context.pending || context.state.ble?.busy; stop.hidden = !client.busy();
    }
    async function run() {
      if (destroyed) return;
      render(); const token = reading = { version: selectionVersion, connecting: !connected(getDevice(), connection.snapshot()) };
      results.replaceChildren(); status.textContent = 'Reading the MCR bed…'; const operation = client.read('firmness', getDevice()); render();
      try { const result = await operation; render(); if (destroyed || token.version !== selectionVersion) return; for (const field of result.fields) { const row = el('div'); row.append(el('dt', '', field.label), el('dd', '', field.value)); results.append(row); } status.textContent = `Read completed at ${new Date().toLocaleTimeString()}.`; return result; }
      catch (error) { render(); if (!destroyed && token.version === selectionVersion) status.textContent = error.message; }
      finally { if (reading === token) reading = null; render(); }
    }
    function onApiChange() { invalidate(); render(); }
    readButton.addEventListener('click', run); stop.addEventListener('click', () => client.stop());
    controls.append(readButton, stop);
    body.append(controls, status, results); container.replaceChildren(heading, body);
    const off = lab.onState(render); document.addEventListener('nanoscope:selection', render); document.addEventListener('nanoscope:busy', render); globalThis.addEventListener('nanoscope:api-change', onApiChange); render();
    return { read: run, stop: client.stop, destroy() { if (destroyed) return; destroyed = true; selectionVersion++; client.destroy(); off?.(); document.removeEventListener('nanoscope:selection', render); document.removeEventListener('nanoscope:busy', render); globalThis.removeEventListener('nanoscope:api-change', onApiChange); } };
  }
  return { createClient, mount };
})();
if (typeof module !== 'undefined') module.exports = NanoSleepMcr;
