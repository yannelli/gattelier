'use strict';

const NanoTraffic = (() => {
  let getCapture, imported = null, liveMessage = 'Listening for BLE events', selected = null, scheduled = null, streams = [];
  let paused = false, markers = [];
  const el = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const get = id => document.getElementById(`traffic-${id}`);
  const key = event => `${event.bootId}:${event.seq}`;
  function save(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = el('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function decodeSelected() {
    const container = get('decoder'); container.replaceChildren();
    if (!selected) { container.append(el('p', 'hint', 'No packet selected')); return; }
    get('selected').textContent = `Packet ${selected.seq} · ${selected.kind} · handle ${selected.handle ?? '—'} · ${selected.address || 'No address'}`;
    const data = NanoPackets.bytes(selected.hex || '');
    get('offset').max = data.length;
    const offset = Math.max(0, Math.min(data.length, Number(get('offset').value) || 0));
    get('offset').value = offset;
    const result = NanoPackets.decode(selected.hex || '', offset);
    const table = el('table', 'byte-table');
    const head = el('thead'); const heading = el('tr');
    for (const label of ['Offset', 'HEX bytes', 'ASCII']) heading.append(el('th', '', label));
    head.append(heading); table.append(head);
    const body = el('tbody');
    for (const row of result.rows) {
      const tr = el('tr');
      tr.append(el('td', 'mono', row.offset.toString(16).padStart(4, '0')), el('td', 'mono', row.hex), el('td', 'mono', row.ascii));
      body.append(tr);
    }
    table.append(body); const scroll = el('div', 'table-scroll'); scroll.append(table); container.append(scroll);
    const numbers = el('dl', 'decode-values');
    for (const [label, property] of [['uint16 LE', 'uint16LE'], ['uint16 BE', 'uint16BE'], ['uint32 LE', 'uint32LE'], ['uint32 BE', 'uint32BE'], ['float32 LE', 'float32LE'], ['float32 BE', 'float32BE']]) {
      const field = el('div'); field.append(el('dt', '', label), el('dd', 'mono', result[property] === null ? 'Insufficient bytes' : String(result[property]))); numbers.append(field);
    }
    container.append(numbers);
    const typed = NanoGattValues.decode(selected.uuid || '', selected.hex || '');
    if (typed.length) { const values = el('dl', 'decode-values'); for (const field of typed) { const item = el('div'); item.append(el('dt', '', field.label), el('dd', '', field.value)); values.append(item); } container.prepend(values); }
    const prior = NanoAnalysis.previous(getCapture().events, selected);
    if (prior && !selected.truncated && !selected.redacted) {
      const differences = NanoAnalysis.delta(prior.hex, selected.hex || '');
      const detail = el('details', 'packet-differences'); detail.append(el('summary', '', `${differences.length} changed bytes since packet ${prior.seq} · ${Math.max(0, selected.ms - prior.ms)} ms`));
      for (const diff of differences) detail.append(el('p', 'mono', `Offset ${diff.offset}: ${diff.before} → ${diff.after}${diff.mask ? ` · XOR ${diff.mask}` : ''}`));
      if (!differences.length) detail.append(el('p', 'vendor-note', 'The payloads are identical.'));
      container.append(detail);
    }
    const protocol = NanoRecorders.decode(selected);
    if (protocol) container.prepend(el('p', 'lab-status', protocol));
    if (selected.message) container.append(el('p', 'vendor-note', selected.message));
    if (selected.truncated || selected.redacted) container.append(el('p', 'error', selected.redacted ? 'Payload redacted.' : 'Packet was truncated on the board.'));
  }
  function renderStreams(events) {
    const prior = get('stream').value;
    const found = new Map();
    for (const event of events) if (NanoPackets.isRx(event)) {
      const streamKey = JSON.stringify([event.bootId, event.address, event.handle]);
      if (!found.has(streamKey)) found.set(streamKey, { bootId: event.bootId, address: event.address, handle: event.handle });
    }
    streams = [...found.values()];
    const signature = [...found.keys()].join('|');
    if (get('stream').dataset.signature === signature) return;
    get('stream').dataset.signature = signature;
    get('stream').replaceChildren(...streams.map(stream => {
      const option = el('option', '', `Handle ${stream.handle} · ${stream.address || 'Unknown device'} · boot ${stream.bootId}`);
      option.value = JSON.stringify([stream.bootId, stream.address, stream.handle]); return option;
    }));
    if (found.has(prior)) get('stream').value = prior;
    get('binary').disabled = !streams.length;
  }
  function render() {
    scheduled = null;
    if (paused || get('rows').closest('[hidden]')) return;
    const capture = getCapture(); const stats = capture.stats;
    get('summary').textContent = capture.counts
      ? `${capture.events.length.toLocaleString()} retained / ${stats.received.toLocaleString()} decoded events · ${capture.counts.records.toLocaleString()} HCI records · ${capture.counts.attPackets.toLocaleString()} ATT packets · ${stats.gaps} continuity issues${capture.format === 'btsnoop' ? ` · ${stats.controllerDropped} controller packets dropped` : ''} · ${stats.browserDropped} browser evictions · ${stats.truncated} truncated records · completeness ${capture.completeness}`
      : `${capture.events.length.toLocaleString()} stored / ${stats.received.toLocaleString()} received · ${stats.gaps} missing events · ${stats.boardDropped} board overwrites · ${stats.browserDropped} browser evictions · ${stats.truncated} truncated · ${stats.reboots} reboots`;
    const filtered = NanoAnalysis.filter(NanoPackets.filter(capture.events, { handle: get('handle').value, kind: get('kind').value, text: get('search').value }), get('direction').value, get('uuid').value);
    get('count').textContent = `Showing latest ${Math.min(200, filtered.length)} of ${filtered.length.toLocaleString()} matching events`;
    const fragment = document.createDocumentFragment();
    for (const event of filtered.slice(-200).reverse()) {
      const row = el('tr'); row.classList.toggle('selected', selected && key(selected) === key(event));
      const cell = el('td'); const choose = el('button', 'packet-select', `${(event.ms / 1000).toFixed(3)}s`);
      choose.type = 'button'; choose.setAttribute('aria-label', `Inspect packet ${event.seq}, ${event.kind}`);
      choose.addEventListener('click', () => {
        selected = event; get('offset').value = 0;
        const value = JSON.stringify([event.bootId, event.address, event.handle]);
        if (streams.some(stream => JSON.stringify([stream.bootId, stream.address, stream.handle]) === value)) get('stream').value = value;
        decodeSelected(); render();
      });
      cell.append(choose); row.append(cell, el('td', 'packet-direction', event.protocolDirection || NanoPackets.direction(event.kind)), el('td', '', event.kind), el('td', 'mono', event.handle ?? ''));
      const payload = el('td', 'packet-payload', event.hex || event.message || '—'); payload.title = event.hex || event.message || '';
      const ascii = el('td', 'packet-ascii', NanoPackets.ascii(NanoPackets.bytes(event.hex || '')));
      if (event.success === false || event.truncated) row.classList.add('packet-warning');
      row.append(payload, ascii); fragment.append(row);
    }
    const focused = get('rows').contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    get('rows').replaceChildren(fragment);
    if (focused) Array.from(get('rows').querySelectorAll('button')).find(item => item.getAttribute('aria-label') === focused)?.focus({ preventScroll: true });
    get('empty').hidden = filtered.length > 0;
    renderStreams(capture.events);
  }
  function refresh() { if (!scheduled) scheduled = setTimeout(render, 200); }
  function exportCapture(format) {
    const capture = getCapture();
    const incomplete = capture.stats.gaps || capture.stats.browserDropped || capture.stats.truncated || capture.stats.controllerDropped || capture.counts?.redacted || capture.errors?.length;
    capture.completeness = incomplete ? 'incomplete' : 'unverified';
    capture.markers = markers.filter(marker => capture.events.some(event => event.bootId === marker.bootId));
    save(`nanoscope-capture-${Date.now()}.${format}`, format === 'csv' ? NanoPackets.csv(capture) : JSON.stringify(capture, null, 2), format === 'csv' ? 'text/csv' : 'application/json');
    get('export-status').textContent = `Exported ${capture.events.length} retained events. Capture completeness: ${capture.completeness}.`;
  }
  function exportBinary() {
    const stream = streams.find(item => JSON.stringify([item.bootId, item.address, item.handle]) === get('stream').value);
    if (!stream) return;
    const result = NanoPackets.rxBinary(getCapture(), stream);
    const status = result.incomplete ? 'incomplete' : 'unverified';
    save(`rx-handle-${stream.handle}-${status}.bin`, result.data, 'application/octet-stream');
    get('export-status').textContent = `${result.data.length.toLocaleString()} bytes from ${result.packets} RX packets exported. ${result.incomplete ? 'Incomplete: capture gaps, eviction, or truncated data.' : 'Raw RX bytes; file completeness is unverified.'}`;
  }
  function connection(message) {
    liveMessage = message;
    if (get('connection')) get('connection').textContent = imported ? 'Viewing imported HCI capture · board capture continues' : message;
  }
  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('Choose an HCI capture smaller than 32 MB.');
      const data = await file.arrayBuffer(), btsnoop = NanoBTSnoop.matches(data);
      if (!btsnoop && !NanoPKLG.matches(data)) throw new Error('Unrecognized capture. Use PacketLogger or uncompressed btsnoop; compressed btsnooz needs AOSP conversion.');
      const result = btsnoop ? NanoBTSnoop.parse(data) : NanoPKLG.parse(data);
      result.pocketKeys.length = 0;
      if (!result.events.length) throw new Error(result.errors[0] || result.warnings[0] || 'No supported ATT traffic found.');
      const format = btsnoop ? 'btsnoop' : 'pklg', bootId = `${format}-${Date.now()}`, events = result.events.slice(-10000).map(event => ({ ...event, bootId }));
      imported = { bootId, nextSeq: events.at(-1).seq, events, source: file.name, format, startedAt: result.startedAt, warnings: result.warnings, errors: result.errors, counts: { ...result.counts },
        metadata: result.metadata ? { ...result.metadata } : { format, byteOrder: result.byteOrder },
        completeness: !result.complete || result.counts.redacted || result.events.length > events.length ? 'incomplete' : 'unverified',
        stats: { received: result.events.length, gaps: result.counts.incompletePackets + result.counts.malformedPackets, controllerDropped: result.metadata?.observedDrops || 0, boardDropped: 0, browserDropped: result.events.length - events.length, truncated: result.metadata?.truncatedRecords || 0, reboots: 0 } };
      paused = false; get('pause').textContent = 'Pause view'; get('pause').setAttribute('aria-pressed', 'false');
      for (const id of ['handle', 'kind', 'search', 'direction', 'uuid']) get(id).value = '';
      selected = null; get('live').hidden = false; connection(liveMessage); render(); decodeSelected();
      get('export-status').textContent = `${file.name}: ${btsnoop ? 'btsnoop' : 'PacketLogger'}, ${result.counts.records} HCI records, ${result.counts.attPackets} ATT packets, ${result.events.length} decoded events, ${result.counts.redacted} authentication payloads redacted. Completeness ${imported.completeness}. ${result.warnings.slice(0, 2).join(' ')} ${result.errors.slice(0, 2).join(' ')}`;
    } catch (error) { get('export-status').textContent = error.message; }
    finally { get('import').value = ''; }
  }
  function mount(container, captureProvider) {
    getCapture = () => imported || captureProvider();
    container.innerHTML = '<div class="panel-heading"><div><h2>Traffic capture</h2><p id="traffic-connection">Listening for BLE events</p></div><div class="heading-tools"><button id="traffic-pause" class="button quiet">Pause view</button><button id="traffic-live" class="button quiet" hidden>Back to live</button><label class="button secondary file-button">Import<input id="traffic-import" type="file" accept=".pklg,.btsnoop,.log,.cfa" aria-label="Import PacketLogger or btsnoop HCI capture"></label><details class="help"><summary aria-label="About traffic capture"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Shows BLE events from this board, up to the latest 10,000. Import a PacketLogger or btsnoop capture to inspect traffic from a phone or computer.</p><p>Markers label the latest packet so you can line up an action with the traffic it caused.</p><p>RX binary export joins received payloads for one boot, device and handle. It does not check that a recorder file is complete.</p></div></details></div></div><div class="lab-body"><div class="traffic-toolbar"><input id="traffic-search" type="search" placeholder="Search packets" aria-label="Search packets by HEX, ASCII, UUID or address" autocomplete="off"><details class="traffic-filter-menu"><summary>Filters</summary><div class="traffic-filters"><label>Handle<input id="traffic-handle" placeholder="All" autocomplete="off" spellcheck="false"></label><label>Event type<select id="traffic-kind"><option value="">All events</option></select></label><label>Direction<select id="traffic-direction"><option value="">All directions</option><option>RX</option><option>TX</option><option>EVENT</option></select></label><label>UUID<input id="traffic-uuid" placeholder="Any"></label></div></details></div><p id="traffic-summary" class="lab-status" role="status"></p><div class="table-scroll traffic-scroll"><table class="traffic-table"><thead><tr><th>Elapsed time</th><th>Direction</th><th>Type</th><th>Handle</th><th>HEX / message</th><th>ASCII</th></tr></thead><tbody id="traffic-rows"></tbody></table><p id="traffic-empty" class="hint">No traffic yet</p></div><div class="traffic-footer"><p id="traffic-count" class="vendor-note"></p><details class="traffic-export-menu"><summary>Export</summary><div class="traffic-exports"><button id="traffic-json" class="button secondary">JSON</button><button id="traffic-csv" class="button secondary">CSV</button><label>RX stream<select id="traffic-stream"></select></label><button id="traffic-binary" class="button secondary" disabled>RX binary</button></div></details></div><p id="traffic-export-status" class="vendor-note" role="status"></p><div class="decoder-heading"><h3 id="traffic-selected">Packet inspector</h3><label>Byte offset<input id="traffic-offset" type="number" min="0" value="0" step="1"></label></div><div id="traffic-decoder"></div></div>';
    const tools = el('div', 'traffic-analysis');
    tools.innerHTML = '<input id="traffic-marker" maxlength="120" placeholder="Marker label" aria-label="Marker label"><button id="traffic-mark" class="button secondary">Add marker</button><p id="traffic-markers" class="vendor-note" role="status"></p>';
    get('summary').before(tools);
    get('pause').addEventListener('click', () => { paused = !paused; get('pause').textContent = paused ? 'Resume view' : 'Pause view'; get('pause').setAttribute('aria-pressed', String(paused)); if (paused) get('count').textContent = 'View paused. Capture continues in memory.'; else render(); });
    get('mark').addEventListener('click', () => {
      const label = get('marker').value.trim(); if (!label) return;
      const last = getCapture().events.at(-1);
      if (!last) { get('markers').textContent = 'Capture a packet before adding a marker.'; return; }
      markers.push({ label, bootId: last.bootId, afterSeq: last.seq, at: Date.now() });
      get('markers').textContent = markers.slice(-5).map(item => `${item.label} · after packet ${item.afterSeq}`).join(' | '); get('marker').value = '';
    });
    for (const kind of ['read', 'write', 'write-result', 'notification', 'indication', 'advertisement', 'connect', 'disconnect', 'error', 'subscribe']) {
      const option = el('option', '', kind); option.value = kind; get('kind').append(option);
    }
    for (const id of ['handle', 'kind', 'search', 'direction', 'uuid']) get(id).addEventListener('input', render);
    get('offset').addEventListener('input', decodeSelected);
    get('json').addEventListener('click', () => exportCapture('json')); get('csv').addEventListener('click', () => exportCapture('csv'));
    get('import').addEventListener('change', () => importFile(get('import').files[0]));
    get('live').addEventListener('click', () => { imported = null; selected = null; get('live').hidden = true; connection(liveMessage); render(); decodeSelected(); });
    get('binary').addEventListener('click', exportBinary); render(); decodeSelected();
  }
  return { mount, refresh, connection };
})();
