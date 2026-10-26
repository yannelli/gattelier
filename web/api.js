'use strict';

var NanoAPI = (() => {
  const STORAGE_KEY = 'nanoscope.apiOrigin';
  const API_PATH = /^\/?(?:api\/)?([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)(\?.*)?$/;
  let revision = 0;
  const active = new Set();

  function addressSpace(hostname) {
    const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)) return 'loopback';
    if (host.endsWith('.local') || /^(?:fc|fd)[\da-f]{2}:|^fe[89ab][\da-f]:/i.test(host)) return 'local';
    const parts = host.split('.').map(Number);
    if (parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
      if (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 169 && parts[1] === 254) return 'local';
    }
    return '';
  }

  function validateOrigin(value, page = globalThis.location) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter your board address or private HTTPS bridge.');
    let parsed;
    try { parsed = new URL(value.trim()); } catch { throw new Error('Enter a complete address such as http://nanoscope.local.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The board endpoint must use HTTP or HTTPS.');
    if (parsed.username || parsed.password) throw new Error('Remove the username and password from the board endpoint.');
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Enter an origin without a path, query, or fragment.');
    if (page?.protocol === 'https:' && parsed.protocol === 'http:' && !addressSpace(parsed.hostname)) throw new Error('For HTTP, use a local IP address or .local hostname. Public endpoints require HTTPS.');
    return parsed.origin;
  }

  function hostedBuild() {
    return Boolean(globalThis.document?.querySelector('meta[name="nanoscope-hosted"][content="true"]'));
  }

  function sameOriginDefault(page = globalThis.location, hosted = hostedBuild()) {
    if (hosted || !page?.origin || page.origin === 'null') return '';
    return page.origin;
  }

  function storedOrigin() {
    try {
      const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
      return saved ? validateOrigin(saved) : '';
    } catch { return ''; }
  }

  let endpoint = storedOrigin() || sameOriginDefault();

  function normalizePath(path) {
    const match = String(path).match(API_PATH);
    if (!match) throw new Error('Invalid board API path.');
    return `/api/${match[1]}${match[2] || ''}`;
  }

  function url(path) {
    if (!endpoint) throw new Error('Set the private board endpoint in Settings before using live tools.');
    return `${endpoint}${normalizePath(path)}`;
  }

  function changed() {
    revision++;
    for (const controller of active) controller.abort();
    active.clear();
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      globalThis.dispatchEvent(new CustomEvent('nanoscope:api-change', { detail: { origin: endpoint, revision } }));
    }
  }

  function setOrigin(value) {
    const next = validateOrigin(value);
    try { globalThis.localStorage?.setItem(STORAGE_KEY, next); } catch {}
    if (next !== endpoint) { endpoint = next; changed(); }
    return endpoint;
  }

  function clearOrigin() {
    try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch {}
    const next = sameOriginDefault();
    if (next !== endpoint) { endpoint = next; changed(); }
    return endpoint;
  }

  async function apiFetch(path, options = {}) {
    const requestRevision = revision;
    const controller = new AbortController();
    const suppliedSignal = options.signal;
    const abort = () => controller.abort();
    if (suppliedSignal?.aborted) abort();
    else suppliedSignal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    try {
      const target = new URL(url(path)), space = target.protocol === 'http:' ? addressSpace(target.hostname) : '';
      const response = await fetch(target.href, { ...options, ...(space ? { targetAddressSpace: space } : {}), credentials: 'omit', cache: options.cache || 'no-store', signal: controller.signal });
      const body = await response.arrayBuffer();
      if (requestRevision !== revision) throw new DOMException('Board endpoint changed.', 'AbortError');
      const responseBody = [204, 205, 304].includes(response.status) ? null : body;
      return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      active.delete(controller);
      suppliedSignal?.removeEventListener('abort', abort);
    }
  }

  return { fetch: apiFetch, url, origin: () => endpoint, configured: () => Boolean(endpoint), setOrigin, clearOrigin, validateOrigin, sameOriginDefault, addressSpace };
})();
globalThis.NanoAPI = NanoAPI;
if (typeof module !== 'undefined') module.exports = NanoAPI;
