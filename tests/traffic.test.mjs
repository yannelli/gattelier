import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url), packets = require('../web/packets.js'), pklg = require('../web/pklg.js'), btsnoop = require('../web/btsnoop.js');
function btsnoopCapture({ drops = 0, count = 1, linktype = 1002 } = {}) {
  const header = Buffer.alloc(16); header.write('btsnoop\0'); header.writeUInt32BE(1, 8); header.writeUInt32BE(linktype, 12);
  const payload = Buffer.from([2, 5, 0x20, 8, 0, 4, 0, 4, 0, 0x1b, 8, 0, 0xaa]);
  const records = Array.from({ length: count }, (_, index) => {
    const record = Buffer.alloc(24); record.writeUInt32BE(payload.length, 0); record.writeUInt32BE(payload.length, 4); record.writeUInt32BE(1, 8); record.writeUInt32BE(drops, 12); record.writeBigInt64BE(0x00dcddb30f2f8000n + 1700000000123456n + BigInt(index), 16);
    return Buffer.concat([record, payload]);
  });
  return Buffer.concat([header, ...records]);
}
function pklgCapture() {
  const payload = Buffer.from([5, 0x20, 8, 0, 4, 0, 4, 0, 0x1b, 8, 0, 0xbb]), header = Buffer.alloc(13);
  header.writeUInt32BE(payload.length + 9, 0); header.writeUInt32BE(100, 4); header[12] = 3;
  return Buffer.concat([header, payload]);
}
function harness() {
  const ids = new Map(), downloads = []; let calls = 0;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.text = ''; this.classList = { add() {}, toggle() {} }; }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const node = new Element(match[1]); node.hidden = /\bhidden\b/.test(match[0]); node.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || '';
        ids.set(match[2], node); this.children.push(node);
      }
    }
    get innerHTML() { return this.html; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { for (const node of nodes) this.children.push(...(node.tag === 'fragment' ? node.children : [node])); }
    replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    before() {}
    closest() { return null; }
    contains(value) { return Boolean(value && (this === value || this.children.some(child => child.contains(value)))); }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    click() { return this.listeners.click?.(); }
  }
  const forbidden = () => { calls++; throw new Error('Network or device access is forbidden'); };
  const context = { Blob, NanoPackets: packets, NanoPKLG: pklg, NanoBTSnoop: btsnoop, NanoAnalysis: { filter: events => events, previous: () => null }, NanoGattValues: { decode: () => [] }, NanoRecorders: { decode: () => null },
    fetch: forbidden, NanoConnection: { ensure: forbidden }, NanoLab: { action: forbidden }, URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:synthetic'; }, revokeObjectURL() {} }, setTimeout: callback => { callback(); return 1; },
    document: { createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'), getElementById: id => ids.get(id), activeElement: null } };
  vm.runInNewContext(readFileSync(new URL('../web/traffic.js', import.meta.url), 'utf8') + '\nthis.traffic = NanoTraffic;', context);
  const live = packets.createCapture(); context.traffic.mount(new Element('section'), live.snapshot);
  const get = id => ids.get('traffic-' + id);
  return { get, downloads, calls: () => calls, async import(data, name = 'synthetic.log', size = data.length) {
    get('import').files = [{ name, size, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) }];
    await get('import').listeners.change();
  }, async exported() { get('json').click(); return JSON.parse(await downloads.at(-1).text()); } };
}

test('import detects binary format by content, retains loss metadata and resumes the paused view', async () => {
  const h = harness(); h.get('pause').click(); h.get('handle').value = '999'; h.get('search').value = 'hidden';
  await h.import(btsnoopCapture({ drops: 3 }), 'synthetic.p retention');
  assert.equal(h.get('pause').textContent, 'Pause view'); assert.equal(h.get('pause').attributes['aria-pressed'], 'false');
  assert.equal(h.get('handle').value, ''); assert.equal(h.get('search').value, ''); assert.equal(h.get('rows').children.length, 1);
  assert.match(h.get('summary').textContent, /3 controller packets dropped/); assert.doesNotMatch(h.get('summary').textContent, /board overwrites/);
  assert.match(h.get('summary').textContent, /completeness incomplete/); assert.match(h.get('export-status').textContent, /btsnoop/);
  const result = await h.exported();
  assert.equal(result.format, 'btsnoop'); assert.equal(result.metadata.cumulativeDrops, 3); assert.equal(result.stats.controllerDropped, 3); assert.equal(result.stats.boardDropped, 0);
  assert.equal(result.events[0].timestampMicros, '1700000000123456'); assert.equal(result.events[0].elapsedMicros, '0'); assert.equal(result.counts.records, 1); assert.equal(h.calls(), 0);
});

test('PacketLogger content imports with a .log name and completeness remains unverified', async () => {
  const h = harness(); await h.import(pklgCapture());
  assert.equal(h.get('rows').children.length, 1); assert.match(h.get('export-status').textContent, /PacketLogger/);
  const result = await h.exported(); assert.equal(result.format, 'pklg'); assert.equal(result.metadata.byteOrder, 'big'); assert.equal(result.completeness, 'unverified'); assert.equal(result.events[0].hex, 'bb');
  h.get('live').click(); assert.equal(h.get('rows').children.length, 0); assert.equal(h.get('live').hidden, true);
});

test('arbitrary logs, unsupported btsnoop formats and oversized files do not replace the trace', async () => {
  const h = harness(); await h.import(pklgCapture());
  await h.import(Buffer.from('ordinary application log text'), 'application.log'); assert.match(h.get('export-status').textContent, /Unrecognized capture/);
  assert.equal(h.get('rows').children.length, 1);
  await h.import(btsnoopCapture({ linktype: 2001 }), 'unsupported.cfa'); assert.match(h.get('export-status').textContent, /Unsupported btsnoop linktype/);
  await h.import(Buffer.of(0), 'huge.log', 32 * 1024 * 1024 + 1); assert.match(h.get('export-status').textContent, /32 MB/);
  assert.equal(h.get('import').value, ''); assert.equal(h.calls(), 0);
});

test('import retains the latest 10000 events and exports original parser counts', async () => {
  const h = harness(); await h.import(btsnoopCapture({ count: 10001 }), 'synthetic.btsnoop');
  const result = await h.exported();
  assert.equal(result.events.length, 10000); assert.equal(result.events[0].seq, 2); assert.equal(result.counts.records, 10001); assert.equal(result.counts.events, 10001);
  assert.equal(result.stats.browserDropped, 1); assert.equal(result.completeness, 'incomplete'); assert.equal(result.events[0].elapsedMicros, '1'); assert.equal(h.calls(), 0);
});

function delayedImport(h, name = 'slow.btsnoop') {
  let resolve, reject;
  const data = new Promise((yes, no) => { resolve = yes; reject = no; });
  h.get('import').files = [{ name, size: 100, arrayBuffer: () => data }];
  const pending = h.get('import').listeners.change();
  return { pending, resolve: buffer => resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length)), reject };
}

test('the last selected import owns the trace when file reads finish out of order', async () => {
  const h = harness(), first = delayedImport(h);
  await h.import(pklgCapture(), 'latest.pklg');
  first.resolve(btsnoopCapture()); await first.pending;
  assert.match(h.get('export-status').textContent, /latest.pklg/);
  const result = await h.exported();
  assert.equal(result.format, 'pklg'); assert.equal(result.source, 'latest.pklg');
});

test('returning to live capture cancels pending imported file results and errors', async () => {
  for (const fails of [false, true]) {
    const h = harness(); await h.import(pklgCapture());
    const delayed = delayedImport(h);
    h.get('live').click();
    if (fails) delayed.reject(new Error('Old file failed')); else delayed.resolve(btsnoopCapture());
    await delayed.pending;
    assert.equal(h.get('live').hidden, true); assert.equal(h.get('rows').children.length, 0);
    assert.equal((await h.exported()).format, undefined);
    assert.doesNotMatch(h.get('export-status').textContent, /Old file failed|slow.btsnoop/);
  }
});

test('clearing the selected imported packet resets its inspector heading', async () => {
  const h = harness(); await h.import(pklgCapture());
  h.get('rows').children[0].children[0].children[0].click();
  assert.match(h.get('selected').textContent, /^Packet 1/);
  h.get('live').click();
  assert.equal(h.get('selected').textContent, 'Packet inspector');
  assert.equal(h.get('decoder').textContent, 'No packet selected');
});

test('fractional byte offsets normalize before decoding a selected packet', async () => {
  const h = harness(); await h.import(pklgCapture());
  h.get('rows').children[0].children[0].children[0].click();
  h.get('offset').value = '0.5';
  assert.doesNotThrow(() => h.get('offset').listeners.input());
  assert.equal(Number(h.get('offset').value), 0);
  assert.ok(h.get('decoder').children.length > 0);
});
