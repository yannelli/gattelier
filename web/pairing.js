'use strict';

const NanoPairing = (() => {
  let current = { ble: {} }, selected, online = false, sending = false, challenge = null, promptKey = '', hooks, root;
  const get = id => root.querySelector(`#pairing-${id}`);
  async function post(path, body) {
    if (sending || !online) return;
    sending = true; get('error').textContent = ''; update(current, online, selected);
    try { await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await hooks.changed(); }
    catch (error) { get('error').textContent = error.message; }
    finally { sending = false; update(current, online, selected); }
  }
  function respond(value) {
    try { return post('pairing-response', NanoPairingModel.response(current, selected, challenge, value)); }
    catch (error) { get('error').textContent = error.message; }
  }
  function catalog() {
    const rows = NanoPairingCatalog.search(get('search').value, get('transport').value), list = get('catalog-results');
    list.replaceChildren();
    for (const item of rows) {
      const card = document.createElement('article'); card.className = 'pin-entry';
      const heading = document.createElement('h4'); heading.textContent = `${item.manufacturer} ${item.model}`;
      const pin = document.createElement('p'); pin.className = 'mono'; pin.textContent = `${item.pin} · ${item.transport === 'ble' ? 'BLE passkey' : 'Bluetooth Classic'}`;
      const condition = document.createElement('p'); condition.className = 'vendor-note'; condition.textContent = item.condition;
      const source = document.createElement('a'); source.textContent = item.sourceTitle; source.href = item.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer';
      card.append(heading, pin, condition, source);
      if (item.transport === 'ble' && /^\d{6}$/.test(item.pin)) {
        const use = document.createElement('button'); use.className = 'button secondary'; use.type = 'button'; use.textContent = `Fill ${item.pin}`; use.dataset.pinFill = 'true';
        use.disabled = !canEnter(); use.addEventListener('click', () => { if (canEnter()) { get('passkey').value = item.pin; get('passkey').focus(); } }); card.append(use);
      }
      list.append(card);
    }
    if (!rows.length) list.textContent = 'No documented model matches this search.';
  }
  function canEnter() { return online && !sending && NanoPairingModel.target(current, selected) && current.security?.active && current.security.status === 'passkey-input'; }
  function update(state, available, device) {
    if (!root) return;
    current = state; online = available; selected = device;
    const security = state.security || {}, connected = NanoPairingModel.target(state, device), relevant = security.address?.toLowerCase() === device?.address?.toLowerCase();
    const key = `${device?.address || ''}/${connected}/${security.status}/${security.challengeId}`;
    if (key !== promptKey) { promptKey = key; get('passkey').value = ''; get('error').textContent = ''; }
    challenge = relevant && connected ? security.challengeId : null;
    get('target').textContent = device ? `${device.label || device.name || device.address} · ${device.address}` : 'Select a device to manage its pairing.';
    get('status').textContent = !online ? 'Board unavailable' : relevant && ['failed', 'cancelled'].includes(security.status) ? NanoPairingModel.statuses[security.status] : !connected ? 'Connect this device before pairing.' : (NanoPairingModel.statuses[security.status] || 'Ready to pair');
    get('facts').textContent = relevant && connected ? `${security.encrypted ? 'Encrypted' : 'Unencrypted'} · ${security.authenticated ? 'Authenticated' : 'Unauthenticated'} · ${security.bonded ? 'Bonded connection' : 'Connection not bonded'}${security.keySize ? ` · ${security.keySize * 8}-bit key` : ''}` : '';
    get('remote-error').textContent = relevant ? security.error || '' : '';
    get('start').disabled = !online || !connected || sending || state.ble?.busy || security.active || relevant && security.encrypted;
    get('start').textContent = relevant && security.encrypted ? 'Connection secured' : 'Pair device';
    get('input-form').hidden = !connected || !relevant || security.status !== 'passkey-input' || !security.active;
    get('passkey').disabled = !canEnter(); get('submit').disabled = !canEnter();
    get('confirm').hidden = !connected || !relevant || security.status !== 'numeric-comparison' || !security.active;
    get('code').hidden = !connected || !relevant || !['numeric-comparison', 'passkey-display'].includes(security.status) || !security.active;
    get('code').textContent = /^\d{6}$/.test(security.passkey || '') ? security.passkey : '';
    get('accept').disabled = sending || !online; get('reject').disabled = sending || !online;
    get('cancel').hidden = !connected || !relevant || !security.active; get('cancel').disabled = sending || !online;
    get('expiry').textContent = connected && relevant && security.active ? `Request expires in ${Math.max(0, Math.ceil((security.remainingMs || 0) / 1000))}s. Cancel disconnects this device.` : '';
    for (const button of root.querySelectorAll('[data-pin-fill]')) button.disabled = !canEnter();
  }
  function mount(container, options) {
    root = container; hooks = options;
    root.innerHTML = '<div class="pairing-body"><h3>Pairing &amp; security</h3><p id="pairing-target" class="hint"></p><p id="pairing-status" class="pairing-status" role="status"></p><p id="pairing-facts" class="vendor-note"></p><p id="pairing-code" class="pairing-code" hidden></p><form id="pairing-input-form" class="pairing-form" hidden><label>Device passkey<input id="pairing-passkey" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" spellcheck="false" required placeholder="Six digits"></label><button id="pairing-submit" class="button primary" type="submit">Send passkey</button></form><div id="pairing-confirm" class="pairing-actions" hidden><button id="pairing-accept" class="button primary" type="button">Codes match</button><button id="pairing-reject" class="button secondary" type="button">Codes differ</button></div><div class="pairing-actions"><button id="pairing-start" class="button primary" type="button">Pair device</button><button id="pairing-cancel" class="button secondary" type="button" hidden>Cancel pairing</button></div><p id="pairing-expiry" class="vendor-note"></p><p id="pairing-remote-error" class="error" role="status"></p><p id="pairing-error" class="error" role="alert"></p><p class="vendor-note">BLE pairing encrypts the connection and can save a bond on the board. Recorder account authentication remains inside its app. Passkeys stay out of browser storage.</p><details class="pairing-catalog"><summary>Documented default passkeys</summary><p class="vendor-note">Check the exact model and condition. A label or changed passkey takes precedence. Selecting a reference fills the field; Send passkey submits one attempt. Classic PINs are reference-only on NanoC6.</p><div class="pin-search"><input id="pairing-search" type="search" aria-label="Search pairing PIN references" placeholder="Manufacturer or model"><select id="pairing-transport" aria-label="Pairing reference transport"><option value="ble">BLE passkeys</option><option value="all">All references</option><option value="classic">Bluetooth Classic references</option></select></div><div id="pairing-catalog-results"></div></details></div>';
    get('input-form').addEventListener('submit', event => { event.preventDefault(); respond(get('passkey').value); });
    get('start').addEventListener('click', () => selected && post('pair', { address: selected.address }));
    get('accept').addEventListener('click', () => respond(true)); get('reject').addEventListener('click', () => respond(false));
    get('cancel').addEventListener('click', () => selected && post('pairing-cancel', { address: selected.address, challengeId: challenge }));
    get('search').addEventListener('input', catalog); get('transport').addEventListener('change', catalog); catalog();
  }
  return { mount, update };
})();
