'use strict';

const NanoBrowserUI = (() => {
  const controls = { query: 'search', sort: 'sort', signal: 'filter-signal', lastSeen: 'filter-last-seen', kind: 'filter-kind', connectable: 'filter-connectable', favorites: 'filter-favorites', source: 'filter-source' };
  const defaults = { query: '', sort: 'strength', signal: 'all', lastSeen: 'all', kind: 'all', connectable: 'all', favorites: false, source: 'live' };
  function mount(store, hooks) {
    const get = id => document.getElementById(id), filters = {};
    for (const [key, id] of Object.entries(controls)) {
      const control = get(id); filters[key] = store.getPreference(key, defaults[key]);
      if (control.type === 'checkbox') control.checked = Boolean(filters[key]); else control.value = filters[key];
      control.addEventListener(key === 'query' ? 'input' : 'change', () => {
        filters[key] = control.type === 'checkbox' ? control.checked : control.value;
        store.setPreference(key, filters[key]); hooks.change();
      });
    }
    get('reset-filters').addEventListener('click', () => {
      for (const [key, id] of Object.entries(controls)) {
        filters[key] = defaults[key]; store.setPreference(key, filters[key]);
        const control = get(id); if (control.type === 'checkbox') control.checked = filters[key]; else control.value = filters[key];
      }
      hooks.change();
    });
    get('persist-history').checked = store.getPreference('persistent', true);
    get('background-scan').checked = store.getPreference('backgroundScan', false);
    get('persist-history').addEventListener('change', async () => { store.setPersistence(get('persist-history').checked); await store.flush(); hooks.change(); });
    get('background-scan').addEventListener('change', () => { store.setPreference('backgroundScan', get('background-scan').checked); hooks.change(); });
    get('export-history').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `nanoscope-discoveries-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    get('clear-history').addEventListener('click', async () => { store.clearHistory(); await store.flush(); hooks.change(); });
    get('import-history').addEventListener('change', async event => {
      const file = event.target.files[0]; if (!file) return;
      try {
        if (file.size > 16 * 1024 * 1024) throw new Error('History imports must be under 16 MB.');
        const result = store.importData(JSON.parse(await file.text()));
        await store.flush(); hooks.change();
        get('history-import-status').textContent = `Imported ${result.imported} devices. ${result.count} retained.`;
      } catch (error) { get('history-import-status').textContent = error.message; }
      finally { event.target.value = ''; }
    });
    function update() {
      const status = store.status(), text = status.persistent ? 'Saved in this browser' : 'In-memory session';
      get('history-status').textContent = `${text} · ${status.count} devices`;
      get('storage-status').textContent = `${text}. ${status.count} devices retained.${status.evicted ? ` ${status.evicted} older records evicted.` : ''}${status.error ? ` ${status.error}` : ''}`;
    }
    return {
      update,
      isFiltered() { return Object.entries(filters).some(([key, value]) => !['sort', 'source'].includes(key) && value !== defaults[key]); },
      select(devices, database) { return NanoScanQuery.select(devices, filters, { now: Date.now(), identifyVendor: device => NanoVendors.identify(device, database).search, profile: NanoProfiles.identify }); },
      setKind(category) {
        Object.assign(filters, defaults, { kind: category, source: 'all' });
        for (const [key, id] of Object.entries(controls)) { const control = get(id); if (control.type === 'checkbox') control.checked = filters[key]; else control.value = filters[key]; store.setPreference(key, filters[key]); }
        NanoWorkspace.show('discover'); hooks.change();
      }
    };
  }
  return { mount };
})();
