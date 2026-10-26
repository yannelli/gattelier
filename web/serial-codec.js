'use strict';

var NanoSerialCodec = (() => {
  const encoder = new TextEncoder();
  const limits = { request: 4096, body: 1400, response: 2097152, line: 8192, chunk: 768 };

  function request(id, path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new Error('USB supports GET and POST board requests.');
    if (!/^\/api\/[a-zA-Z0-9_/-]+(?:\?[^\r\n]*)?$/.test(path) || path.length > 512) throw new Error('Invalid USB board API path.');
    const headers = new Headers(options.headers);
    for (const [name, value] of headers) {
      if (name !== 'content-type' || !/^application\/json(?:\s*;.*)?$/i.test(value)) throw new Error('USB requests support JSON content headers only.');
    }
    if (options.body != null && typeof options.body !== 'string') throw new Error('USB request bodies must be JSON strings.');
    if (encoder.encode(options.body || '').length > limits.body) throw new Error('USB request body exceeds 1400 bytes.');
    const frame = JSON.stringify({ v: 1, id, method, path, ...(options.body != null ? { body: options.body } : {}) });
    if (encoder.encode(frame).length > limits.request) throw new Error('USB request exceeds 4096 bytes.');
    return encoder.encode(`@G1 ${frame}\n`);
  }

  function decode(data) {
    if (typeof data !== 'string' || data.length > 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid USB response data.');
    const binary = atob(data);
    if (btoa(binary) !== data || binary.length > limits.chunk) throw new Error('Invalid USB response data.');
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }

  function parser(onFrame) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    return chunk => {
      pending += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (line.length > limits.line) throw new Error('USB response line exceeds its limit.');
        if (line.startsWith('@G1 ')) onFrame(JSON.parse(line.slice(4)));
      }
      if (pending.length > limits.line) throw new Error('USB response line exceeds its limit.');
    };
  }

  return { limits, request, decode, parser };
})();
if (typeof module !== 'undefined') module.exports = NanoSerialCodec;
