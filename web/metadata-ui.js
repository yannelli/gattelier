'use strict';

const NanoMetadataUI = (() => {
  function mount(panel) {
    panel.classList.add('settings-card', 'api-settings');
    panel.setAttribute('aria-label', 'Metadata and libraries');
    panel.innerHTML = '<div class="panel-heading"><div><h2>Libraries</h2></div><details class="help"><summary aria-label="About libraries"><span aria-hidden="true">?</span></summary><div class="help-body"><p>Libraries name services and recognize protocol families. Built-in profiles and decoders work without them.</p><p>Downloads fetch public catalogs only. Device addresses, packets and readings stay in this browser, and matching runs locally.</p><p>Value decoders add readable names for values the built-in catalog does not recognize.</p></div></details></div><details class="api-help library-advanced"><summary>Value decoders and server</summary><div class="api-form"><label>Library server<input data-metadata-origin type="url" spellcheck="false" autocomplete="off"></label><label class="metadata-enabled"><input data-metadata-enabled type="checkbox"> Use downloaded value decoders</label><div class="api-actions"><button data-metadata-refresh class="button secondary" type="button">Download decoders</button><button data-metadata-clear class="button quiet" type="button">Remove</button></div><p data-metadata-status class="vendor-note" role="status"></p></div></details>';
    const input = panel.querySelector('[data-metadata-origin]'), enabled = panel.querySelector('[data-metadata-enabled]'), status = panel.querySelector('[data-metadata-status]'), refresh = panel.querySelector('[data-metadata-refresh]');
    input.value = NanoMetadata.status().origin;
    function render() {
      const state = NanoMetadata.status(); enabled.checked = state.enabled;
      enabled.disabled = !state.supplemental;
      status.textContent = `${state.count} UUID definitions${state.supplemental ? ` · ${state.supplemental}${state.updatedAt ? `, ${new Date(state.updatedAt).toLocaleDateString()}` : ''}` : ''}`;
    }
    refresh.addEventListener('click', async () => {
      refresh.disabled = true; status.textContent = 'Downloading…';
      try { await NanoMetadata.refresh(input.value); render(); }
      catch (error) { status.textContent = error.name === 'AbortError' ? 'Download timed out.' : error.message; }
      finally { refresh.disabled = false; }
    });
    enabled.addEventListener('change', () => NanoMetadata.enable(enabled.checked));
    panel.querySelector('[data-metadata-clear]').addEventListener('click', () => NanoMetadata.clear());
    globalThis.addEventListener('nanoscope:metadata', render); render();
  }
  return { mount };
})();
