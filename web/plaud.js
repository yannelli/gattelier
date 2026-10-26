'use strict';

const NanoPlaud = (() => {
  function mount(container, lab) {
    if (!container) return;
    const p = NanoPlaudProtocol, maxBytes = 64 * 1024 * 1024;
    let current = {}, online = false, credentials = null, session = null, authenticated = false, running = false;
    let target = '', bootId = '', generation = 0, waiter = null, transfer = null, verified = null, records = [];
    let tx = Promise.resolve(), rx = Promise.resolve(), latestSeq = 0, credentialStamp = '';
    const get = id => container.querySelector(`#plaud-${id}`);
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    const u16 = (data, offset) => data[offset] | data[offset + 1] << 8;
    const u32 = (data, offset) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
    container.innerHTML = '<div class="panel-heading"><div><h2>PLAUD recordings</h2><p>Authenticate, browse, and download verified Ogg audio</p></div><span class="badge">Note Pro</span></div><div class="plaud-body"><p id="plaud-target" class="hint">Connect your PLAUD Note Pro to continue.</p><p id="plaud-credentials" class="plaud-credentials" role="status">No credentials saved for the selected recorder.</p><details id="plaud-credential-tools" class="credential-controls"><summary>Manage credentials</summary><label class="plaud-file-label">Device credentials JSON<input id="plaud-credentials-file" type="file" accept=".json,application/json"></label><button id="plaud-credential-settings" class="button quiet" type="button">Credential backups &amp; capture help</button></details><div class="plaud-controls"><button id="plaud-authenticate" class="button primary">Authenticate</button><button id="plaud-list" class="button secondary">List recordings</button><button id="plaud-stop" class="button secondary" hidden>Stop download</button></div><p id="plaud-status" class="plaud-status" role="status">Load credentials for the connected recorder.</p><div id="plaud-files" class="plaud-files"><p class="vendor-note">Authenticate to list recordings.</p></div><progress id="plaud-meter" max="1" value="0" hidden aria-label="Recording download progress"></progress><p id="plaud-progress" class="plaud-progress" role="status"></p><button id="plaud-save" class="button primary" hidden>Save Ogg</button><p class="vendor-note">Downloads retain the original recording. Maximum download: 64 MiB. Saving requires the announced byte count, a successful end marker, and verified Ogg CRCs.</p></div>';
    function selection() {
      const device = NanoConnection.snapshot().selected;
      return NanoRecorders.identify(device)?.product === 'PLAUD Note Pro' ? device : null;
    }
    function identity() {
      const address = current.ble?.connected ? current.ble.address : '';
      const selected = selection();
      const device = selected?.address.toLowerCase() === address.toLowerCase() ? selected : current.devices?.find(item => item.address.toLowerCase() === address.toLowerCase());
      const info = device && NanoRecorders.identify(device);
      return info?.product === 'PLAUD Note Pro' ? info : null;
    }
    function matches() {
      const selected = selection(), info = identity();
      return Boolean(selected && current.ble?.address === selected.address && credentials && info?.serial.toLowerCase() === credentials.serial.toLowerCase());
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
      reset(credentials ? 'Saved credentials ready. Connect and authenticate to browse recordings.' : 'Select a PLAUD recorder and import its device credentials.');
      get('credential-tools').open = !credentials;
    }
    function guard(token = generation) {
      if (token !== generation) throw new Error('The PLAUD session changed. Authenticate again.');
      if (!online || !current.ble?.connected) throw new Error('Connect the PLAUD recorder before continuing.');
      if (!matches()) throw new Error('Credentials must match the serial advertised by the connected PLAUD recorder.');
      const handles = p.handles(current);
      if (!Number.isInteger(handles.command) || !Number.isInteger(handles.response)) throw new Error('PLAUD command and response characteristics are unavailable.');
      return handles;
    }
    function sync() {
      const device = selection(), info = NanoRecorders.identify(device), ready = online && matches() && Number.isInteger(p.handles(current).command);
      const connected = Boolean(device && current.ble?.connected && current.ble.address === device.address);
      get('target').textContent = info ? `${info.product} · ${info.serial} · ${!online ? 'board offline' : connected ? 'connected' : 'disconnected'}` : 'Select a PLAUD recorder from Discover or Apps.';
      const canAuthenticate = online && Boolean(candidate());
      get('credentials').textContent = credentials ? `Credentials for ${credentials.serial.toUpperCase()} · ${NanoCredentials.status().persistent ? 'saved in this browser' : 'memory only; export a backup in Settings'}` : 'No credentials saved for the selected recorder.';
      get('authenticate').textContent = connected ? authenticated ? 'Authenticated' : 'Authenticate' : current.ble?.connected ? 'Switch and authenticate' : 'Connect and authenticate';
      get('authenticate').disabled = !canAuthenticate || running || current.ble?.busy || authenticated && connected;
      get('list').disabled = !ready || !authenticated || running || current.ble?.busy;
      get('credentials-file').disabled = running;
      for (const button of get('files').querySelectorAll('button')) button.disabled = !ready || !authenticated || running || current.ble?.busy || Number(button.dataset.size) > maxBytes;
      get('stop').hidden = !transfer?.active; get('save').hidden = !verified;
      if (transfer) {
        get('meter').hidden = false; get('meter').max = transfer.size || 1; get('meter').value = transfer.received;
        get('progress').textContent = `${transfer.received.toLocaleString()} / ${transfer.size.toLocaleString()} bytes${transfer.error ? ` · ${transfer.error}` : verified ? ' · Ogg verified' : ''}`;
      }
    }
    function fail(message) {
      if (transfer?.active) transfer.error = message;
      if (waiter) { const pending = waiter; waiter = null; clearTimeout(pending.timer); pending.reject(new Error(message)); }
    }
    function reset(message) {
      generation++; authenticated = false; session = null; fail(message);
      if (transfer?.active) transfer.active = false;
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
        if (event.address !== target || event.handle !== handle || !['notification', 'indication'].includes(event.kind)) continue;
        rx = rx.then(() => receive(event, token)).catch(error => {
          if (token !== generation) return;
          fail(error.message); if (!running) { authenticated = false; session = null; get('status').textContent = 'PLAUD session validation failed. Authenticate again.'; }
        });
      }
      sync();
    });
    lab.onState((state, available = true) => {
      const next = state.ble?.connected ? state.ble.address : '';
      current = state; online = available;
      if (target && target !== next) reset('PLAUD disconnected. Saved credentials are ready for reconnection.');
      target = next; loadSaved();
      if (!online && waiter) fail('The board is unavailable. The operation is incomplete.');
      sync();
    });
    async function perform(operation, connectFirst = false) {
      if (running) return;
      running = true; get('status').classList.remove('error'); lab.setFastCapture(true); sync();
      try {
        if (connectFirst) {
          const device = candidate();
          if (!online || !device) throw new Error('Select the PLAUD recorder matching the saved credentials.');
          get('status').textContent = 'Connecting to the matching PLAUD recorder…';
          current = await NanoConnection.ensure(device); target = current.ble?.address || '';
        }
        guard(); await operation();
      }
      catch (error) {
        fail(error.message); get('status').textContent = error.message; get('status').classList.add('error');
        const stopping = transfer?.active; generation++;
        if (stopping && session && matches() && online && current.ble?.connected) {
          try { await write(session.seal(p.command(29))); } catch { get('status').textContent += ' Stop could not be confirmed.'; }
        }
      } finally {
        if (transfer) { transfer.active = false; transfer.buffer = null; }
        running = false; lab.setFastCapture(false); sync();
      }
    }
    get('credentials-file').addEventListener('change', async () => {
      const file = get('credentials-file').files[0]; if (!file) return;
      try {
        if (file.size > 32768) throw new Error('Choose a credentials JSON file smaller than 32 KiB.');
        let value; try { value = JSON.parse(await file.text()); } catch { throw new Error('The credential file is not valid JSON.'); }
        const loaded = p.credentials(value), result = NanoCredentials.savePlaud(value);
        loadSaved(true); get('status').textContent = result.error || `Saved credentials for ${loaded.serial.toUpperCase()}. Select that recorder to authenticate.`;
      } catch (error) { get('status').textContent = error.message; }
      finally { get('credentials-file').value = ''; sync(); }
    });
    document.addEventListener('nanoscope:credentials-changed', () => { loadSaved(); sync(); });
    document.addEventListener('nanoscope:selection', () => { loadSaved(); sync(); });
    get('credential-settings').addEventListener('click', () => { NanoWorkspace.show('settings'); document.getElementById('credentials-panel')?.scrollIntoView({ block: 'start' }); });
    get('authenticate').addEventListener('click', () => perform(async () => {
      authenticated = false; session = null; records = []; renderFiles();
      get('status').textContent = 'Subscribing and authenticating the device signature…';
      await lab.action('subscribe', { handle: guard().response, mode: 'notify' });
      const assembler = new p.Assembler(); let publicKeySent = false;
      const wrapped = await exchange(token => sendChunks(0xfe10, credentials.signature, token), async (packet, token) => {
        if (packet.length < 2) throw new Error('Truncated PLAUD authentication reply.');
        const opcode = u16(packet, 0);
        if (opcode === 0xfe11 && !publicKeySent) {
          publicKeySent = true; get('status').textContent = 'Exchanging the public key…';
          await sendChunks(0xfe12, new TextEncoder().encode(credentials.publicKeyPem), token);
        } else if (opcode === 0xfe12) { const result = assembler.add(packet); if (result) return result; }
      }, true);
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
      authenticated = true; get('status').textContent = 'Authenticated. Ready to list recordings.';
    }, true));
    function renderFiles() {
      get('files').replaceChildren();
      if (!records.length) { get('files').append(el('p', 'vendor-note', authenticated ? 'No recordings on this recorder.' : 'Authenticate to list recordings.')); return; }
      for (const recording of records) {
        const row = el('div', 'plaud-recording'), label = el('div');
        label.append(el('strong', '', `Recording ${recording.id}`), el('small', '', `${recording.size.toLocaleString()} bytes${recording.size > maxBytes ? ' · exceeds 64 MiB download limit' : ''}`));
        const button = el('button', 'button secondary', 'Download'); button.dataset.size = recording.size;
        button.addEventListener('click', () => perform(() => download(recording))); row.append(label, button); get('files').append(row);
      }
      sync();
    }
    get('list').addEventListener('click', () => perform(async () => {
      get('status').textContent = 'Reading the recording list…';
      const request = p.listRequest(0), requestId = u32(request, 3), entries = new Map(); let total = null;
      records = await exchange(token => write(session.seal(request), token), packet => {
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
      renderFiles(); get('status').textContent = `${records.length} recordings found.`;
    }));
    async function download(recording) {
      if (!authenticated || !session) throw new Error('Authenticate before downloading.');
      if (!Number.isSafeInteger(recording.size) || recording.size < 1 || recording.size > maxBytes) throw new Error('This recorder supports downloads from 1 byte through 64 MiB in this browser.');
      verified = null; transfer = { active: true, size: recording.size, id: recording.id, received: 0, buffer: new Uint8Array(recording.size), header: false, ended: false, error: '' };
      const item = transfer, token = generation; get('status').textContent = `Downloading recording ${recording.id}…`; sync();
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
