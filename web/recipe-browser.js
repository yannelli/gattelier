'use strict';

const NanoRecipeBrowser = (() => {
  let load;
  function mount(container, lab, onLoad) {
    load = onLoad;
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Built-in recipes');
    const label = document.createElement('label'); label.className = 'recipe-library-label'; label.textContent = 'Built-in recipes'; label.append(select);
    const description = document.createElement('p'); description.className = 'vendor-note';
    const availability = document.createElement('p'); availability.className = 'vendor-note'; availability.setAttribute('role', 'status');
    const source = document.createElement('a'); source.target = '_blank'; source.rel = 'noopener noreferrer'; source.className = 'vendor-note'; source.hidden = true;
    container.append(label, description, availability, source);
    let selected = '', signature = '';
    function render() {
      const current = lab.getState(), entries = NanoRecipeLibrary.entries;
      const ready = new Set(NanoRecipeLibrary.available(current).map(item => item.id));
      const next = JSON.stringify([selected, [...ready]]);
      if (next !== signature) {
        signature = next; select.replaceChildren(new Option('Choose from 25 recipes', ''));
        for (const [title, isReady] of [['Available on this connection', true], ['Other built-in recipes', false]]) {
          const group = document.createElement('optgroup'); group.label = title;
          for (const entry of entries.filter(item => ready.has(item.id) === isReady)) group.append(new Option(entry.name, entry.id));
          if (group.children.length) select.append(group);
        }
        select.value = selected;
      }
      const entry = NanoRecipeLibrary.get(selected);
      description.textContent = entry ? `${entry.description}${entry.leavesSubscriptionActive ? ' Subscription stays on for capture.' : ''}` : 'Device information, batteries, thermometers, environmental sensors, heart rate, and pulse oximeters.';
      availability.textContent = entry ? NanoRecipeLibrary.availability(entry, current).reason : `${ready.size} recipes match the current connection.`;
      source.hidden = !entry;
      if (entry) { source.textContent = entry.source.title; source.href = entry.source.url; }
    }
    function choose(id) {
      const entry = NanoRecipeLibrary.get(id); if (!entry) return false;
      selected = id; onLoad(entry.recipe); render(); return true;
    }
    load = choose;
    select.addEventListener('change', () => choose(select.value));
    lab.onState(render); render();
  }
  return { mount, load(id) { if (load?.(id)) { NanoWorkspace.openTool('recipes'); return true; } return false; } };
})();
