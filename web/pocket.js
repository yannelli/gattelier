'use strict';
const NanoPocket = (() => {
  function mount(container, lab) {
    if (!container) return;
    const p = PocketProtocol;
    let current = {}, online = false, target = '', authenticated = false, running = null, transferActive = false, waiter, transfer, recording, lastPacket = 0, bootId = '', credentialStamp = '';
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const title = el('div', 'panel-heading'); title.append(el('h2', '', 'Pocket recordings'));
    title.insertAdjacentHTML('beforeend', '<details class="help"><summary aria-label="About Pocket"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Authenticate with the recorder’s 16-character session key, then browse recordings by date and save them as MP3.</p><p>Load the key directly or extract it from an iPhone PacketLogger capture. Keys are saved in this browser for this Pocket address and left out of traffic exports. Backups and capture steps are in Settings › Credentials.</p></div></details>');
    const body = el('div', 'pocket-body');
    const status = el('p', 'hint');
    const auth = el('div', 'pocket-controls');
    const key = el('input'); key.type = 'password'; key.maxLength = 16; key.autocomplete = 'off'; key.placeholder = '16-character session key'; key.setAttribute('aria-label', 'Pocket session key');
    const keyFile = el('input'); keyFile.type = 'file'; keyFile.accept = '.txt,.pklg'; keyFile.setAttribute('aria-label', 'Load Pocket key or PacketLogger capture');
    const unlock = el('button', 'button primary', 'Authenticate');
    const keyInputs = el('div', 'pocket-controls'); keyInputs.append(key, keyFile);
    const credentialTools = el('details', 'credential-controls'); credentialTools.append(el('summary', '', 'Manage Pocket key'), keyInputs);
    const jsonLabel = el('label', 'button secondary credentials-import', 'Import credentials JSON'), jsonFile = el('input');
    jsonFile.type = 'file'; jsonFile.accept = '.json,application/json'; jsonFile.setAttribute('aria-label', 'Import Pocket credentials JSON backup'); jsonLabel.append(jsonFile);
    auth.append(unlock, jsonLabel, credentialTools);
    jsonFile.addEventListener('change', async () => {
      const file = jsonFile.files[0]; if (!file || running) return;
      try {
        const result = await NanoCredentials.importFile(file); loadSaved(true);
        status.textContent = result.error || `Imported ${result.imported} credential record${result.imported === 1 ? '' : 's'}.`;
      } catch (error) { status.textContent = error.message; }
      finally { jsonFile.value = ''; sync(); }
    });
    const toolbar = el('div', 'pocket-controls');
    const directories = el('button', 'button secondary', 'List recording dates');
    const info = el('button', 'button secondary', 'Read device info');
    const dates = el('select'); dates.setAttribute('aria-label', 'Recording date');
    const datePlaceholder = el('option', '', 'No dates loaded'); datePlaceholder.value = ''; dates.append(datePlaceholder);
    const list = el('button', 'button secondary', 'List recordings');
    toolbar.append(directories, dates, list, info);
    const files = el('div', 'pocket-files');
    const progress = el('p', 'pocket-progress'); progress.setAttribute('role', 'status');
    const save = el('button', 'button primary', 'Save MP3'); save.hidden = true;
    const credentialSettings = el('button', 'button quiet', 'Credential settings'); credentialSettings.type = 'button';
    credentialSettings.addEventListener('click', () => { NanoSettings.open('credentials'); });
    credentialTools.append(credentialSettings);
    body.append(status, auth, toolbar, files, progress, save); container.replaceChildren(title, body);

    function selection() {
      const device = NanoConnection.snapshot().selected;
      return NanoRecorders.identify(device)?.product === 'Pocket Recorder' ? device : null;
    }
    const deviceKey = device => device?.address ? `${device.address.toLowerCase()}/${device.addressType}` : '';
    const connectionKey = state => state.ble?.connected ? `${deviceKey(state.ble)}/${state.ble.connectionAttempt}` : '';
    let selectedTarget = deviceKey(selection());
    function reset(message = '', keepOperation = false) {
      authenticated = false; rejectWait(message || 'The Pocket session changed.');
      if (running || transferActive) lab.setFastCapture(false);
      if (!keepOperation) running = null;
      transferActive = false;
      if (!transfer?.complete) { transfer = null; recording = null; progress.textContent = ''; save.hidden = true; }
      files.replaceChildren(); dates.replaceChildren(datePlaceholder); dates.value = ''; datePlaceholder.textContent = 'No dates loaded';
      key.value = ''; credentialStamp = ''; loadSaved(); status.textContent = keepOperation ? 'Working…' : message;
    }
    function observeSelection() {
      const next = deviceKey(selection());
      if (next !== selectedTarget) { selectedTarget = next; reset(); }
    }
    function active(operation) {
      const valid = running === operation && online && deviceKey(selection()) === operation.device && (!operation.connection || connectionKey(current) === operation.connection);
      if (!valid && running === operation) { reset(); sync(); }
      return valid;
    }
    function loadSaved(force = false) {
      if (running) return;
      const device = selection(), saved = device ? NanoCredentials.getPocket(device.address) : null;
      const stamp = `${device?.address || ''}/${saved || ''}`;
      if (!force && stamp === credentialStamp) return;
      credentialStamp = stamp; key.value = saved || ''; credentialTools.open = !saved;
      if (!device) status.textContent = '';
      else if (!authenticated) status.textContent = saved ? `Saved key ready for ${device.label || device.name || device.address}.` : 'Load the session key or an iPhone PacketLogger capture for this Pocket.';
    }
    function sync() {
      observeSelection();
      const device = selection(), connected = Boolean(device && current.ble?.connected && deviceKey(current.ble) === deviceKey(device));
      const ready = online && connected && p.handles(current).command;
      const disabled = !ready || running || current.ble?.busy;
      const secret = key.value.trim() || (device && NanoCredentials.getPocket(device.address));
      unlock.textContent = connected ? authenticated ? 'Authenticated' : 'Authenticate' : current.ble?.connected ? 'Switch and authenticate' : 'Connect and authenticate';
      unlock.disabled = !online || !device || !/^[A-Za-z0-9]{16}$/.test(secret || '') || running || current.ble?.busy || authenticated && connected;
      key.disabled = running; keyFile.disabled = running; jsonFile.disabled = running;
      for (const button of [directories, info, list]) button.disabled = disabled || !authenticated;
      dates.disabled = running || !authenticated;
      if (transfer) {
        progress.textContent = `${transfer.received.toLocaleString()} / ${transfer.expected === null ? '?' : transfer.expected.toLocaleString()} bytes${transfer.lost ? ` · ${transfer.lost} capture gaps` : ''}${transfer.error ? ` · ${transfer.error}` : ''}`;
        save.hidden = !transfer.complete;
      }
    }
    async function perform(operation, connectFirst = false) {
      if (running) return;
      const device = selection(), pending = { device: deviceKey(device), connection: deviceKey(current.ble) === deviceKey(device) ? connectionKey(current) : '' };
      running = pending; status.textContent = 'Working…'; sync();
      const check = () => { if (!active(pending)) throw new Error('The Pocket session changed. Reconnect and try again.'); };
      try {
        if (!device) throw new Error('Select a Pocket recorder first.');
        check();
        if (connectFirst) {
          const state = await NanoConnection.ensure(device); check();
          if (pending.connection && connectionKey(state) !== pending.connection) { reset(); sync(); return; }
          current = state; target = connectionKey(state);
        }
        if (!current.ble?.connected || deviceKey(current.ble) !== pending.device) throw new Error('Connect the selected Pocket recorder before continuing.');
        pending.connection = connectionKey(current); check();
        await operation(check);
      } catch (error) { if (active(pending)) status.textContent = error.message; }
      finally { if (running === pending) { running = null; transferActive = false; lab.setFastCapture(false); sync(); } }
    }
    function rejectWait(message, pending = waiter) { if (pending && waiter === pending) { clearTimeout(pending.timer); waiter = null; pending.reject(new Error(message)); } }
    function command(text, done, check, timeout = 15000) {
      check();
      if (waiter) return Promise.reject(new Error('A Pocket command is already waiting for a reply.'));
      const h = p.handles(current);
      const hex = p.encode(text);
      const reply = new Promise((resolve, reject) => {
        waiter = { armed: false, hex, auth: text.startsWith('APP&SK&'), messages: [], done, resolve, reject,
          timer: setTimeout(() => rejectWait('Pocket did not return a complete reply before the timeout.', pending), timeout) };
      });
      const pending = waiter;
      const write = lab.action('write', { handle: h.command, hex, response: true }).catch(error => { rejectWait(error.message, pending); throw error; });
      return Promise.all([reply, write]).then(([messages]) => messages);
    }
    lab.onEvents((events, meta) => {
      if (bootId && bootId !== meta.bootId) reset('The board restarted. Reconnect and authenticate again.');
      bootId = meta.bootId;
      if (!running || !active(running) || !running.connection) return;
      if (meta.dropped && waiter?.armed) { rejectWait('Packet capture has a gap. Repeat the command.'); }
      if (meta.dropped && transferActive) transfer.lost += meta.dropped;
      const h = p.handles(current);
      for (const event of events) {
        if (event.address?.toLowerCase() !== current.ble.address.toLowerCase() || event.addressType !== undefined && event.addressType !== current.ble.addressType || event.connectionAttempt !== undefined && event.connectionAttempt !== current.ble.connectionAttempt) continue;
        if (event.kind === 'write' && event.handle === h.command && waiter && (event.hex === waiter.hex || (waiter.auth && event.message.includes('redacted')))) waiter.armed = true;
        if (event.kind !== 'notification' && event.kind !== 'indication') continue;
        if (transferActive && event.handle === h.audio) { transfer.append(event.hex, event.truncated); lastPacket = Date.now(); }
        if (event.handle !== h.response) continue;
        for (const message of p.messages(event.hex)) {
          if (message.startsWith('MCU&U&') && transferActive) {
            try { transfer.announce(message.slice(6)); lastPacket = Date.now(); } catch (error) { transfer.error = error.message; }
          }
          if (waiter?.armed) {
            waiter.messages.push(message);
            if (message === 'MCU&UNKNOWN' || message === 'MCU&U&WIFI') { rejectWait(`Pocket replied ${message}. The requested BLE command did not complete.`); }
            else if (message === 'MCU&SK&ERR') { authenticated = false; rejectWait('Pocket rejected the session key.'); }
            else if (waiter && waiter.done(message, waiter.messages)) {
              const result = waiter.messages; clearTimeout(waiter.timer); const resolve = waiter.resolve; waiter = null; resolve(result);
            }
          }
        }
      }
      sync();
    });
    lab.onState((state, isOnline = true) => {
      current = state; online = isOnline;
      observeSelection();
      const next = connectionKey(state);
      if (target && target !== next || !online) reset('Pocket disconnected. Reconnect to continue.', online && Boolean(running && !running.connection));
      target = next;
      if (running && !running.connection && next && deviceKey(state.ble) === running.device) running.connection = next;
      loadSaved(); sync();
    });
    globalThis.addEventListener?.('nanoscope:api-change', () => {
      reset(); current = {}; online = false; target = ''; bootId = ''; sync();
    });
    keyFile.addEventListener('change', async () => {
      const file = keyFile.files[0]; if (!file) return;
      try {
        if (file.name.toLowerCase().endsWith('.pklg')) {
          if (file.size > 32 * 1024 * 1024) throw new Error('Choose a capture smaller than 32 MB.');
          const result = NanoPKLG.parse(await file.arrayBuffer());
          if (result.pocketKeys.length !== 1) throw new Error(`${result.pocketKeys.length} unique Pocket keys found. Use a capture containing one authentication exchange.`);
          key.value = result.pocketKeys[0]; result.pocketKeys.length = 0;
          status.textContent = 'Pocket key extracted locally.';
        } else {
          if (file.size > 128) throw new Error('Select a text key file or a PacketLogger capture.');
          key.value = (await file.text()).trim();
        }
        const device = selection();
        if (!device) throw new Error('Select your Pocket recorder before saving this key.');
        const result = NanoCredentials.savePocket(device.address, key.value.trim());
        status.textContent = result.error || 'Pocket key saved. Connect and authenticate to browse recordings.';
      } catch (error) { status.textContent = error.message; }
      finally { keyFile.value = ''; sync(); }
    });
    document.addEventListener('nanoscope:credentials-changed', () => { loadSaved(); sync(); });
    document.addEventListener('nanoscope:selection', () => { loadSaved(); sync(); });
    key.addEventListener('input', sync);
    unlock.addEventListener('click', () => {
      // Read before perform(): switching devices disconnects the old one, and that clears the key field.
      const typed = key.value.trim();
      perform(async check => {
        const device = selection(), secret = typed || NanoCredentials.getPocket(device.address);
        if (!/^[A-Za-z0-9]{16}$/.test(secret)) throw new Error('Enter the existing 16-character Pocket session key.');
        const h = p.handles(current);
        await lab.action('subscribe', { handle: h.response, mode: 'notify' });
        await command(`APP&SK&${secret}`, message => message === 'MCU&SK&OK', check); check();
        authenticated = true; const result = NanoCredentials.savePocket(device.address, secret); key.value = '';
        status.textContent = result.error || 'Authenticated. Key saved for reconnection.';
      }, true);
    });
    directories.addEventListener('click', () => perform(async check => {
      const replies = await command('APP&LIST_DIRS', message => /^MCU&DIRS_SUM&\d+$/.test(message), check); check();
      const found = replies.filter(message => message.startsWith('MCU&DIRS&')).map(message => message.slice(9));
      const count = Number(replies.find(message => message.startsWith('MCU&DIRS_SUM&')).slice(13));
      if (found.length !== count || found.some(date => !p.safeId(date))) throw new Error('The recording-date list is incomplete. Try again.');
      dates.replaceChildren(...found.sort().reverse().map(date => { const option = el('option', '', date); option.value = date; return option; }));
      if (!found.length) { datePlaceholder.textContent = 'No recording dates'; dates.append(datePlaceholder); }
      status.textContent = `${found.length} recording dates found.`;
    }));
    list.addEventListener('click', () => perform(async check => {
      if (!p.safeId(dates.value)) throw new Error('Choose a recording date.');
      const replies = await command(`APP&LIST&${dates.value}`, message => /^MCU&LIST&\d+$/.test(message), check); check();
      const result = p.listing(replies);
      if (!result.complete) throw new Error('The recording list is incomplete. Try again.');
      files.replaceChildren();
      for (const file of result.files) {
        const row = el('div', 'pocket-file');
        const label = el('div'); label.append(el('strong', '', file.name), el('small', '', `${file.date} · ${Math.floor(file.seconds / 60)}m ${file.seconds % 60}s`));
        const download = el('button', 'button secondary', 'Download');
        download.addEventListener('click', () => perform(check => downloadFile(file, check)));
        row.append(label, download); files.append(row);
      }
      status.textContent = `${result.files.length} recordings. Downloading keeps the original on Pocket.`;
    }));
    info.addEventListener('click', () => perform(async check => {
      const firmware = await command('APP&FW', message => message.startsWith('MCU&FW&'), check);
      const space = await command('APP&SPACE', message => message.startsWith('MCU&SPA&'), check); check();
      status.textContent = [...firmware, ...space].join(' · ');
    }));
    async function downloadFile(file, check) {
      recording = file; transfer = new p.Transfer(); save.hidden = true; transferActive = true;
      await lab.action('subscribe', { handle: p.handles(current).audio, mode: 'notify' });
      check();
      lab.setFastCapture(true); lastPacket = Date.now();
      await command(`APP&U&${file.date}&${file.name}`, message => /^MCU&U&\d+$/.test(message), check); check();
      while (!transfer.complete && !transfer.error && !transfer.lost) {
        if (Date.now() - lastPacket > 30000) { transfer.error = 'Transfer stalled before all bytes arrived.'; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
        check();
      }
      if (!transfer.complete) throw new Error('Recording incomplete. No complete MP3 was produced. Inspect the capture gaps and retry.');
      status.textContent = "Recording received. The byte count matches Pocket's announced size. Save the MP3 below.";
    }
    save.addEventListener('click', () => {
      if (!transfer?.complete) return;
      const url = URL.createObjectURL(new Blob(transfer.chunks, { type: 'audio/mpeg' }));
      const link = el('a'); link.href = url; link.download = `${recording.date}_${recording.name}.mp3`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    sync();
  }
  return { mount };
})();
