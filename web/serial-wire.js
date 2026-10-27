'use strict';

var NanoSerialWire = (() => {
  const codec = typeof module !== 'undefined' ? require('./serial-codec.js') : NanoSerialCodec;
  const aborted = () => new DOMException('USB request canceled.', 'AbortError');

  function create(port, options = {}) {
    const timers = options.timers || globalThis;
    const reader = port.readable.getReader(), writer = port.writable.getWriter();
    const queue = [];
    let current, stopped = false, cleanup, nextId = options.initialId || 1;
    let synchronized = !options.synchronize;

    function settle(item, error, response) {
      if (item.settled) return;
      item.settled = true;
      item.signal?.removeEventListener('abort', item.abort);
      if (error) item.reject(error); else item.resolve(response);
    }

    function close(error = new Error('USB connection closed.')) {
      if (cleanup) return cleanup;
      stopped = true;
      if (current) { timers.clearTimeout(current.timer); settle(current, error); }
      for (const item of queue.splice(0)) settle(item, error);
      cleanup = (async () => {
        await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
        try { reader.releaseLock(); } catch {}
        try { writer.releaseLock(); } catch {}
        try { await port.close(); } catch {}
      })();
      options.onClose?.(error);
      return cleanup;
    }

    // The timeout measures silence, so large responses keep the request alive while frames arrive.
    function arm(item) {
      timers.clearTimeout(item.timer);
      item.timer = timers.setTimeout(() => close(new Error('USB board response timed out. Switch the board to workbench mode with a triple press, or update its firmware.')), item.timeout);
    }

    function pump() {
      if (stopped || current || !queue.length) return;
      const item = current = queue.shift();
      arm(item);
      const bytes = synchronized ? item.bytes : Uint8Array.of(10, ...item.bytes);
      writer.write(bytes).catch(error => close(error));
    }

    function onFrame(frame) {
      if (!synchronized && (frame?.id !== current?.id || frame?.event !== 'start')) return;
      if (!frame || frame.v !== 1 || !Number.isInteger(frame.id) || frame.id <= 0 || frame.id > 0xffffffff) throw new Error('Invalid USB response frame.');
      if (!current || frame.id !== current.id) throw new Error('Unexpected USB response ID.');
      const item = current;
      if (frame.event === 'start') {
        if (item.start || !Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599 || typeof frame.type !== 'string') throw new Error('Invalid USB response start.');
        synchronized = true; arm(item);
        item.start = frame;
        item.headers = new Headers(frame.headers || {});
        if (frame.type) item.headers.set('Content-Type', frame.type);
      } else if (frame.event === 'data') {
        if (!item.start) throw new Error('USB response data arrived before its headers.');
        arm(item);
        const bytes = codec.decode(frame.data);
        item.size += bytes.length;
        if (item.size > codec.limits.response) throw new Error('USB response exceeds 2 MiB.');
        if (!item.settled) item.parts.push(bytes);
      } else if (frame.event === 'end') {
        if (!item.start || typeof frame.ok !== 'boolean') throw new Error('Invalid USB response end.');
        timers.clearTimeout(item.timer);
        if (!frame.ok) throw new Error(frame.error || 'USB board request failed.');
        if (!item.settled) {
          const bytes = new Uint8Array(item.size);
          let offset = 0;
          for (const part of item.parts) { bytes.set(part, offset); offset += part.length; }
          const body = [204, 205, 304].includes(item.start.status) ? null : bytes;
          settle(item, null, new Response(body, { status: item.start.status, headers: item.headers }));
        }
        current = null;
        pump();
      } else throw new Error('Unknown USB response frame.');
    }

    const parse = codec.parser(onFrame, { ignoreMalformed: () => !synchronized });
    (async () => {
      try {
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) { if (!stopped) await close(new Error('USB board disconnected. Reconnect USB to continue.')); break; }
          parse(value);
        }
      } catch (error) { await close(error); }
    })();

    function fetch(path, requestOptions = {}, priority = false) {
      return new Promise((resolve, reject) => {
        if (stopped) return reject(new Error('USB is disconnected. Connect USB to continue.'));
        if (requestOptions.signal?.aborted) return reject(aborted());
        if (queue.length >= (options.queueLimit || 16)) return reject(new Error('USB request queue is full.'));
        const id = nextId++;
        if (nextId > 0xffffffff) nextId = 1;
        const bytes = codec.request(id, path, requestOptions);
        const item = { id, bytes, resolve, reject, signal: requestOptions.signal, timeout: requestOptions.timeout || options.timeout || 15000, parts: [], size: 0 };
        item.abort = () => {
          const index = queue.indexOf(item);
          if (index !== -1) queue.splice(index, 1);
          item.parts = [];
          settle(item, aborted());
        };
        item.signal?.addEventListener('abort', item.abort, { once: true });
        if (priority) queue.unshift(item); else queue.push(item);
        pump();
      });
    }

    function rejectQueued() {
      for (const item of queue.splice(0)) settle(item, new Error('USB connection is closing.'));
    }

    return { fetch, close, rejectQueued };
  }

  return { create };
})();
if (typeof module !== 'undefined') module.exports = NanoSerialWire;
