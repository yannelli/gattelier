'use strict';

const NanoDexcomView = (() => {
  const el = (tag, cls = '', text) => { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const time = value => Number.isFinite(value) ? new Date(value).toLocaleString() : 'Unavailable';
  function render(container, data, saved = false) {
    container.replaceChildren();
    const latest = data.latest, records = data.records || [];
    const hero = el('div', 'dexcom-reading');
    hero.append(el('span', 'eyebrow', saved ? 'Saved reading' : 'Last reading'));
    const number = el('div', 'dexcom-glucose'); number.append(el('strong', '', latest?.glucoseMgDl ?? '--'), el('span', 'hint', 'mg/dL')); hero.append(number);
    if (latest) hero.append(el('p', 'hint', `${latest.stateLabel} · ${time(latest.timestamp)}`));
    if (Number.isFinite(latest?.trendMgDlMinute)) hero.append(el('p', 'hint', `Trend ${latest.trendMgDlMinute > 0 ? '+' : ''}${latest.trendMgDlMinute} mg/dL per minute`));
    container.append(hero);
    const fields = el('dl', 'dexcom-fields');
    const add = (name, value) => { const row = el('div'); row.append(el('dt', '', name), el('dd', '', String(value))); fields.append(row); };
    if (latest) add('Sensor state', `${latest.stateLabel} (0x${latest.state.toString(16).padStart(2, '0')})`);
    if (Number.isFinite(data.estimatedStart)) add('Started (estimated)', time(data.estimatedStart));
    if (data.identity?.serial) add('Serial number', data.identity.serial);
    if (data.identity?.firmware) add('Firmware', data.identity.firmware);
    if (latest) { add('Transmitter status', `0x${latest.statusRaw.toString(16).padStart(2, '0')}`); add('Reading age at receipt', `${latest.ageSeconds} seconds`); }
    if (fields.children.length) container.append(fields);
    if (!records.length) return;
    const heading = el('div', 'dexcom-history-heading'); heading.append(el('h3', '', `History · ${records.length} reading${records.length === 1 ? '' : 's'}`));
    if (records.length > 100) heading.append(el('span', 'hint', 'Showing the latest 100. Export includes all readings.'));
    const table = el('table', 'dexcom-history'), head = el('thead'), headings = el('tr'), rows = el('tbody');
    for (const label of ['Time (estimated)', 'Glucose', 'State', 'Source']) { const th = el('th', '', label); th.scope = 'col'; headings.append(th); } head.append(headings);
    for (const item of records.slice(-100).reverse()) {
      const row = el('tr');
      for (const value of [time(item.timestamp), item.glucoseMgDl === null ? `Unavailable (${item.glucoseRaw})` : `${item.glucoseMgDl} mg/dL`, item.stateLabel, item.source]) row.append(el('td', '', String(value)));
      rows.append(row);
    }
    table.append(head, rows); const scroll = el('div', 'table-scroll'); scroll.append(table); container.append(heading, scroll);
  }
  function csv(data) {
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const fields = ['timestamp', 'clock', 'glucoseMgDl', 'stateLabel', 'trendMgDlMinute', 'source'];
    return [fields.join(','), ...(data.records || []).map(row => fields.map(key => quote(key === 'timestamp' && Number.isFinite(row[key]) ? new Date(row[key]).toISOString() : row[key])).join(','))].join('\r\n');
  }
  return { el, render, csv };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcomView;
