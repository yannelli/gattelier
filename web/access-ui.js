'use strict';

const NanoAccessUI = (() => {
  function mount(panel) {
    const details = document.createElement('details'); details.className = 'api-help';
    details.innerHTML = '<summary>Allowed hosted app</summary><form data-access-form class="api-form"><label>Hosted app origin<input data-access-origin type="url" placeholder="https://gattelier.ryanyannelli.com" autocomplete="off" spellcheck="false"></label><p class="vendor-note">Only this HTTPS origin can control the board. Change it from the board\'s local page. Leave blank to turn hosted access off.</p><div class="api-actions"><button class="button secondary" type="submit">Save</button><button class="button quiet" type="button" data-access-load>Reload</button></div></form><p data-access-message role="status" class="vendor-note"></p>';
    panel.querySelector('.api-network').append(details);
    const input = details.querySelector('[data-access-origin]'), status = details.querySelector('[data-access-message]');
    async function request(body) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await NanoAPI.fetch('access', { signal: controller.signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Could not read hosted app access.');
        input.value = value.origin || '';
        status.textContent = value.origin ? `Allowed: ${value.origin}` : 'Hosted app access is disabled.';
      } catch (error) { status.textContent = error.name === 'AbortError' ? 'The board did not respond.' : error.message; }
      finally { clearTimeout(timer); }
    }
    details.querySelector('[data-access-load]').addEventListener('click', () => request());
    details.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      try {
        const origin = input.value.trim() ? NanoAPI.validateOrigin(input.value) : '';
        if (origin && !origin.startsWith('https://')) throw new Error('Hosted app access requires an HTTPS origin.');
        request({ origin });
      } catch (error) { status.textContent = error.message; }
    });
    details.addEventListener('toggle', () => { if (details.open && !input.value && NanoAPI.configured()) request(); });
  }
  return { mount };
})();
