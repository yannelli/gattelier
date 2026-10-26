'use strict';

const NanoCredentialsUI = (() => {
  function mount(container) {
    if (!container) return;
    const get = id => container.querySelector(`#credentials-${id}`);
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    container.innerHTML = '<div class="panel-heading"><div><h2>Saved credentials</h2><p>Recorder access saved in this browser</p></div></div><div class="credentials-body"><p id="credentials-storage" class="vendor-note" role="status"></p><div id="credentials-list"></div><div class="credentials-actions"><button id="credentials-export" class="button secondary" type="button">Export credentials</button><label class="button secondary credentials-import">Import / restore<input id="credentials-import" type="file" accept=".json,application/json" aria-label="Import credentials backup or PLAUD credentials"></label></div><p class="vendor-note">Exports contain private keys and session keys. Credentials are stored in this browser for this address. Import a backup to restore them in another browser or at another address.</p><p id="credentials-status" role="status"></p><details class="credentials-help"><summary>Capture and restore recorder access</summary><h3>Pocket: extract from an iPhone capture</h3><ol><li>Install Apple Bluetooth logging profile on the iPhone, restart it, and connect it to the Mac.</li><li>Start an iPhone capture in PacketLogger. Open Pocket and connect your recorder to capture the authentication exchange.</li><li>Save the .pklg capture and select your Pocket in Discover. Open the Pocket app here, then load the capture. Gattelier extracts one unique key locally.</li><li>Press Connect and authenticate. Gattelier saves an accepted key for that Pocket Bluetooth address.</li></ol><a href="https://developer.apple.com/bug-reporting/profiles-and-logs/?name=bluetooth" target="_blank" rel="noopener noreferrer">Apple Bluetooth logging profiles</a><h3>PLAUD: restore the device credential file</h3><p>Import the device JSON containing serial, userId, privateKeyPem, publicKeyPem and signature. These account credentials must match the recorder. An encrypted Bluetooth trace does not contain the private key needed to reconstruct this file.</p><p>For a new device, capture the companion app Bluetooth exchange and retain the account and device credentials during authorized setup. Gattelier does not generate an account signature or retrieve cloud credentials.</p><h3>Restore a Gattelier backup</h3><p>Choose Import / restore above. The import replaces matching device identities and keeps other saved credentials. Connect to a recorder and open its app to use the restored credentials.</p></details></div>';
    function render() {
      const status = NanoCredentials.status(), entries = NanoCredentials.list();
      get('storage').textContent = status.error || `${status.count} saved credential${status.count === 1 ? '' : 's'} · ${status.persistent ? 'Browser local storage' : 'Memory only'}`;
      get('export').disabled = !entries.length; get('list').replaceChildren();
      for (const item of entries) {
        const row = el('div', 'credential-row'), label = el('div');
        label.append(el('strong', '', item.kind === 'plaud' ? 'PLAUD' : 'Pocket'), el('span', 'mono', item.id));
        const remove = el('button', 'button quiet', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${item.kind} credentials for ${item.id}`);
        remove.addEventListener('click', () => { const result = NanoCredentials.remove(item.kind, item.id); get('status').textContent = result.persistent ? 'Credential removed from this browser.' : 'Removed for this page session. Browser storage could not be updated; saved credentials can return after reload.'; });
        row.append(label, remove); get('list').append(row);
      }
      if (!entries.length) get('list').append(el('p', 'hint', 'Import a backup or save credentials from a recorder app.'));
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
