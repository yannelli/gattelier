'use strict';
const PocketProtocol = (() => {
  const uuid = part => `001120${part}-2233-4455-6677-889912345678`;
  const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
  const encode = text => Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, '0')).join('');
  function bytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('Invalid packet hex');
    return Uint8Array.from(hex.match(/../g) || [], pair => parseInt(pair, 16));
  }
  function handles(state) {
    const service = state.services?.find(item => item.uuid.toLowerCase() === uuid('a0'));
    const find = suffix => service?.characteristics.find(item => item.uuid.toLowerCase() === uuid(suffix))?.handle;
    return { command: find('a2'), response: find('a3'), audio: find('a1') };
  }
  function messages(hex) {
    return new TextDecoder().decode(bytes(hex)).replace(/\0/g, '').split(/(?=MCU&)/).map(text => text.trim()).filter(text => text.startsWith('MCU&'));
  }
  function listing(messages) {
    const files = []; let count = null, malformed = false;
    for (const message of messages) {
      const parts = message.split('&');
      if (parts[1] === 'LIST') count = /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
      if (parts[1] !== 'F') continue;
      if (parts.length !== 5 || !safeId(parts[2]) || !safeId(parts[3]) || !/^\d+$/.test(parts[4])) { malformed = true; continue; }
      files.push({ date: parts[2], name: parts[3], seconds: Number(parts[4]) });
    }
    return { files, complete: count !== null && count === files.length && !malformed };
  }
  class Transfer {
    constructor() { this.chunks = []; this.received = 0; this.expected = null; this.lost = 0; this.error = ''; }
    announce(value) {
      if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid recording byte count');
      this.expected = Number(value);
    }
    append(hex, truncated = false) {
      const chunk = bytes(hex); this.chunks.push(chunk); this.received += chunk.length;
      if (truncated) this.lost++;
      if (this.expected !== null && this.received > this.expected) this.error = 'Received more bytes than Pocket announced.';
    }
    get complete() { return this.expected !== null && this.received === this.expected && this.lost === 0 && !this.error; }
  }
  return { uuid, safeId, encode, bytes, handles, messages, listing, Transfer };
})();
if (typeof module !== 'undefined') module.exports = PocketProtocol;
