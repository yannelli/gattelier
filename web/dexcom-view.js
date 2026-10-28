'use strict';

const NanoDexcomView = (() => {
  const el = (tag, cls = '', text) => { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const time = value => Number.isFinite(value) ? new Date(value).toLocaleString() : 'Unavailable';
  function series(records) {
    const ordered = [...records].sort((a, b) => a.clock - b.clock), timed = ordered.filter(item => Number.isFinite(item.timestamp));
    if (!timed.length) return null;
    const valid = item => Number.isFinite(item.timestamp) && Number.isFinite(item.glucoseMgDl) && item.glucoseMgDl > 0 && !item.stale && !item.displayOnly && (item.state === undefined || [6, 7].includes(item.state)) && !(item.ageSeconds > 600);
    const values = timed.filter(valid).map(item => item.glucoseMgDl);
    if (!values.length) return null;
    let start = Math.min(...timed.map(item => item.timestamp)), end = Math.max(...timed.map(item => item.timestamp));
    if (start === end) { start -= 150000; end += 150000; }
    const low = Math.floor((Math.min(...values) - 10) / 10) * 10, high = Math.ceil((Math.max(...values) + 10) / 10) * 10;
    const x = stamp => 55 + (stamp - start) / (end - start) * 610, y = value => 180 - (value - low) / (high - low) * 150;
    const segments = [], points = []; let segment = null, previous = null;
    for (const item of ordered) {
      if (!valid(item)) { segment = null; previous = null; continue; }
      if (!segment || item.timestamp <= previous || item.timestamp - previous > 450000) { segment = []; segments.push(segment); }
      const point = { x: x(item.timestamp), y: y(item.glucoseMgDl), timestamp: item.timestamp, value: item.glucoseMgDl };
      segment.push(point); points.push(point); previous = item.timestamp;
    }
    return { start, end, low, high, segments, points, x, y };
  }
  function plot(records) {
    const data = series(records);
    if (!data) return el('p', 'hint', 'A plot needs readings with glucose values and recorded times.');
    const svg = (tag, attributes = {}, text) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const figure = el('figure', 'dexcom-plot'), chart = svg('svg', { viewBox: '0 0 720 235', role: 'img', 'aria-label': 'Glucose history in mg/dL by recorded local time' });
    chart.append(svg('title', {}, 'Glucose history'), svg('desc', {}, 'Lines break across unavailable readings and intervals longer than seven and a half minutes.'));
    for (const value of [data.low, (data.low + data.high) / 2, data.high]) {
      chart.append(svg('line', { x1: 55, x2: 665, y1: data.y(value), y2: data.y(value), class: 'dexcom-plot-grid' }), svg('text', { x: 47, y: data.y(value) + 4, 'text-anchor': 'end' }, value));
    }
    chart.append(svg('text', { x: 55, y: 16 }, 'mg/dL'));
    for (const stamp of [data.start, (data.start + data.end) / 2, data.end]) chart.append(svg('text', { x: data.x(stamp), y: 204, 'text-anchor': 'middle' }, new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    chart.append(svg('text', { x: 360, y: 228, 'text-anchor': 'middle' }, 'Time (estimated, local)'));
    for (const segment of data.segments) chart.append(svg('polyline', { points: segment.map(point => `${point.x},${point.y}`).join(' '), class: 'dexcom-plot-line' }));
    for (const point of data.points) {
      const dot = svg('circle', { cx: point.x, cy: point.y, r: 2.5, class: 'dexcom-plot-point' });
      dot.append(svg('title', {}, `${time(point.timestamp)}: ${point.value} mg/dL`)); chart.append(dot);
    }
    figure.append(chart, el('figcaption', 'hint', `${time(data.start)} to ${time(data.end)}. Gaps show missing or unavailable readings.`));
    return figure;
  }
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
    table.append(head, rows); const scroll = el('div', 'table-scroll'); scroll.append(table); container.append(heading, plot(records), scroll);
  }
  function csv(data) {
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const fields = ['timestamp', 'clock', 'glucoseMgDl', 'stateLabel', 'trendMgDlMinute', 'source'];
    return [fields.join(','), ...(data.records || []).map(row => fields.map(key => quote(key === 'timestamp' && Number.isFinite(row[key]) ? new Date(row[key]).toISOString() : row[key])).join(','))].join('\r\n');
  }
  return { el, render, csv, series, plot };
})();
if (typeof module !== 'undefined') module.exports = NanoDexcomView;
