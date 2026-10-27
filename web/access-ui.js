'use strict';

const NanoAccessUI = (() => {
  function mount(panel) {
    const details = document.createElement('details'); details.className = 'api-help';
    details.innerHTML = '<summary>Allowed hosted app</summary><form data-access-form class="api-form"><label>Hosted app origin<input data-access-origin type="url" placeholder="https://gattelier.ryanyannelli.com" autocomplete="off" spellcheck="false"></label><p class="vendor-note">Only this HTTPS origin can control the board. Change it from the board\'s local page. Leave blank to turn hosted access off.</p><div class="api-actions"><button class="button secondary" type="submit">Save</button><button class="button quiet" type="button" data-access-load>Reload</button></div></form><p data-access-message role="status" class="vendor-note"></p>';
    panel.querySelector('.api-network').append(details);
    const input = details.querySelector('[data-access-origin]'), status = details.querySelector('[data-access-message]');
    async function request(body) {
      try {
        const { response, result: value } = await NanoAPI.requestJson('access', body);
        if (!response.ok || !value) throw new Error(value?.error || 'Could not read hosted app access.');
        input.value = value.origin || '';
        status.textContent = value.origin ? `Allowed: ${value.origin}` : 'Hosted app access is disabled.';
      } catch (error) { status.textContent = error.name === 'AbortError' ? 'The board did not respond.' : error.message; }
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
