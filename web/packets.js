'use strict';

const NanoPackets = (() => {
  function bytes(hex = '') {
    if (typeof hex !== 'string') throw new Error('HEX must be text.');
    const compact = hex.replace(/\s/g, '').replace(/^0x/i, '');
    if (compact.length % 2 || /[^0-9a-f]/i.test(compact)) throw new Error('Enter complete hexadecimal byte pairs.');
    return Uint8Array.from(compact.match(/../g) || [], pair => parseInt(pair, 16));
  }
  const hex = data => Array.from(data, value => value.toString(16).padStart(2, '0')).join('');
  const ascii = data => Array.from(data, value => value >= 32 && value <= 126 ? String.fromCharCode(value) : '.').join('');
  const sensitive = (value, uuid = '') => {
    const hex = value.replace(/\s/g, '');
    return /^41505026534b26/i.test(hex) || (/^(?:0x)?2bb1$|^00002bb1-0000-1000-8000-00805f9b34fb$/i.test(uuid) && /^10fe[0-9a-f]{4}/i.test(hex));
  };
  function payload(value, format, response, mtu = 23) {
    const data = format === 'utf8' ? new TextEncoder().encode(value) : bytes(value);
    const maximum = response ? 512 : Math.min(512, Math.max(0, mtu - 3));
    if (!data.length) throw new Error('Enter at least one byte.');
    if (data.length > maximum) throw new Error(`This write permits ${maximum} bytes; input contains ${data.length}.`);
    return { hex: hex(data), length: data.length };
  }
  function decode(value, offset = 0) {
    const data = bytes(value);
    if (!Number.isInteger(offset) || offset < 0 || offset > data.length) throw new Error('Choose an offset within the packet.');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const number = (size, getter, little) => offset + size <= data.length ? view[getter](offset, little) : null;
    const rows = [];
    for (let start = 0; start < data.length; start += 16) {
      const part = data.slice(start, start + 16);
      rows.push({ offset: start, hex: Array.from(part, value => value.toString(16).padStart(2, '0')).join(' '), ascii: ascii(part) });
    }
    return { length: data.length, rows, uint16LE: number(2, 'getUint16', true), uint16BE: number(2, 'getUint16', false),
      uint32LE: number(4, 'getUint32', true), uint32BE: number(4, 'getUint32', false),
      float32LE: number(4, 'getFloat32', true), float32BE: number(4, 'getFloat32', false) };
  }
  const direction = kind => kind === 'write' || kind === 'write-result' ? 'TX' : ['read', 'notification', 'indication'].includes(kind) ? 'RX' : 'EVENT';
  const isRx = event => !event.request && (event.protocolDirection || direction(event.kind)) === 'RX' && event.success !== false;
  function redact(event) {
    const dexcomAuthWrite = (event.protocolDirection || direction(event.kind)) === 'TX' && /^f808353[58]-849e-531c-c594-30f1f86a4ea5$/i.test(event.uuid || '');
    return sensitive(event.hex || '', event.uuid) || dexcomAuthWrite ? { ...event, hex: '', message: 'Authentication payload redacted', redacted: true } : { ...event };
  }
  function createCapture(limit = 10000) {
    let events = [], bootId = null, nextSeq = 0;
    const stats = { received: 0, gaps: 0, boardDropped: 0, browserDropped: 0, truncated: 0, reboots: 0 };
    function ingest(batch) {
      const reboot = bootId !== null && bootId !== batch.bootId;
      if (reboot) { stats.reboots++; nextSeq = 0; }
      bootId = batch.bootId;
      const dropped = Math.max(0, Number(batch.dropped) || 0);
      stats.boardDropped += dropped;
      const fresh = [], sources = [...(batch.events || [])].sort((a, b) => a.seq - b.seq);
      // The request cursor came from the previous boot, so retained events below it were skipped; refetch from zero.
      if (reboot && sources.length && sources[0].seq > Math.max(1, Number(batch.oldestSeq) || 1)) sources.length = 0;
      for (const source of sources) {
        if (!Number.isInteger(source.seq) || source.seq <= nextSeq) continue;
        stats.gaps += Math.max(0, source.seq - nextSeq - 1);
        nextSeq = source.seq;
        const event = { ...redact(source), bootId };
        if (event.truncated) stats.truncated++;
        fresh.push(event);
      }
      if (!batch.events?.length && Number(batch.oldestSeq) > nextSeq + 1) {
        stats.gaps += batch.oldestSeq - nextSeq - 1;
        nextSeq = batch.oldestSeq - 1;
      }
      stats.received += fresh.length; events.push(...fresh);
      if (events.length > limit) { const count = events.length - limit; events.splice(0, count); stats.browserDropped += count; }
      return { events: fresh, meta: { bootId, dropped, nextSeq: Number(batch.nextSeq) || nextSeq, cursor: nextSeq, gaps: stats.gaps, reboot, oldestSeq: batch.oldestSeq, browserDropped: stats.browserDropped, truncated: stats.truncated } };
    }
    function snapshot() { return { bootId, nextSeq, events, stats: { ...stats }, exportedAt: new Date().toISOString() }; }
    return { ingest, snapshot };
  }
  function filter(events, criteria = {}) {
    const query = (criteria.text || '').toLowerCase().trim();
    const handle = String(criteria.handle ?? '').trim();
    return events.filter(event => (!handle || event.handle === Number(handle)) && (!criteria.kind || event.kind === criteria.kind)
      && (!query || `${event.hex || ''} ${ascii(bytes(event.hex || ''))} ${event.address || ''} ${event.uuid || ''} ${event.message || ''}`.toLowerCase().includes(query)));
  }
  function csv(capture) {
    const fields = ['bootId', 'seq', 'ms', 'direction', 'kind', 'address', 'uuid', 'handle', 'hex', 'ascii', 'length', 'success', 'truncated', 'message', 'captureGaps', 'browserDropped'];
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = capture.events.map(event => ({ ...event, direction: event.protocolDirection || direction(event.kind), ascii: ascii(bytes(event.hex || '')), captureGaps: capture.stats.gaps, browserDropped: capture.stats.browserDropped }));
    return [fields.join(','), ...rows.map(row => fields.map(field => quote(row[field])).join(','))].join('\r\n');
  }
  function rxBinary(capture, stream) {
    const packets = capture.events.filter(event => isRx(event) && event.handle === stream.handle && event.address === stream.address && event.bootId === stream.bootId);
    const chunks = packets.map(event => bytes(event.hex || ''));
    const data = new Uint8Array(chunks.reduce((sum, item) => sum + item.length, 0));
    let position = 0;
    for (const chunk of chunks) { data.set(chunk, position); position += chunk.length; }
    const incomplete = capture.stats.gaps > 0 || capture.stats.browserDropped > 0 || packets.some(event => event.truncated || event.redacted || (event.length ?? bytes(event.hex || '').length) > bytes(event.hex || '').length);
    return { data, packets: packets.length, incomplete, verified: false };
  }
  return { bytes, hex, ascii, sensitive, payload, decode, direction, isRx, createCapture, filter, csv, rxBinary };
})();
if (typeof module !== 'undefined') module.exports = NanoPackets;
