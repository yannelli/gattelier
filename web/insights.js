'use strict';

const NanoInsights = (() => {
  function el(tag, cls, text) { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; }
  const displayName = device => typeof deviceDisplayName === 'function' ? deviceDisplayName(device) : [device.label, device.name, device.gattName].find(value => typeof value === 'string' && value.trim())?.trim() || device.address;
  function age(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Last seen unknown';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    return seconds < 3 ? 'Seen just now' : seconds < 60 ? `Seen ${seconds}s ago` : seconds < 3600 ? `Seen ${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `Seen ${Math.floor(seconds / 3600)}h ago` : `Seen ${Math.floor(seconds / 86400)}d ago`;
  }
  function profileCard(profile, persistKey) {
    const card = el('section', 'profile-card');
    card.append(el('h3', '', profile.title), el('span', 'badge', profile.confidence));
    if (profile.fields?.length) {
      const fields = el('dl', 'metadata');
      for (const field of profile.fields.filter(item => item.value !== 'Not available')) { const row = el('div'); row.append(el('dt', '', field.label), el('dd', '', String(field.value))); fields.append(row); }
      card.append(fields);
    }
    // Match evidence, limitations and sources are reference material, so they start collapsed.
    const about = el('details', 'profile-about'), evidence = el('ul', 'profile-evidence'), links = el('div', 'profile-sources');
    for (const text of profile.evidence || []) evidence.append(el('li', '', text));
    for (const source of profile.sources || []) { const link = el('a', '', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link); }
    const summary = el('summary', '', 'How this was identified');
    if (persistKey) { about.dataset.persist = persistKey; summary.dataset.focus = `${persistKey}-summary`; }
    about.append(summary, evidence, ...(profile.limitations || []).map(text => el('p', 'vendor-note', text)), links);
    if (evidence.children.length || links.children.length || profile.limitations?.length) card.append(about);
    if (profile.revision) card.append(el('p', 'vendor-note', `Library: ${profile.library} · ${profile.revision}`));
    return card;
  }
  function signalChart(device) {
    const section = el('section', 'signal-card'), samples = (device.history || []).filter(item => Number.isFinite(item?.rssi) && Number.isFinite(item?.at)).sort((a, b) => a.at - b.at);
    section.append(el('h3', '', 'Signal over time (dBm)'));
    if (samples.length < 2) { section.append(el('p', 'hint', 'Keep scanning to collect signal samples for this address.')); return section; }
    const values = samples.map(item => item.rssi), low = Math.min(...values) - 3, high = Math.max(...values) + 3;
    const start = samples[0].at, span = Math.max(1, samples.at(-1).at - start);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 600 140'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Signal ranged from ${Math.min(...values)} to ${Math.max(...values)} dBm across ${samples.length} observations`);
    const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('fill', 'none'); line.setAttribute('points', samples.map(item => `${12 + (item.at - start) / span * 576},${125 - (item.rssi - low) / (high - low) * 110}`).join(' ')); svg.append(line); section.append(svg);
    section.append(el('p', 'signal-summary', `${Math.min(...values)} to ${Math.max(...values)} dBm · ${samples.length} recent samples · ${device.observations || samples.length} total observations`)); return section;
  }
  function render(container, device, devices, select, filter, boardState = {}) {
    const fragment = document.createDocumentFragment(), counts = new Map(), trackers = [];
    for (const item of devices) {
      const category = NanoProfiles.identify(item, boardState).category;
      counts.set(category, (counts.get(category) || 0) + 1);
      if (category === 'tracker') trackers.push(item);
    }
    const catalog = el('div', 'profile-catalog');
    for (const tool of NanoProfiles.catalog()) {
      const card = el('button', 'profile-tool'); card.type = 'button'; card.dataset.focus = `insights-category-${tool.category}`;
      const count = counts.get(tool.category) || 0;
      card.classList.toggle('empty-tool', !count); card.setAttribute('aria-label', `${tool.title}: ${count} seen. Show in Discover`); card.title = tool.description;
      card.append(el('strong', '', tool.title), el('span', 'profile-count', String(count)), el('span', '', tool.description));
      card.addEventListener('click', () => filter(tool.category)); catalog.append(card);
    }
    fragment.append(catalog);
    if (device) {
      const key = `${device.address.toLowerCase()}/${device.addressType}`;
      const heading = el('div', 'insights-device'); heading.append(el('h2', '', displayName(device)), el('p', 'vendor-note', `${device.address} · ${age(device.lastSeenMs)}`)); fragment.append(heading, signalChart(device), profileCard(NanoProfiles.identify(device, boardState), `insights-profile-${key}`));
      const ad = NanoProfiles.advertisement(device.payloadHex || '');
      if (ad.fields.length) fragment.append(profileCard({ title: 'Advertisement metadata', confidence: 'Decoded bytes', evidence: ad.errors, fields: ad.fields, sources: [] }, `insights-advertisement-${key}`));
    } else fragment.append(el('p', 'hint', 'Select a device to see its signal history.'));
    if (trackers.length) {
      const list = el('section', 'tracker-list'); list.append(el('h3', '', 'Tracker broadcasts'));
      for (const item of trackers) { const row = el('button', 'tracker-row', `${displayName(item)} · ${item.rssi} dBm · ${age(item.lastSeenMs)}`); row.type = 'button'; row.dataset.focus = `insights-tracker-${item.address.toLowerCase()}/${item.addressType}`; row.addEventListener('click', () => select(item)); list.append(row); }
      fragment.append(list);
    }
    if (typeof replacePreservingFocus === 'function') replacePreservingFocus(container, fragment);
    else container.replaceChildren(fragment);
  }
  return { age, profileCard, signalChart, render };
})();
