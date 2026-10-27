'use strict';

const NanoCatalogUI = (() => {
  function el(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
  function link(source) { const item = el('a', '', source.title); item.href = source.url; item.target = '_blank'; item.rel = 'noopener noreferrer'; return item; }
  function code(entry) { return entry.uuid ? `${entry.uuid.length === 4 ? '0x' : ''}${entry.uuid}` : entry.code !== undefined ? `0x${entry.code.toString(16).padStart(entry.type === 'appearance' ? 4 : 2, '0')}` : entry.id; }
  function ruleText(rule) {
    if (rule.kind === 'service') return `Service ${rule.uuid}`;
    if (rule.kind === 'company') return `Company 0x${rule.id.toString(16).padStart(4, '0')}`;
    if (rule.kind.startsWith('name')) return `Name ${rule.kind === 'name' ? 'equals' : 'starts with'} “${rule.value}”`;
    return `${rule.kind === 'service-data' ? `Service data ${rule.uuid}` : 'Manufacturer data'}${rule.hex || rule.prefix ? ` starts with ${rule.hex || rule.prefix}` : ''}${rule.minBytes !== undefined ? `, at least ${rule.minBytes} bytes` : ''}${rule.maxBytes !== undefined ? `, at most ${rule.maxBytes} bytes` : ''}`;
  }
  function mount(panel) {
    const section = el('section', 'catalog-section');
    section.innerHTML = '<div class="catalog-heading"><p class="catalog-status" data-library-status role="status"></p><span class="badge" data-library-count></span></div><div class="api-actions"><button type="button" class="button secondary" data-libraries-refresh>Download libraries</button><button type="button" class="button quiet" data-libraries-clear>Remove</button></div><div class="catalog-library-list" data-library-list></div><details class="catalog-browser"><summary>Browse library entries</summary><div class="catalog-filters"><label>Search libraries<input type="search" data-library-search placeholder="UUID, protocol, name, or code" autocomplete="off"></label><label>Entry type<select data-library-kind><option value="">All entries</option><option value="uuid">UUID names</option><option value="protocol">Protocols</option><option value="appearance">Appearance</option><option value="ad-type">Advertising data</option></select></label></div><p class="vendor-note" data-library-results-count role="status"></p><div class="catalog-results" data-library-results></div></details>';
    panel.querySelector('.panel-heading').after(section);
    const get = selector => section.querySelector(selector), originInput = panel.querySelector('[data-metadata-origin]');
    const refresh = get('[data-libraries-refresh]'), clear = get('[data-libraries-clear]'), search = get('[data-library-search]'), kind = get('[data-library-kind]');
    let signature = '', searchSignature = '', editingOrigin = false;
    originInput.addEventListener('input', () => { editingOrigin = true; });
    function renderResults() {
      const result = NanoCatalogs.search(search.value, kind.value), target = get('[data-library-results]');
      get('[data-library-results-count]').textContent = result.total ? `${result.total.toLocaleString()} ${result.total === 1 ? 'entry' : 'entries'}${result.total > result.rows.length ? ` · showing the first ${result.rows.length}; narrow your search to see more` : ''}` : 'No entries match. Download libraries or change your search.';
      const items = result.rows.map(entry => {
        const row = el('details', 'catalog-entry'), summary = el('summary'), heading = el('div', 'catalog-entry-heading');
        heading.append(el('strong', '', entry.name || entry.title), el('code', '', code(entry))); summary.append(heading, el('span', 'catalog-kind', entry.kind || entry.type)); row.append(summary);
        const body = el('div', 'catalog-entry-body');
        if (entry.description) body.append(el('p', '', entry.description));
        if (entry.category) body.append(el('p', 'vendor-note', `Category: ${entry.category}`));
        if (entry.rules) {
          body.append(el('p', 'vendor-note', 'Matches when one of these rules is satisfied:'));
          const rules = el('ul'); for (const rule of entry.rules) rules.append(el('li', '', rule.map(ruleText).join(' AND '))); body.append(rules);
        }
        for (const limitation of entry.limitations || []) body.append(el('p', 'vendor-note', limitation));
        body.append(el('p', 'vendor-note', `${entry.libraryTitle} · ${entry.revision}`));
        const sources = el('div', 'profile-sources'); for (const source of entry.sources || [{ title: 'Source definition', url: entry.source }]) sources.append(link(source));
        body.append(sources); row.append(body); return row;
      });
      target.replaceChildren(...items);
    }
    function render() {
      const state = NanoCatalogs.status(); refresh.disabled = state.busy; clear.disabled = !state.busy && !state.libraries.length;
      refresh.textContent = state.busy ? 'Downloading…' : state.libraries.length ? 'Update libraries' : 'Download libraries';
      get('[data-library-count]').textContent = `${state.count.toLocaleString()} entries`;
      if (!editingOrigin && state.libraries.length) originInput.value = state.origin;
      get('[data-library-status]').textContent = state.error || (state.busy ? 'Downloading…' : state.updatedAt ? `Updated ${new Date(state.updatedAt).toLocaleString()}${state.persistent ? '' : ' · this tab only'}` : 'Not downloaded');
      const next = JSON.stringify(state.libraries);
      if (signature !== next) {
        signature = next;
        const rows = state.libraries.map(library => {
          const card = el('div', 'catalog-library'), label = el('label', 'catalog-enabled'), check = el('input'); check.type = 'checkbox'; check.checked = library.enabled;
          check.addEventListener('change', () => NanoCatalogs.enable(library.id, check.checked)); label.append(check, el('span', '', library.title), el('span', 'catalog-kind', library.count.toLocaleString()));
          const details = el('details', 'catalog-source'); details.append(el('summary', '', 'Version & sources'), el('p', 'vendor-note', library.revision));
          const sources = el('div', 'profile-sources'); for (const source of library.sources) sources.append(link(source)); details.append(sources); card.append(label, details); return card;
        });
        get('[data-library-list]').replaceChildren(...rows);
      }
      const resultVersion = `${signature}/${state.updatedAt}`;
      if (searchSignature !== resultVersion) { searchSignature = resultVersion; renderResults(); }
    }
    refresh.addEventListener('click', async () => { try { await NanoCatalogs.refresh(originInput.value); } catch (error) { get('[data-library-status]').textContent = error.message; } });
    clear.addEventListener('click', () => NanoCatalogs.clear());
    search.addEventListener('input', renderResults); kind.addEventListener('change', renderResults);
    globalThis.addEventListener('nanoscope:catalogs', render); render();
  }
  return { mount };
})();
