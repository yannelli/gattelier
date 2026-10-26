'use strict';

const NanoMetadataUI = (() => {
  function mount(panel) {
    panel.classList.add('settings-card', 'api-settings');
    panel.innerHTML = '<div class="panel-heading"><div><h2>Device metadata</h2><p>Names, units, and readable states for known byte formats</p></div></div><div class="api-form"><p>Built-in decoders work offline. Download supplemental definitions when the board’s catalog does not recognize a value. The request downloads a public catalog; device addresses, packets, and readings stay in this browser.</p><label>Metadata server<input data-metadata-origin type="url" spellcheck="false" autocomplete="off"></label><div class="api-actions"><button data-metadata-refresh class="button secondary" type="button">Download metadata</button><button data-metadata-clear class="button quiet" type="button">Remove downloaded data</button></div><label class="metadata-enabled"><input data-metadata-enabled type="checkbox"> Use downloaded definitions</label><p data-metadata-status class="hint" role="status"></p></div>';
    const input = panel.querySelector('[data-metadata-origin]'), enabled = panel.querySelector('[data-metadata-enabled]'), status = panel.querySelector('[data-metadata-status]'), refresh = panel.querySelector('[data-metadata-refresh]');
    input.value = NanoMetadata.status().origin;
    function render() {
      const state = NanoMetadata.status(); enabled.checked = state.enabled;
      enabled.disabled = !state.supplemental;
      status.textContent = `${state.count} UUID definitions. ${state.supplemental ? `Downloaded ${state.supplemental}${state.updatedAt ? ` on ${new Date(state.updatedAt).toLocaleString()}` : ''}.` : 'No supplemental catalog downloaded.'}`;
    }
    refresh.addEventListener('click', async () => {
      refresh.disabled = true; status.textContent = 'Downloading public metadata...';
      try { await NanoMetadata.refresh(input.value); render(); }
      catch (error) { status.textContent = `${error.name === 'AbortError' ? 'Metadata download timed out.' : error.message} Existing decoders remain available.`; }
      finally { refresh.disabled = false; }
    });
    enabled.addEventListener('change', () => NanoMetadata.enable(enabled.checked));
    panel.querySelector('[data-metadata-clear]').addEventListener('click', () => NanoMetadata.clear());
    globalThis.addEventListener('nanoscope:metadata', render); render();
  }
  return { mount };
})();
