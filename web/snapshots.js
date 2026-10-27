'use strict';

const NanoSnapshots = (() => {
  const STORAGE = 'nanoscope.snapshots.v1';
  function mount(container, { getDevice, getState }) {
    if (!container) return;
    let snapshots = [], memoryOnly = false, deleted = null;
    const get = name => container.querySelector(`#snapshot-${name}`);
    container.innerHTML = `<div class="panel-heading"><div><h2>Device snapshots</h2></div><div class="heading-tools"><span id="snapshot-count" class="badge">0 of 20</span><details class="help"><summary aria-label="About snapshots"><span aria-hidden="true">?</span></summary><div class="help-body"><p>A snapshot saves the selected device's advertisement and, if connected, its GATT schema. Up to 20 stay in this browser.</p><p>Loaded values are values you already read. Saving them never reads the device. Recorder session values and recognizable authentication payloads are left out.</p><p>Comparisons ignore signal strength and timestamps.</p></div></details></div></div>
      <div class="snapshots-body"><form id="snapshot-form" class="snapshot-capture"><label>Label<input id="snapshot-label" maxlength="160" placeholder="Optional" autocomplete="off"></label>
      <label class="snapshot-check"><input id="snapshot-values" type="checkbox">Include loaded values (may contain private data)</label>
      <button class="button primary" type="submit">Save selected device</button></form>
      <p id="snapshot-storage" class="vendor-note"></p><p id="snapshot-message" role="status" class="snapshot-message"></p>
      <div class="snapshot-pickers"><label>Baseline<select id="snapshot-baseline"></select></label><label>Current<select id="snapshot-current"></select></label></div>
      <div id="snapshot-facts" class="snapshot-facts"></div><div class="snapshot-actions"><button id="snapshot-compare" class="button secondary" type="button">Compare</button><button id="snapshot-export" class="button quiet" type="button">Export current</button><button id="snapshot-import" class="button quiet" type="button">Import JSON</button><input id="snapshot-file" type="file" accept="application/json,.json" hidden><button id="snapshot-delete" class="button quiet" type="button">Delete current</button><button id="snapshot-undo" class="button quiet" type="button" hidden>Undo delete</button></div>
      <div class="snapshot-results"><h3 id="snapshot-comparison-title">Comparison</h3><p id="snapshot-comparison-note" class="vendor-note"></p><div id="snapshot-diff" class="snapshot-diff"></div></div></div>`;
    const node = (tag, value, className) => { const result = document.createElement(tag); if (value != null) result.textContent = value; if (className) result.className = className; return result; };
    function message(value) { get('message').textContent = value; }
    function storageStatus() {
      get('storage').textContent = memoryOnly ? 'Browser storage is unavailable or full. Changes stay in this tab until it closes. Export snapshots to keep them.' : '';
    }
    function persist() {
      try { localStorage.setItem(STORAGE, JSON.stringify(snapshots)); memoryOnly = false; }
      catch { memoryOnly = true; }
      storageStatus();
    }
    function load() {
      try {
        const raw = localStorage.getItem(STORAGE);
        if (raw) {
          if (raw.length > NanoSnapshotModel.MAX_BYTES * 20 + 100) throw new Error('Saved snapshots exceed the storage limit.');
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed) || parsed.length > 20) throw new Error('Saved snapshot collection is invalid.');
          snapshots = parsed.map(NanoSnapshotModel.validate);
        }
      } catch (error) { memoryOnly = true; message(`Saved snapshots could not be loaded: ${error.message}`); }
      storageStatus();
    }
    function selected(name) { const value = get(name).value; return value === '' ? null : snapshots[Number(value)] || null; }
    function title(snapshot) { return `${snapshot.label} | ${snapshot.device.name || 'Unnamed device'} | ${snapshot.device.address}`; }
    function time(value) { return value == null ? 'Not recorded' : typeof value === 'number' ? `${value} s since board boot` : new Date(value).toLocaleString(); }
    function facts() {
      get('facts').replaceChildren();
      for (const [name, label] of [['baseline', 'Baseline'], ['current', 'Current']]) {
        const snapshot = selected(name); if (!snapshot) continue;
        const card = node('section'), heading = node('h3', `${label}: ${snapshot.label}`), detail = node('dl');
        const rows = [['Device', `${snapshot.device.name || 'Unnamed device'} / ${snapshot.device.address}`], ['Captured', time(snapshot.capturedAt)],
          ['First seen', time(snapshot.firstSeen)], ['Last seen', time(snapshot.lastSeen)], ['Signal', snapshot.rssi == null ? 'Not recorded' : `${snapshot.rssi} dBm`],
          ['GATT', snapshot.gatt === null ? 'Not captured (device was not connected)' : `${snapshot.gatt.length} services, ${snapshot.gatt.reduce((sum, service) => sum + service.characteristics.length, 0)} characteristics`],
          ['Values', snapshot.includeValues ? 'Existing readable values requested; session values excluded' : 'Omitted']];
        for (const [key, value] of rows) { const pair = node('div'); pair.append(node('dt', key), node('dd', value)); detail.append(pair); }
        card.append(heading, detail); get('facts').append(card);
      }
      get('compare').disabled = !selected('baseline') || !selected('current');
      get('export').disabled = get('delete').disabled = !selected('current');
      get('comparison-title').textContent = 'Comparison';
      get('comparison-note').textContent = '';
      get('diff').replaceChildren(node('p', snapshots.length ? 'Choose Compare to see changes.' : 'No snapshots saved yet.', 'snapshot-empty'));
    }
    function refresh(current = get('current').value, baseline = get('baseline').value) {
      for (const [name, chosen] of [['baseline', baseline], ['current', current]]) {
        const control = get(name); control.replaceChildren();
        if (!snapshots.length) { const option = node('option', 'No saved snapshots'); option.value = ''; control.append(option); }
        snapshots.forEach((snapshot, index) => { const option = node('option', `${index + 1}. ${title(snapshot)} (${time(snapshot.capturedAt)})`); option.value = String(index); control.append(option); });
        if (snapshots.length) control.value = String(Math.min(Math.max(0, Number(chosen) || 0), snapshots.length - 1));
        control.disabled = !snapshots.length;
      }
      get('count').textContent = `${snapshots.length} of 20`;
      get('undo').hidden = !deleted; facts();
    }
    function add(snapshot) {
      if (snapshots.length >= 20) throw new Error('20 snapshots are saved. Delete one before saving or importing another.');
      snapshots.push(snapshot); persist(); refresh(String(snapshots.length - 1));
    }
    get('form').addEventListener('submit', event => {
      event.preventDefault();
      try { add(NanoSnapshotModel.capture(getDevice(), getState(), { label: get('label').value.trim(), includeValues: get('values').checked })); message('Snapshot saved.'); }
      catch (error) { message(error.message); }
    });
    for (const name of ['baseline', 'current']) get(name).addEventListener('change', facts);
    get('compare').addEventListener('click', () => {
      try {
        const before = selected('baseline'), after = selected('current'); if (!before || !after) return;
        const changes = NanoSnapshotModel.diff(before, after);
        get('comparison-title').textContent = `${title(before)} → ${title(after)}`;
        get('comparison-note').textContent = `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}. ${before.device.address !== after.device.address ? 'Comparing different device addresses. ' : ''}`.trim();
        const target = get('diff'); target.replaceChildren();
        if (!changes.length) { target.append(node('p', 'No structural or included-value changes.', 'snapshot-empty')); return; }
        const table = node('table'), head = node('thead'), row = node('tr'), body = node('tbody');
        for (const label of ['Change', 'Field', 'Baseline', 'Current']) { const cell = node('th', label); cell.scope = 'col'; row.append(cell); }
        head.append(row); table.append(head, body);
        for (const change of changes) {
          const row = node('tr'); row.dataset.change = change.type;
          for (const value of [change.type, change.path, change.before, change.after]) {
            row.append(node('td', value === undefined ? 'Not present' : typeof value === 'string' ? value || '(empty)' : JSON.stringify(value)));
          }
          body.append(row);
        }
        target.append(table);
      } catch (error) { message(error.message); }
    });
    get('export').addEventListener('click', () => {
      const snapshot = selected('current'); if (!snapshot) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot)], { type: 'application/json' }));
      const link = node('a'); link.href = url; link.download = `nanoscope-snapshot-${snapshot.device.address.replace(/:/g, '')}-${snapshot.capturedAt.replace(/[^0-9]/g, '')}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    get('import').addEventListener('click', () => get('file').click());
    get('file').addEventListener('change', async () => {
      const file = get('file').files[0]; if (!file) return;
      try {
        if (file.size > NanoSnapshotModel.MAX_BYTES) throw new Error('Snapshot exceeds the 512 KB limit.');
        add(NanoSnapshotModel.validate(await file.text())); message('Snapshot imported. Unrecognized fields were omitted.');
      } catch (error) { message(error.message); }
      finally { get('file').value = ''; }
    });
    get('delete').addEventListener('click', () => {
      const index = Number(get('current').value); if (!snapshots[index]) return;
      deleted = { snapshot: snapshots[index], index }; snapshots.splice(index, 1); persist(); refresh(); message('Snapshot deleted. Undo is available until this tab closes or another snapshot is deleted.');
    });
    get('undo').addEventListener('click', () => {
      if (!deleted) return;
      if (snapshots.length >= 20) { message('Delete a snapshot to make room before restoring.'); return; }
      const index = Math.min(deleted.index, snapshots.length); snapshots.splice(index, 0, deleted.snapshot); deleted = null; persist(); refresh(String(index)); message('Snapshot restored.');
    });
    load(); refresh(snapshots.length - 1, 0);
  }
  return { mount };
})();
