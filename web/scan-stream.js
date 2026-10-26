'use strict';

const NanoScanStream = (() => {
  function create(store, options = {}) {
    const fetcher = options.fetch || ((...args) => NanoAPI.fetch(...args)), now = options.now || Date.now;
    let bootId = null, cursor = 0, generation = 0, controller = null, pending = null, supported = null, failure = '';
    function status() { return { supported, pending: pending !== null, bootId, cursor, error: failure }; }
    async function request(after, token) {
      const current = controller = new AbortController();
      const timer = setTimeout(() => current.abort(), options.timeoutMs ?? 8000);
      try {
        const response = await fetcher(`advertisements?after=${after}${bootId ? `&bootId=${encodeURIComponent(bootId)}` : ''}`, { signal: current.signal });
        if (token !== generation) return null;
        if (response.status === 404) { supported = false; failure = ''; return null; }
        if (!response.ok) throw new Error(`Advertisement stream request failed (${response.status}).`);
        const batch = await response.json();
        if (token !== generation) return null;
        supported = true; return batch;
      } finally { clearTimeout(timer); if (controller === current) controller = null; }
    }
    function poll() {
      if (pending) return pending;
      if (supported === false) return Promise.resolve(status());
      const token = generation;
      const operation = (async () => {
        try {
          let batch = await request(cursor, token);
          if (!batch || token !== generation) return status();
          if (bootId !== null && batch.bootId !== bootId && cursor > 0) batch = await request(0, token);
          if (!batch || token !== generation) return status();
          const result = store.ingestAdvertisements(batch, now()); bootId = batch.bootId; cursor = result.cursor; failure = '';
          options.onBatch?.(result, batch); return status();
        } catch (error) {
          if (token !== generation) return status();
          failure = error.name === 'AbortError' ? 'Advertisement stream request timed out.' : error.message;
          store.streamError?.(failure); options.onError?.(failure); return status();
        }
      })();
      pending = operation;
      operation.finally(() => { if (pending === operation) pending = null; });
      return operation;
    }
    function reset() { generation++; controller?.abort(); controller = null; pending = null; bootId = null; cursor = 0; supported = null; failure = ''; store.resetStream?.(); }
    return { poll, reset, status, destroy: reset };
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = NanoScanStream;
