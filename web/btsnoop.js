'use strict';

const NanoBTSnoop = (() => {
  const sources = [
    { title: 'AOSP btsnoop writer, packet directions and epoch', url: 'https://android.googlesource.com/platform/system/bt/+/ebfeca0a62633b4951ff9588dfd4ab272b686239/hci/src/btsnoop.c' },
    { title: 'Wireshark btsnoop record and H1/H4 definitions', url: 'https://github.com/wireshark/wireshark/blob/a0752ed1f75e75ea252d34d7e02a02100205e387/wiretap/btsnoop.c' },
  ];
  const magic = [0x62, 0x74, 0x73, 0x6e, 0x6f, 0x6f, 0x70, 0], epoch = 0x00dcddb30f2f8000n;
  const maxRecordBytes = 65540, maxCaptureBytes = 268435456, maxRecords = 1000000;
  function dataBytes(input) {
    const data = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
    if (!data) throw new TypeError('Pass an ArrayBuffer or Uint8Array.');
    return data;
  }
  function matches(input) {
    const data = dataBytes(input);
    return data.length >= magic.length && magic.every((byte, index) => data[index] === byte);
  }
  function parse(input) {
    const data = dataBytes(input);
    if (!matches(data)) throw new Error('Expected an uncompressed btsnoop file. Compressed btsnooz summaries and bugreports require conversion with the AOSP btsnooz tool.');
    if (data.length < 16) throw new Error('Truncated btsnoop file header.');
    if (data.length > maxCaptureBytes) throw new Error('Btsnoop capture exceeds the 256 MiB import limit.');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength), version = view.getUint32(8), linktype = view.getUint32(12);
    if (version !== 1) throw new Error(`Unsupported btsnoop version ${version}; expected 1.`);
    if (![1001, 1002].includes(linktype)) throw new Error(`Unsupported btsnoop linktype ${linktype}; supported types are HCI unencapsulated 1001 and HCI UART 1002.`);
    const decoder = typeof NanoPKLG !== 'undefined' ? NanoPKLG : typeof require === 'function' ? require('./pklg.js') : null;
    if (!decoder?.parseRecords) throw new Error('Load the PacketLogger HCI decoder before importing btsnoop.');
    const metadata = { format: 'btsnoop', version, linktype, encapsulation: linktype === 1002 ? 'HCI UART (H4)' : 'HCI unencapsulated (H1)', timestampPrecision: 'microseconds', cumulativeDrops: 0, observedDrops: 0, dropCounterResets: 0, truncatedRecords: 0, timeRegressions: 0, firstTimestampMicros: null, lastTimestampMicros: null };
    function* records() {
      let offset = 16, lastTime = null, previousDrops = 0, record = 0;
      while (offset < data.length) {
        if (record >= maxRecords) { yield { count: false, gap: 'Btsnoop record limit reached.', error: 'Btsnoop capture exceeds the 1000000-record import limit.' }; break; }
        if (data.length - offset < 24) { yield { count: false, gap: 'Truncated btsnoop record header interrupts capture continuity.', error: `Truncated btsnoop record header at byte ${offset}.` }; break; }
        record++;
        const original = view.getUint32(offset), included = view.getUint32(offset + 4), flags = view.getUint32(offset + 8), drops = view.getUint32(offset + 12);
        const time = view.getBigInt64(offset + 16) - epoch, gaps = [];
        if (drops < previousDrops) { metadata.dropCounterResets++; gaps.push(`Cumulative drop counter decreased at record ${record}; controller continuity is unknown.`); }
        if (drops > previousDrops) { const difference = drops - previousDrops; metadata.observedDrops += difference; gaps.push(`${difference} dropped HCI packets reported at record ${record}; fragment, request and UUID session state cleared.`); }
        metadata.cumulativeDrops = drops; previousDrops = drops;
        if (original > maxRecordBytes || included > maxRecordBytes || included > original) { yield { gap: 'Invalid btsnoop record lengths interrupt capture continuity.', error: `Invalid btsnoop lengths ${original}/${included} at record ${record}.` }; break; }
        if (time < -8640000000000000000n || time > 8640000000000000000n) { yield { gap: 'Invalid capture timestamp interrupts session continuity.', error: `Btsnoop timestamp exceeds the supported Date range at record ${record}.` }; offset += 24 + included; continue; }
        if (lastTime !== null && time < lastTime) { metadata.timeRegressions++; gaps.push(`Timestamp regressed at record ${record}; session state cleared.`); }
        metadata.firstTimestampMicros ??= time.toString(); metadata.lastTimestampMicros = time.toString(); lastTime = time;
        if (offset + 24 + included > data.length) { metadata.truncatedRecords++; yield { timestampMicros: time, gap: 'Truncated btsnoop file interrupts capture continuity.', error: `Truncated btsnoop record ${record}.` }; break; }
        const captured = data.subarray(offset + 24, offset + 24 + included); offset += 24 + included;
        if (included < original) { metadata.truncatedRecords++; gaps.push(`Record ${record} captured ${included} of ${original} bytes; incomplete HCI packet was skipped.`); yield { timestampMicros: time, gap: gaps.join(' ') }; continue; }
        if (gaps.length) yield { count: false, gap: gaps.join(' ') };
        if (flags & ~3) { yield { timestampMicros: time, gap: 'Unsupported HCI direction flags interrupt continuity.', error: `Unsupported btsnoop flags ${flags} at record ${record}.` }; continue; }
        const direction = flags & 1 ? 'RX' : 'TX';
        const packetType = linktype === 1002 ? captured[0] : flags & 2 ? direction === 'RX' ? 4 : 1 : 2;
        const payload = linktype === 1002 ? captured.subarray(1) : captured;
        let expected = -1;
        if (packetType === 1 && payload.length >= 3) expected = 3 + payload[2];
        if (packetType === 2 && payload.length >= 4) expected = 4 + (payload[2] | payload[3] << 8);
        if (packetType === 3 && payload.length >= 3) expected = 3 + payload[2];
        if (packetType === 4 && payload.length >= 2) expected = 2 + payload[1];
        if (packetType === 5 && payload.length >= 4) expected = 4 + ((payload[2] | payload[3] << 8) & 0x3fff);
        if (expected !== payload.length || (packetType === 1 && direction !== 'TX') || (packetType === 4 && direction !== 'RX')) { yield { timestampMicros: time, gap: 'Malformed HCI record interrupts fragment and session continuity.', error: `Invalid HCI packet type, length or direction at record ${record}.` }; continue; }
        const type = packetType === 1 ? 0 : packetType === 4 ? 1 : packetType === 2 ? direction === 'TX' ? 2 : 3 : 255;
        yield { type, payload, direction, timestampMicros: time };
      }
    }
    return { ...decoder.parseRecords(records(), { source: 'btsnoop', preciseTime: true, invalidateOnError: true, requireDiscoveryRequest: true, diagnosticLimit: 200 }), format: 'btsnoop', metadata };
  }
  return { parse, matches, sources };
})();
if (typeof module !== 'undefined') module.exports = NanoBTSnoop;
