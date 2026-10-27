'use strict';

const NanoCredentialsUI = (() => {
  function mount(container) {
    if (!container) return;
    const get = id => container.querySelector(`#credentials-${id}`);
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    container.innerHTML = '<div class="panel-heading"><div><h2>Saved credentials</h2><p id="credentials-storage" role="status"></p></div><details class="help"><summary aria-label="About credentials"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Recorder keys are stored in this browser for this board address. Exports contain private and session keys, so keep them safe. Importing a backup replaces matching devices and keeps the rest.</p><h3>Pocket: get a key from an iPhone capture</h3><ol><li>Install Apple’s Bluetooth logging profile on the iPhone, restart it and connect it to a Mac.</li><li>Start a capture in PacketLogger, then connect the recorder in the Pocket app.</li><li>Save the .pklg file. Select the Pocket in Discover, open the Pocket app here and load the capture.</li><li>Press Connect. Gattelier saves the key once the recorder accepts it.</li></ol><a href="https://developer.apple.com/bug-reporting/profiles-and-logs/?name=bluetooth" target="_blank" rel="noopener noreferrer">Apple Bluetooth logging profiles</a><h3>PLAUD: import the device file</h3><p>Import the device JSON with serial, userId, privateKeyPem, publicKeyPem and signature. It must match the recorder. Bluetooth traces do not contain the private key, and Gattelier cannot fetch it from the cloud.</p></div></details></div><div class="credentials-body"><div id="credentials-list"></div><div class="credentials-actions"><label class="button secondary credentials-import">Import<input id="credentials-import" type="file" accept=".json,application/json" aria-label="Import credentials backup or PLAUD credentials"></label><button id="credentials-export" class="button secondary" type="button">Export</button></div><p id="credentials-status" class="vendor-note" role="status"></p></div>';
    function render() {
      const status = NanoCredentials.status(), entries = NanoCredentials.list();
      get('storage').textContent = status.error || (status.count ? `${status.count} saved` : '') + (status.persistent ? '' : `${status.count ? ' · ' : ''}This tab only`);
      get('export').disabled = !entries.length; get('list').replaceChildren();
      for (const item of entries) {
        const row = el('div', 'credential-row'), label = el('div');
        label.append(el('strong', '', item.kind === 'plaud' ? 'PLAUD' : 'Pocket'), el('span', 'mono', item.id));
        const remove = el('button', 'button quiet', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${item.kind} credentials for ${item.id}`);
        remove.addEventListener('click', () => { const result = NanoCredentials.remove(item.kind, item.id); get('status').textContent = result.persistent ? 'Credential removed from this browser.' : 'Removed for this page session. Browser storage could not be updated; saved credentials can return after reload.'; });
        row.append(label, remove); get('list').append(row);
      }
      if (!entries.length) get('list').append(el('p', 'credentials-empty', 'No saved credentials'));
    }
    get('export').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(NanoCredentials.exportData(), null, 2)], { type: 'application/json' }));
      const link = el('a'); link.href = url; link.download = `nanoscope-credentials-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    get('import').addEventListener('change', async event => {
      const file = event.target.files[0]; if (!file) return;
      try {
        if (file.size > NanoCredentials.maxBytes) throw new Error('Credential imports must be under 512 KiB.');
        const value = JSON.parse(await file.text());
        const result = value?.format === 'nanoscope-credentials' ? NanoCredentials.importData(value) : NanoCredentials.savePlaud(value);
        get('status').textContent = result.error || `Imported ${result.imported ?? 1} credential record${result.imported === 1 || result.imported === undefined ? '' : 's'}.`;
      } catch (error) { get('status').textContent = error instanceof SyntaxError ? 'The selected file is not valid JSON.' : error.message; }
      finally { event.target.value = ''; render(); }
    });
    document.addEventListener('nanoscope:credentials-changed', render); render();
  }
  return { mount };
})();
