'use strict';

const NanoPKLG = (() => {
  const u16 = (data, offset) => data[offset] | (data[offset + 1] << 8);
  const hex = data => Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
  function uuid(data) {
    if (data.length === 2) return `0x${u16(data, 0).toString(16).padStart(4, '0')}`;
    const value = hex(Uint8Array.from(data).reverse());
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
  function parseRecords(records, options = {}) {
    const events = [], errors = [], warnings = [], pocketKeys = new Set(), fragments = new Map(), requests = new Map();
    const sessions = new Map(), sessionNumbers = new Map();
    const counts = { records: 0, aclPackets: 0, l2capPackets: 0, attPackets: 0, events: 0, ignoredRecords: 0, incompletePackets: 0, malformedPackets: 0, redacted: 0, pocketKeys: 0, sessions: 0, uuidMappedEvents: 0 };
    let diagnosticsOmitted = 0;
    function diagnostic(target, message) {
      if (errors.length + warnings.length < (options.diagnosticLimit ?? Infinity)) target.push(message);
      else diagnosticsOmitted++;
    }
    const warn = message => diagnostic(warnings, message);
    function resetState() { fragments.clear(); requests.clear(); sessions.clear(); }
    function error(message) { counts.malformedPackets++; diagnostic(errors, message); if (options.invalidateOnError) resetState(); }
    function incomplete(message) { counts.incompletePackets++; warn(message); if (options.invalidateOnError) resetState(); }
    function session(connection) {
      if (!sessions.has(connection)) {
        const number = (sessionNumbers.get(connection) || 0) + 1;
        sessionNumbers.set(connection, number); sessions.set(connection, { number, attributes: new Map() }); counts.sessions++;
      }
      return sessions.get(connection);
    }
    function clearConnection(connection, record) {
      for (const direction of ['TX', 'RX']) {
        const key = `${connection}:${direction}`;
        if (fragments.delete(key)) incomplete(`Unfinished ACL packet cleared at connection boundary, record ${record}.`);
        requests.delete(key);
      }
      sessions.delete(connection);
    }
    function hciEvent(payload, record) {
      if (payload.length < 2) return;
      if (payload[0] === 0x05 && payload.length >= 6 && payload[2] === 0) clearConnection(u16(payload, 3) & 0x0fff, record);
      let connection = null;
      if (payload[0] === 0x03 && payload.length >= 5 && payload[2] === 0) connection = u16(payload, 3) & 0x0fff;
      if (payload[0] === 0x3e && payload.length >= 6 && [0x01, 0x0a].includes(payload[2]) && payload[3] === 0) connection = u16(payload, 4) & 0x0fff;
      if (connection !== null) { clearConnection(connection, record); session(connection); }
    }
    function emit(meta, kind, handle, payload, message, extra = {}) {
      const text = new TextDecoder().decode(payload);
      const state = session(meta.connection), characteristic = state.attributes.get(handle) || '';
      const dexcomAuthWrite = meta.direction === 'TX' && /^f808353[58]-849e-531c-c594-30f1f86a4ea5$/i.test(characteristic);
      const redacted = dexcomAuthWrite || text.includes('APP&SK&') || ((characteristic === '0x2bb1' || characteristic === '00002bb1-0000-1000-8000-00805f9b34fb') && payload.length >= 4 && payload[0] === 0x10 && payload[1] === 0xfe);
      if (redacted) {
        const match = /^APP&SK&([A-Za-z0-9]{16})[\0\r\n]*$/.exec(text);
        if (match) pocketKeys.add(match[1]);
        counts.redacted++;
      }
      events.push({ seq: events.length + 1, ms: meta.ms, kind, handle, uuid: state.attributes.get(handle) || '', hex: redacted ? '' : hex(payload), length: payload.length,
        success: true, source: options.source || 'PacketLogger', connection: meta.connection, protocolDirection: meta.direction,
        session: state.number, address: `HCI 0x${meta.connection.toString(16).padStart(4, '0')} / session ${state.number}`,
        ...(options.preciseTime ? { timestampMicros: meta.timestampMicros.toString(), elapsedMicros: (meta.timestampMicros - firstTime).toString() } : {}),
        message: redacted ? 'Authentication payload redacted' : message, ...extra, ...(redacted ? { redacted: true } : {}) });
    }
    function att(packet, meta) {
      counts.attPackets++;
      if (!packet.length) { error(`Empty ATT packet at record ${meta.record}.`); return; }
      const opcode = packet[0], requestKey = `${meta.connection}:${meta.direction}`;
      const responseKey = `${meta.connection}:${meta.direction === 'TX' ? 'RX' : 'TX'}`;
      const prior = requests.get(responseKey);
      const minimum = { 1: 5, 5: 2, 8: 7, 9: 2, 10: 3, 11: 1, 12: 5, 13: 1, 18: 3, 19: 1, 22: 5, 23: 5, 27: 3, 29: 3, 82: 3 }[opcode];
      if (minimum && packet.length < minimum) { error(`Truncated ATT opcode 0x${opcode.toString(16)} at record ${meta.record}.`); return; }
      if (opcode === 0x08) {
        if (![7, 21].includes(packet.length)) { error(`Invalid ATT Read By Type request at record ${meta.record}.`); return; }
        requests.set(requestKey, { opcode, uuid: uuid(packet.subarray(5)) });
      } else if (opcode === 0x09) {
        requests.delete(responseKey);
        if (prior?.opcode !== 0x08 || prior.uuid !== '0x2803') return;
        const size = packet[1];
        if (![7, 21].includes(size) || packet.length < size + 2 || (packet.length - 2) % size) { error(`Invalid characteristic declaration response at record ${meta.record}.`); return; }
        const attributes = session(meta.connection).attributes;
        for (let start = 2; start < packet.length; start += size) {
          attributes.set(u16(packet, start), '0x2803');
          attributes.set(u16(packet, start + 3), uuid(packet.subarray(start + 5, start + size)));
        }
      } else if (opcode === 0x04 && options.requireDiscoveryRequest) {
        if (packet.length !== 5) { error(`Invalid ATT Find Information request at record ${meta.record}.`); return; }
        requests.set(requestKey, { opcode });
      } else if (opcode === 0x05) {
        if (options.requireDiscoveryRequest) {
          requests.delete(responseKey);
          if (prior?.opcode !== 0x04) { warn(`Unmatched ATT Find Information response at record ${meta.record}.`); return; }
        }
        const size = packet[1] === 1 ? 4 : packet[1] === 2 ? 18 : 0;
        if (!size || packet.length < size + 2 || (packet.length - 2) % size) { error(`Invalid Find Information response at record ${meta.record}.`); return; }
        const attributes = session(meta.connection).attributes;
        for (let start = 2; start < packet.length; start += size) attributes.set(u16(packet, start), uuid(packet.subarray(start + 2, start + size)));
      } else if (opcode === 0x0a || opcode === 0x0c) {
        const handle = u16(packet, 1), valueOffset = opcode === 0x0c ? u16(packet, 3) : 0;
        requests.set(requestKey, { opcode, handle, valueOffset });
        emit(meta, 'read', handle, new Uint8Array(), opcode === 0x0c ? 'ATT read-blob request' : 'ATT read request', { request: true, valueOffset });
      } else if (opcode === 0x0b || opcode === 0x0d) {
        if (!prior || prior.opcode !== opcode - 1) { warn(`Unmatched ATT read response at record ${meta.record}.`); return; }
        requests.delete(responseKey);
        emit(meta, 'read', prior.handle, packet.subarray(1), opcode === 0x0d ? 'ATT read-blob response' : 'ATT read response', { valueOffset: prior.valueOffset });
      } else if (opcode === 0x12 || opcode === 0x52 || opcode === 0x16) {
        const handle = u16(packet, 1), prepared = opcode === 0x16;
        if (opcode !== 0x52) requests.set(requestKey, { opcode, handle });
        emit(meta, 'write', handle, packet.subarray(prepared ? 5 : 3), prepared ? 'ATT prepare write; queued' : opcode === 0x52 ? 'ATT write command; no response' : 'ATT write request; awaiting response',
          { response: opcode !== 0x52, ...(prepared ? { prepared: true, valueOffset: u16(packet, 3) } : {}) });
      } else if (opcode === 0x13) {
        if (!prior || prior.opcode !== 0x12) { warn(`Unmatched ATT write response at record ${meta.record}.`); return; }
        requests.delete(responseKey); emit(meta, 'write-result', prior.handle, new Uint8Array(), 'ATT write accepted');
      } else if (opcode === 0x17) {
        requests.delete(responseKey);
        emit(meta, 'write-result', u16(packet, 1), packet.subarray(5), 'ATT prepare-write response', { prepared: true, valueOffset: u16(packet, 3) });
      } else if (opcode === 0x1b || opcode === 0x1d) {
        emit(meta, opcode === 0x1b ? 'notification' : 'indication', u16(packet, 1), packet.subarray(3), opcode === 0x1b ? 'ATT notification' : 'ATT indication');
      } else if (opcode === 0x01) {
        requests.delete(responseKey);
        emit(meta, 'error', u16(packet, 2), new Uint8Array(), `ATT error 0x${packet[4].toString(16).padStart(2, '0')} for opcode 0x${packet[1].toString(16).padStart(2, '0')}`, { success: false });
      } else if ([0x02, 0x04, 0x06, 0x08, 0x0e, 0x10, 0x18, 0x20].includes(opcode)) requests.delete(requestKey);
    }
    function append(fragment, payload, key) {
      fragment.chunks.push(payload); fragment.size += payload.length;
      if (fragment.expected === null && fragment.size >= 4) {
        const header = new Uint8Array(4); let position = 0;
        for (const chunk of fragment.chunks) for (const byte of chunk) { if (position < 4) header[position++] = byte; }
        fragment.expected = u16(header, 0) + 4; fragment.cid = u16(header, 2);
      }
      if (fragment.expected === null || fragment.size < fragment.expected) return;
      fragments.delete(key);
      if (fragment.size > fragment.expected) { error(`L2CAP length mismatch at record ${fragment.meta.record}.`); return; }
      counts.l2capPackets++;
      if (fragment.cid !== 0x0004) return;
      const packet = new Uint8Array(fragment.size); let position = 0;
      for (const chunk of fragment.chunks) { packet.set(chunk, position); position += chunk.length; }
      att(packet.subarray(4), fragment.meta);
    }
    function acl(payload, meta) {
      counts.aclPackets++;
      if (payload.length < 4) { error(`Truncated ACL header at record ${meta.record}.`); return; }
      const flags = u16(payload, 0), length = u16(payload, 2), boundary = (flags >> 12) & 3;
      meta.connection = flags & 0x0fff;
      session(meta.connection);
      const key = `${meta.connection}:${meta.direction}`;
      if (length !== payload.length - 4) {
        error(`ACL length mismatch at record ${meta.record}.`);
        if (fragments.delete(key)) incomplete(`ACL reassembly interrupted at record ${meta.record}.`);
        return;
      }
      let fragment = fragments.get(key);
      if (boundary === 1) {
        if (!fragment) { incomplete(`ACL continuation without a start at record ${meta.record}.`); return; }
      } else {
        if (fragment) incomplete(`Unfinished ACL packet replaced at record ${meta.record}.`);
        fragment = { chunks: [], size: 0, expected: null, cid: null, meta };
        fragments.set(key, fragment);
      }
      append(fragment, payload.subarray(4), key);
    }
    let firstTime = null;
    for (const record of records) {
      if (record.count !== false) counts.records++;
      if (typeof record.timestampMicros === 'bigint' && firstTime === null) firstTime = record.timestampMicros;
      if (record.gap) { incomplete(record.gap); resetState(); }
      if (record.error) { error(record.error); continue; }
      if (!record.payload) continue;
      const time = record.timestampMicros;
      if (firstTime === null) firstTime = time;
      const meta = { ms: Number(time - firstTime) / 1000, timestampMicros: time, direction: record.direction, record: counts.records };
      if (record.type === 2 || record.type === 3) acl(record.payload, meta);
      else {
        counts.ignoredRecords++;
        if (record.type === 1) hciEvent(record.payload, counts.records);
        if (record.type === 0 && u16(record.payload, 0) === 0x0c03) {
          for (const connection of [...sessions.keys()]) clearConnection(connection, counts.records);
        }
      }
    }
    for (const fragment of [...fragments.values()]) incomplete(`Unfinished ACL packet from record ${fragment.meta.record} at end of capture.`);
    counts.events = events.length; counts.pocketKeys = pocketKeys.size; counts.uuidMappedEvents = events.filter(event => event.uuid).length;
    if (!counts.attPackets) warn('No ATT traffic found on L2CAP channel 0x0004.');
    if (!events.length && counts.attPackets) warn('No supported ATT read, write, notification, or indication events found.');
    if (diagnosticsOmitted) warnings.push(`${diagnosticsOmitted} additional capture diagnostics omitted.`);
    return { events, pocketKeys: [...pocketKeys], counts, errors, warnings,
      complete: counts.malformedPackets === 0 && counts.incompletePackets === 0, startedAt: firstTime === null ? null : new Date(Number(firstTime / 1000n - (firstTime < 0n && firstTime % 1000n ? 1n : 0n))).toISOString() };
  }
  function parse(input) {
    const data = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
    if (!data) throw new TypeError('Pass an ArrayBuffer or Uint8Array.');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    function score(little) {
      let offset = 0, records = 0;
      while (records < 16 && offset + 13 <= data.length) {
        const length = view.getUint32(offset, little), micros = view.getUint32(offset + 8, little);
        if (length < 9 || offset + 4 + length > data.length || micros >= 1000000) break;
        records++; offset += 4 + length;
      }
      return records * 2 + (offset === data.length && records ? 1 : 0);
    }
    const little = score(true) > score(false);
    function* records() {
      let offset = 0;
      while (offset < data.length) {
        if (data.length - offset < 13) { yield { count: false, error: `Truncated PacketLogger header at byte ${offset}.` }; break; }
        const length = view.getUint32(offset, little), seconds = view.getUint32(offset + 4, little), micros = view.getUint32(offset + 8, little);
        if (length < 9) { yield { count: false, error: `Invalid PacketLogger record length at byte ${offset}.` }; break; }
        if (offset + 4 + length > data.length) { yield { count: false, error: `Truncated PacketLogger record at byte ${offset}.` }; break; }
        if (micros >= 1000000) { yield { count: false, error: `Invalid PacketLogger timestamp at byte ${offset}.` }; break; }
        const type = data[offset + 12];
        yield { type, direction: type === 2 ? 'TX' : 'RX', payload: data.subarray(offset + 13, offset + 4 + length), timestampMicros: BigInt(seconds) * 1000000n + BigInt(micros) };
        offset += 4 + length;
      }
    }
    return { ...parseRecords(records(), { preciseTime: true }), byteOrder: little ? 'little' : 'big' };
  }
  function matches(input) {
    const data = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
    if (!data || data.length < 13) return false;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [false, true].some(little => {
      const length = view.getUint32(0, little);
      return length >= 9 && length + 4 <= data.length && view.getUint32(8, little) < 1000000 && (data[12] <= 3 || data[12] >= 0xf7);
    });
  }
  return { parse, parseRecords, matches };
})();
if (typeof module !== 'undefined') module.exports = NanoPKLG;
