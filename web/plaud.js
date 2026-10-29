'use strict';

const NanoPlaud = (() => {
  function mount(container, lab) {
    if (!container) return;
    const p = NanoPlaudProtocol, maxBytes = 64 * 1024 * 1024;
    let current = {}, online = false, credentials = null, session = null, authenticated = false, running = null;
    let target = '', bootId = '', generation = 0, waiter = null, transfer = null, verified = null, records = [];
    let tx = Promise.resolve(), rx = Promise.resolve(), latestSeq = 0, credentialStamp = '';
    const get = id => container.querySelector(`#plaud-${id}`);
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    const u16 = (data, offset) => data[offset] | data[offset + 1] << 8;
    const u32 = (data, offset) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
    const key = device => device?.address ? `${device.address.toLowerCase()}/${device.addressType}` : '';
    const connectedKey = (state, available = true) => available && state.ble?.connected ? `${key(state.ble)}/${state.ble.connectionAttempt}` : '';
    let selectedKey = key(selection());
    container.innerHTML = '<div class="panel-heading"><div><h2>PLAUD recordings</h2></div><div class="heading-tools"><span class="badge">Note Pro</span><details class="help"><summary aria-label="About PLAUD"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Authenticate with the device credentials file, then list and download recordings as Ogg audio.</p><p>Downloads keep the original recording, up to 64 MiB. Saving requires the full byte count, a clean end marker and valid Ogg checksums.</p><p>Credentials must match the recorder’s serial. Back them up in Settings › Credentials.</p></div></details></div></div><div class="plaud-body"><p id="plaud-target" class="hint"></p><p id="plaud-credentials" class="plaud-credentials" role="status"></p><div id="plaud-credential-tools" class="credential-controls"><label class="button secondary credentials-import">Import credentials JSON<input id="plaud-credentials-file" type="file" accept=".json,application/json" aria-label="Import PLAUD credentials JSON or recorder backup"></label><button id="plaud-credential-settings" class="button quiet" type="button">Credential settings</button></div><div class="plaud-controls"><button id="plaud-authenticate" class="button primary">Authenticate</button><button id="plaud-list" class="button secondary">List recordings</button><button id="plaud-stop" class="button secondary" hidden>Stop download</button></div><p id="plaud-status" class="plaud-status" role="status"></p><div id="plaud-files" class="plaud-files"></div><progress id="plaud-meter" max="1" value="0" hidden aria-label="Recording download progress"></progress><p id="plaud-progress" class="plaud-progress" role="status"></p><button id="plaud-save" class="button primary" hidden>Save Ogg</button></div>';
    function selection() {
      const device = NanoConnection.snapshot().selected;
      return NanoRecorders.identify(device)?.product === 'PLAUD Note Pro' ? device : null;
    }
    function identity() {
      const selected = selection();
      const device = current.ble?.connected ? key(selected) === key(current.ble) ? selected : current.devices?.find(item => key(item) === key(current.ble)) : null;
      const info = device && NanoRecorders.identify(device);
      return info?.product === 'PLAUD Note Pro' ? info : null;
    }
    function matches() {
      const selected = selection(), info = identity();
      return Boolean(selected && current.ble?.connected && key(current.ble) === key(selected) && credentials && info?.serial.toLowerCase() === credentials.serial.toLowerCase());
    }
    function candidate() {
      const device = selection(), info = NanoRecorders.identify(device);
      return credentials && info?.serial.toLowerCase() === credentials.serial.toLowerCase() ? device : null;
    }
    function loadSaved(force = false) {
      if (running) return;
      const info = NanoRecorders.identify(selection()), saved = info ? NanoCredentials.getPlaud(info.serial) : null;
      const stamp = saved ? JSON.stringify(saved) : '';
      if (!force && stamp === credentialStamp) return;
      credentialStamp = stamp; credentials = saved ? p.credentials(saved) : null;
      reset(credentials || !selection() ? '' : 'Import this recorder’s credentials to continue.');
    }
    function guard(token = generation) {
      if (token !== generation) throw new Error('The PLAUD session changed. Authenticate again.');
      if (!online || !current.ble?.connected) throw new Error('Connect the PLAUD recorder before continuing.');
      if (connectedKey(current, online) !== target) throw new Error('The PLAUD connection changed. Authenticate again.');
      if (!matches()) throw new Error('Credentials must match the serial advertised by the connected PLAUD recorder.');
      const handles = p.handles(current);
      if (!Number.isInteger(handles.command) || !Number.isInteger(handles.response)) throw new Error('PLAUD command and response characteristics are unavailable.');
      return handles;
    }
    function sync() {
      const device = selection(), info = NanoRecorders.identify(device), ready = online && matches() && Number.isInteger(p.handles(current).command);
      const connected = Boolean(device && current.ble?.connected && key(current.ble) === key(device));
      get('target').textContent = info ? `${info.product} · ${info.serial} · ${!online ? 'board offline' : connected ? 'connected' : 'disconnected'}` : '';
      const canAuthenticate = online && Boolean(candidate());
      get('credentials').textContent = credentials ? `Credentials for ${credentials.serial.toUpperCase()} · ${NanoCredentials.status().persistent ? 'saved in this browser' : 'memory only; export a backup in Settings'}` : selection() ? 'No saved credentials' : '';
      get('authenticate').textContent = connected ? authenticated ? 'Authenticated' : 'Authenticate' : current.ble?.connected ? 'Switch and authenticate' : 'Connect and authenticate';
      get('authenticate').disabled = !canAuthenticate || running || current.ble?.busy || authenticated && connected;
      get('list').disabled = !ready || !authenticated || running || current.ble?.busy;
      get('credentials-file').disabled = running;
      for (const button of get('files').querySelectorAll('button')) button.disabled = !ready || !authenticated || running || current.ble?.busy || Number(button.dataset.size) > maxBytes;
      get('stop').hidden = !transfer?.active; get('save').hidden = !verified;
      if (transfer) {
        get('meter').hidden = false; get('meter').max = transfer.size || 1; get('meter').value = transfer.received;
        get('progress').textContent = `${transfer.received.toLocaleString()} / ${transfer.size.toLocaleString()} bytes${transfer.error ? ` · ${transfer.error}` : verified ? ' · Ogg verified' : ''}`;
      } else {
        get('meter').hidden = true; get('meter').max = 1; get('meter').value = 0;
        get('progress').textContent = '';
      }
    }
    function fail(message) {
      if (transfer?.active) transfer.error = message;
      if (waiter) { const pending = waiter; waiter = null; clearTimeout(pending.timer); pending.reject(new Error(message)); }
    }
    function reset(message) {
      if (running || transfer?.active) lab.setFastCapture(false);
      generation++; running = null; authenticated = false; session = null; fail(message);
      if (transfer?.active) { transfer.active = false; transfer.buffer = null; }
      if (!verified) transfer = null;
      tx = Promise.resolve(); rx = Promise.resolve();
      records = []; renderFiles(); get('status').textContent = message; sync();
    }
    function touch() { if (waiter) { clearTimeout(waiter.timer); waiter.timer = setTimeout(() => fail('PLAUD did not return a complete reply before the timeout.'), waiter.timeout); } }
    function write(bytes, token = generation) {
      const pending = tx.catch(() => {}).then(async () => {
        const handles = guard(token);
        await lab.action('write', { handle: handles.command, hex: NanoPackets.hex(bytes), response: true });
      });
      tx = pending; return pending;
    }
    async function sendChunks(opcode, bytes, token) { for (const chunk of p.chunks(opcode, bytes)) await write(chunk, token); }
    function exchange(send, accept, raw = false, timeout = 20000) {
      if (waiter) return Promise.reject(new Error('A PLAUD reply is already pending.'));
      const token = generation;
      const reply = new Promise((resolve, reject) => { waiter = { resolve, reject, accept, raw, token, after: latestSeq, timeout }; touch(); });
      const pending = waiter;
      const sending = Promise.resolve().then(() => send(token)).catch(error => { if (waiter === pending) fail(error.message); throw error; });
      return Promise.all([reply, sending]).then(([result]) => result).finally(() => {
        clearTimeout(pending.timer); if (waiter === pending) waiter = null;
      });
    }
    async function receive(event, token) {
      if (token !== generation) return;
      guard(token);
      const bytes = NanoPackets.bytes(event.hex || ''), pending = waiter;
      if (event.truncated) { fail('PLAUD packet was truncated. Repeat the operation.'); return; }
      const packet = pending?.raw ? bytes : session ? session.open(bytes) : null;
      if (!packet || !pending || pending !== waiter || pending.token !== generation || event.seq <= pending.after) return;
      const result = await pending.accept(packet, pending.token);
      if (result !== undefined && pending === waiter) { waiter = null; clearTimeout(pending.timer); pending.resolve(result); }
    }
    lab.onEvents((events, meta) => {
      if (bootId && bootId !== meta.bootId) reset('The board restarted. Reconnect and authenticate again.');
      bootId = meta.bootId;
      latestSeq = Math.max(latestSeq, meta.cursor || meta.nextSeq || 0);
      if (meta.reboot) latestSeq = meta.cursor || meta.nextSeq || 0;
      if (meta.dropped && waiter) fail('Packet capture has a gap. The operation is incomplete.');
      const handle = p.handles(current).response, token = generation;
      for (const event of events) {
        if (event.address?.toLowerCase() !== current.ble?.address?.toLowerCase() || event.handle !== handle || !['notification', 'indication'].includes(event.kind)) continue;
        if (event.addressType !== undefined && event.addressType !== current.ble.addressType || event.connectionAttempt !== undefined && event.connectionAttempt !== current.ble.connectionAttempt) continue;
        rx = rx.then(() => receive(event, token)).catch(error => {
          if (token !== generation) return;
          fail(error.message); if (!running) { authenticated = false; session = null; get('status').textContent = 'PLAUD session validation failed. Authenticate again.'; }
        });
      }
      sync();
    });
    lab.onState((state, available = true) => {
      const next = connectedKey(state, available), previous = target;
      current = state; online = available;
      target = next;
      const connecting = running?.connecting && online && running.key === key(selection());
      if (previous && previous !== next && !connecting) reset('PLAUD connection changed. Saved credentials are ready for reconnection.');
      if (connecting && state.ble?.connected && key(state.ble) === running.key) running.connecting = false;
      loadSaved();
      if (!online && waiter) fail('The board is unavailable. The operation is incomplete.');
      sync();
    });
    async function perform(operation, connectFirst = false) {
      if (running) return;
      const operationState = running = { token: generation, key: key(selection()), connecting: connectFirst && (!current.ble?.connected || key(current.ble) !== key(selection())) };
      const active = () => running === operationState && operationState.token === generation && operationState.key === key(selection());
      get('status').classList.remove('error'); lab.setFastCapture(true); sync();
      try {
        if (connectFirst) {
          const device = candidate();
          if (!online || !device) throw new Error('Select the PLAUD recorder matching the saved credentials.');
          get('status').textContent = 'Connecting to the matching PLAUD recorder…';
          const state = await NanoConnection.ensure(device);
          if (!active()) return;
          current = state; target = connectedKey(current, online); operationState.connecting = false;
        }
        guard(operationState.token); await operation(operationState.token);
      }
      catch (error) {
        if (!active()) return;
        fail(error.message); get('status').textContent = error.message; get('status').classList.add('error');
        const stopping = transfer?.active; operationState.token = ++generation;
        if (stopping && session && matches() && online && current.ble?.connected) {
          try { await write(session.seal(p.command(29))); } catch { if (active()) get('status').textContent += ' Stop could not be confirmed.'; }
        }
      } finally {
        if (running === operationState) {
          if (transfer) { transfer.active = false; transfer.buffer = null; }
          running = null; lab.setFastCapture(false); sync();
        }
      }
    }
    get('credentials-file').addEventListener('change', async () => {
      const file = get('credentials-file').files[0]; if (!file) return;
      try {
        const result = await NanoCredentials.importFile(file);
        loadSaved(true); get('status').textContent = result.error || `Imported ${result.imported} credential record${result.imported === 1 ? '' : 's'}.`;
      } catch (error) { get('status').textContent = error.message; }
      finally { get('credentials-file').value = ''; sync(); }
    });
    document.addEventListener('nanoscope:credentials-changed', () => { loadSaved(); sync(); });
    document.addEventListener('nanoscope:selection', () => {
      const next = key(selection());
      if (next !== selectedKey) { selectedKey = next; reset(''); }
      loadSaved(); sync();
    });
    globalThis.addEventListener?.('nanoscope:api-change', () => { current = {}; online = false; target = ''; bootId = ''; latestSeq = 0; reset(''); });
    get('credential-settings').addEventListener('click', () => { NanoSettings.open('credentials'); });
    get('authenticate').addEventListener('click', () => perform(async token => {
      authenticated = false; session = null; records = []; renderFiles();
      get('status').textContent = 'Subscribing and authenticating the device signature…';
      await lab.action('subscribe', { handle: guard(token).response, mode: 'notify' });
      guard(token);
      const assembler = new p.Assembler(); let publicKeySent = false;
      const wrapped = await exchange(token => sendChunks(0xfe10, credentials.signature, token), async (packet, token) => {
        if (packet.length < 2) throw new Error('Truncated PLAUD authentication reply.');
        const opcode = u16(packet, 0);
        if (opcode === 0xfe11 && !publicKeySent) {
          publicKeySent = true; get('status').textContent = 'Exchanging the public key…';
          await sendChunks(0xfe12, new TextEncoder().encode(credentials.publicKeyPem), token);
        } else if (opcode === 0xfe12) { const result = assembler.add(packet); if (result) return result; }
      }, true);
      guard(token);
      session = new p.Session(credentials.privateKeyPem, wrapped);
      get('status').textContent = 'Confirming the encrypted session…'; let second = false;
      await exchange(token => write(session.seal(p.handshake(credentials.userId)), token), async (packet, token) => {
        if (packet.length < 3 || packet[0] !== 1) return;
        const code = u16(packet, 1);
        if (code === 2 && !second) { second = true; await write(session.seal(p.handshake(credentials.userId, true)), token); }
        else if (code === 1) {
          if (packet.length < 4 || packet[3] !== 0) throw new Error('PLAUD rejected the encrypted handshake.');
          return true;
        }
      });
      guard(token);
      authenticated = true; get('status').textContent = 'Authenticated. Ready to list recordings.';
    }, true));
    function renderFiles() {
      get('files').replaceChildren();
      if (!records.length) { if (authenticated) get('files').append(el('p', 'vendor-note', 'No recordings')); return; }
      for (const recording of records) {
        const row = el('div', 'plaud-recording'), label = el('div');
        label.append(el('strong', '', `Recording ${recording.id}`), el('small', '', `${recording.size.toLocaleString()} bytes${recording.size > maxBytes ? ' · exceeds 64 MiB download limit' : ''}`));
        const button = el('button', 'button secondary', 'Download'); button.dataset.size = recording.size;
        button.addEventListener('click', () => perform(token => download(recording, token))); row.append(label, button); get('files').append(row);
      }
      sync();
    }
    get('list').addEventListener('click', () => perform(async token => {
      get('status').textContent = 'Reading the recording list…';
      const request = p.listRequest(0), requestId = u32(request, 3), entries = new Map(); let total = null;
      const found = await exchange(token => write(session.seal(request), token), packet => {
        if (packet.length < 3 || packet[0] !== 1 || u16(packet, 1) !== 26) return;
        const page = p.parseList(packet); if (page.requestId !== requestId) return;
        if (total !== null && total !== page.total) throw new Error('The recording list changed while being read. Retry the list.');
        total = page.total;
        page.entries.forEach((entry, index) => {
          const position = page.index + index, previous = entries.get(position);
          if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error('Conflicting recording-list entries. Retry the list.');
          entries.set(position, entry);
        });
        if (entries.size === total) return Array.from({ length: total }, (_, index) => {
          if (!entries.has(index)) throw new Error('The recording list is incomplete.'); return entries.get(index);
        });
      }, false, 30000);
      guard(token); records = found;
      renderFiles(); get('status').textContent = `${records.length} recordings found.`;
    }));
    async function download(recording, token) {
      if (!authenticated || !session) throw new Error('Authenticate before downloading.');
      if (!Number.isSafeInteger(recording.size) || recording.size < 1 || recording.size > maxBytes) throw new Error('This recorder supports downloads from 1 byte through 64 MiB in this browser.');
      verified = null; transfer = { active: true, size: recording.size, id: recording.id, received: 0, buffer: new Uint8Array(recording.size), header: false, ended: false, error: '' };
      const item = transfer; get('status').textContent = `Downloading recording ${recording.id}…`; sync();
      await exchange(token => write(session.seal(p.downloadRequest(recording.id, 0, recording.size)), token), packet => {
        if (packet[0] === 1 && packet.length >= 3 && u16(packet, 1) === 28) {
          if (packet.length < 8 || u32(packet, 3) !== item.id || packet[7] !== 0) throw new Error('PLAUD rejected the recording download header.');
          item.header = true; touch();
        } else if (packet[0] === 2) {
          const part = p.parseData(packet);
          if (part.id !== item.id) throw new Error('A packet belongs to a different recording.');
          if (part.end) {
            if (part.code !== 1) throw new Error('PLAUD did not return a successful recording end marker.');
            if (item.received !== item.size) throw new Error('The recorder ended the transfer before the listed byte count was received.');
            item.ended = true;
          } else {
            if (part.offset !== item.received || item.received + part.data.length > item.size) throw new Error('Recording bytes are missing, duplicated, or outside the requested range.');
            item.buffer.set(part.data, item.received); item.received += part.data.length;
          }
          touch(); sync();
        }
        if (item.header && item.ended && item.received === item.size) return true;
      }, false, 30000);
      guard(token);
      get('status').textContent = 'All recording bytes received. Decrypting and verifying Ogg pages…';
      await new Promise(resolve => setTimeout(resolve, 0));
      guard(token); if (item.error) throw new Error(item.error);
      const ogg = p.decryptRecording(item.buffer, credentials.privateKeyPem);
      verified = { bytes: ogg, name: `${credentials.serial.toUpperCase()}_${recording.id}.ogg` };
      item.active = false; get('status').textContent = 'Recording verified. Save the Ogg audio below.';
    }
    get('stop').addEventListener('click', () => fail('Download stopped. No incomplete recording was saved.'));
    get('save').addEventListener('click', () => {
      if (!verified) return;
      const url = URL.createObjectURL(new Blob([verified.bytes], { type: 'audio/ogg' }));
      const link = el('a'); link.href = url; link.download = verified.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    sync();
  }
  return { mount };
})();
