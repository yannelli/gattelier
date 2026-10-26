'use strict';

const NanoAnalysis = (() => {
  function bytes(hex) {
    if (typeof hex !== 'string' || hex.length > 8192 || !/^(?:[\da-f]{2})*$/i.test(hex)) throw new Error('Expected complete HEX bytes, up to 4096 bytes.');
    return (hex.match(/../g) || []).map(value => parseInt(value, 16));
  }
  function delta(before, after) {
    const a = bytes(before), b = bytes(after), changes = [];
    const display = value => value === undefined ? '—' : value.toString(16).padStart(2, '0');
    for (let offset = 0; offset < Math.max(a.length, b.length); offset++) if (a[offset] !== b[offset]) changes.push({ offset, before: display(a[offset]), after: display(b[offset]), mask: a[offset] === undefined || b[offset] === undefined ? null : display(a[offset] ^ b[offset]) });
    return changes;
  }
  function previous(events, current) {
    const rx = event => ['notification', 'indication', 'read'].includes(event.kind);
    return events.filter(event => event.seq < current.seq && event.bootId === current.bootId && event.address === current.address && event.handle === current.handle && rx(event) === rx(current) && event.hex && !event.redacted && !event.truncated).at(-1) || null;
  }
  function filter(events, direction, uuid) {
    const needle = String(uuid || '').toLowerCase().replace(/^0x/, '');
    return events.filter(event => (!direction || (event.protocolDirection || (['notification', 'indication', 'read'].includes(event.kind) ? 'RX' : event.kind.startsWith('write') ? 'TX' : 'EVENT')) === direction) && (!needle || String(event.uuid || '').toLowerCase().includes(needle)));
  }
  return { delta, previous, filter };
})();
if (typeof module !== 'undefined') module.exports = NanoAnalysis;
