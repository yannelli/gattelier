'use strict';

const NanoRecipes = (() => {
  const model = typeof module !== 'undefined' ? require('./recipe-model.js') : NanoRecipeModel;
  const packets = typeof module !== 'undefined' ? require('./packets.js') : NanoPackets;
  function createRunner(lab, { onUpdate = () => {} } = {}) {
    let state = lab.getState(), online = false, generation = 0, bootId = '', cursor = 0, run = null, pending = null;
    function fail(message) {
      if (!run) return;
      run.error = message;
      if (pending) { const item = pending; pending = null; clearTimeout(item.timer); item.reject(new Error(message)); }
    }
    function guard(active) {
      if (run !== active || active.error) throw new Error(active.error || 'Recipe run ended.');
      if (!online || !state.ble?.connected || state.ble.address.toLowerCase() !== active.address || generation !== active.generation || (active.boot && active.boot !== bootId)) throw new Error('Device connection changed. Recipe stopped.');
    }
    function wait(accept, timeout, sync = false) {
      if (pending) throw new Error('A recipe reply is already pending.');
      const promise = new Promise((resolve, reject) => {
        const item = { accept, resolve, reject, sync, timer: setTimeout(() => { if (pending === item) { pending = null; reject(new Error('Recipe step timed out.')); } }, timeout) };
        pending = item;
      });
      promise.catch(() => {}); return promise;
    }
    function settle(value) { const item = pending; pending = null; clearTimeout(item.timer); item.resolve(value); }
    function take(accept) {
      const match = run.events.find(event => event.seq > run.consumed && accept(event));
      if (!match) return null;
      run.consumed = match.seq; run.events = run.events.filter(event => event.seq > match.seq); return match;
    }
    function matches(event, characteristic) {
      try { return event.handle === characteristic.handle && model.uuid(event.uuid) === model.uuid(characteristic.uuid); } catch { return false; }
    }
    async function reply(active, accept, deadline) {
      guard(active); const existing = take(accept); if (existing) return existing;
      const event = await wait(accept, Math.max(1, deadline - Date.now())); guard(active); return event;
    }
    lab.onState((next, available = true) => {
      const address = state?.ble?.connected ? state.ble.address : '', nextAddress = next.ble?.connected ? next.ble.address : '';
      if (address !== nextAddress || online && !available) { generation++; fail('Device connection changed. Recipe stopped.'); }
      state = next; online = available;
    });
    lab.onEvents((events, meta) => {
      const reboot = Boolean(bootId && bootId !== meta.bootId);
      bootId = meta.bootId; cursor = meta.cursor ?? meta.nextSeq ?? cursor;
      if (!run) return;
      if (reboot || meta.reboot) { generation++; fail('Board restarted. Recipe stopped.'); return; }
      if (pending?.sync) { run.boot = bootId; run.consumed = cursor; run.baseline = cursor; run.gaps = meta.gaps || 0; settle(true); return; }
      if (meta.dropped || (meta.gaps || 0) > run.gaps) { fail('Packet capture has a gap. Recipe stopped.'); return; }
      for (const event of events) {
        if (event.address?.toLowerCase() !== run.address || event.seq <= run.baseline) continue;
        if (event.kind === 'disconnect') { generation++; fail('Device disconnected. Recipe stopped.'); return; }
        if (event.truncated) { fail('A recipe packet was truncated. Recipe stopped.'); return; }
        if (['notification', 'indication', 'read'].includes(event.kind)) run.events.push(event);
      }
      if (run.events.length > 2048) { fail('Recipe reply buffer overflowed. Recipe stopped.'); return; }
      if (pending && !pending.sync) {
        const match = take(pending.accept); if (match) settle(match);
      }
    });
    async function execute(input) {
      if (run || lab.isActing() || state.ble?.busy) throw new Error('Wait for the current BLE operation.');
      const recipe = model.validate(input);
      if (!online || !state.ble?.connected) throw new Error('Connect a device before running a recipe.');
      const address = state.ble.address.toLowerCase();
      if (recipe.address && recipe.address !== address) throw new Error('The connected address does not match this recipe.');
      recipe.steps.forEach(step => model.resolve(state, step));
      const active = { address, generation, boot: bootId, consumed: cursor, baseline: cursor, events: [], error: '' }; run = active;
      let index = -1; lab.setFastCapture(true);
      try {
        onUpdate({ status: 'Synchronizing capture', index }); await wait(() => false, 5000, true); guard(active);
        for (index = 0; index < recipe.steps.length; index++) {
          guard(active); const step = recipe.steps[index], characteristic = model.resolve(state, step), deadline = Date.now() + step.timeoutMs;
          onUpdate({ status: 'Running', index, action: step.action });
          let result = '';
          if (step.action === 'wait') {
            const event = await reply(active, event => ['notification', 'indication'].includes(event.kind) && matches(event, characteristic) && !event.redacted && event.success !== false && (event.hex || '').toLowerCase().startsWith(step.prefix), deadline);
            result = packets.sensitive(event.hex || '', characteristic.uuid) ? 'Reply payload redacted' : event.hex || '(empty reply)';
          } else {
            const body = { handle: characteristic.handle };
            if (step.action === 'write') Object.assign(body, { hex: step.hex, response: step.response });
            if (step.action === 'subscribe') body.mode = step.mode;
            const completion = lab.action(step.action, body);
            const timeout = wait(() => false, step.timeoutMs);
            try { await Promise.race([completion, timeout]); } finally { if (pending) { clearTimeout(pending.timer); pending = null; } }
            guard(active);
            if (step.action === 'read') {
              const event = await reply(active, event => event.kind === 'read' && matches(event, characteristic), deadline);
              if (event.success === false) throw new Error(event.message || 'Characteristic read failed.');
              result = event.redacted || packets.sensitive(event.hex || '', characteristic.uuid) ? 'Read payload redacted' : event.hex || '(empty value)';
            } else result = step.action === 'write' ? `${step.hex.length / 2} bytes sent${step.response ? ' with response' : ' without response'}` : `Subscription ${step.mode}`;
          }
          guard(active); onUpdate({ status: 'Complete', index, action: step.action, result });
        }
        onUpdate({ status: 'Recipe complete', index: -1 }); return true;
      } catch (error) { fail(error.message); onUpdate({ status: 'Stopped', index, result: error.message }); throw error; }
      finally { if (pending) { clearTimeout(pending.timer); pending = null; } run = null; lab.setFastCapture(false); }
    }
    return { execute, cancel: () => fail('Cancelled. Already-sent commands cannot be undone.'), running: () => Boolean(run) };
  }
  function mount(container, lab) {
    if (!container) return;
    const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
    let saved = [], persistent = true, available = false;
    const heading = el('div', 'panel-heading'); heading.append(el('h2', '', 'Protocol recipes'));
    heading.insertAdjacentHTML('beforeend', '<details class="help"><summary aria-label="About recipes"><span aria-hidden="true">?</span></summary><div class="help-body"><p>A recipe is a JSON list of reads, writes and subscriptions for the connected device. Pick a built-in one or edit your own.</p><p>Validate checks the steps without sending anything. Commands go out only when you press Run, and Cancel cannot undo commands already sent.</p><p>Up to 20 recipes are saved in this browser. Recipes with authentication payloads cannot be saved or exported.</p></div></details>');
    const body = el('div', 'detail'), controls = el('div', 'inspector-shortcuts'), editor = el('textarea');
    editor.id = 'recipe-editor'; editor.rows = 15; editor.spellcheck = false; editor.setAttribute('aria-label', 'Recipe JSON'); editor.value = JSON.stringify(model.example(), null, 2);
    const savedSelect = el('select'); savedSelect.setAttribute('aria-label', 'Saved recipes');
    const status = el('p', 'hint recipe-status'); status.setAttribute('role', 'status');
    const storageStatus = el('p', 'vendor-note'), log = el('ol', 'recipe-results'), importFile = el('input'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.setAttribute('aria-label', 'Import recipe JSON');
    const buttons = {}, runner = createRunner(lab, { onUpdate(update) {
      if (update.index >= 0) {
        while (log.children.length <= update.index) log.append(el('li', 'mono'));
        log.children[update.index].textContent = `${update.index + 1}. ${update.action || 'Step'}: ${update.status}${update.result ? ` · ${update.result}` : ''}`;
        if (update.result && /^(?:[\da-f]{2})+$/i.test(update.result)) {
          const fields = NanoGattValues.decode(read().steps[update.index].uuid, update.result);
          if (fields.length) log.children[update.index].textContent += ` · ${fields.map(field => `${field.label}: ${field.value}`).join(' · ')}`;
        }
      }
      status.textContent = update.index < 0 ? update.status : `Step ${update.index + 1}: ${update.status}`;
    } });
    const read = () => model.validate(JSON.parse(editor.value));
    function safe(recipe) { if (!model.canStore(recipe, packets.sensitive)) throw new Error('Authentication payload detected. Credentials remain unsaved; remove them before saving or exporting.'); }
    function report(action) { return async () => { try { await action(); } catch (error) { status.textContent = error.message; } finally { sync(); } }; }
    function add(label, action, key) { const button = el('button', 'button secondary', label); button.type = 'button'; button.id = `recipe-${key}`; button.addEventListener('click', report(action)); controls.append(button); buttons[key] = button; }
    function renderSaved() {
      savedSelect.replaceChildren(el('option', '', 'Choose a saved recipe'));
      saved.forEach((recipe, index) => { const option = el('option', '', recipe.name); option.value = index; savedSelect.append(option); });
      storageStatus.textContent = `${saved.length} of 20 saved${persistent ? '' : ' · this tab only'}`;
    }
    function sync() {
      const running = runner.running(); editor.disabled = running; savedSelect.disabled = running; importFile.disabled = running;
      for (const [key, button] of Object.entries(buttons)) button.disabled = key === 'cancel' ? !running : running;
      buttons.run.disabled ||= !available || !lab.getState().ble?.connected || lab.getState().ble?.busy || lab.isActing();
    }
    add('Validate', () => { const recipe = read(); status.textContent = `Valid: ${recipe.steps.length} steps.`; }, 'validate');
    add('Run', async () => { log.replaceChildren(); const task = runner.execute(read()); sync(); await task; }, 'run');
    add('Cancel', () => { runner.cancel(); status.textContent = 'Cancelling…'; }, 'cancel');
    add('Save recipe', () => {
      const recipe = read(); safe(recipe); const index = saved.findIndex(item => item.name === recipe.name);
      if (index < 0 && saved.length >= 20) throw new Error('20 recipes are saved. Reuse an existing name to replace one.');
      if (index < 0) saved.push(recipe); else saved[index] = recipe;
      try { localStorage.setItem('nanoscope.recipes.v1', JSON.stringify(saved)); persistent = true; } catch { persistent = false; }
      renderSaved(); status.textContent = persistent ? 'Recipe saved in this browser.' : 'Recipe kept in memory. Browser storage failed.';
    }, 'save');
    add('Export recipe', () => {
      const recipe = read(); safe(recipe); const url = URL.createObjectURL(new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' }));
      const link = el('a'); link.href = url; link.download = `${recipe.name.replace(/[^a-z0-9_-]/gi, '_')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = '';
    }, 'export');
    savedSelect.addEventListener('change', () => { const recipe = saved[Number(savedSelect.value)]; if (savedSelect.selectedIndex > 0 && recipe) { editor.value = JSON.stringify(recipe, null, 2); status.textContent = ''; } });
    importFile.addEventListener('change', report(async () => {
      const file = importFile.files[0]; if (!file) return;
      if (file.size > 65536) throw new Error('Recipe file exceeds 64 KiB.');
      const recipe = model.validate(JSON.parse(await file.text())); editor.value = JSON.stringify(recipe, null, 2); importFile.value = ''; status.textContent = 'Imported into the editor.';
    }));
    try {
      const value = JSON.parse(localStorage.getItem('nanoscope.recipes.v1') || '[]');
      if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid saved recipe collection.');
      saved = value.map(model.validate).filter(recipe => model.canStore(recipe, packets.sensitive));
    } catch { persistent = false; saved = []; }
    const help = el('details'); help.append(el('summary', '', 'Recipe format'));
    help.append(el('p', 'vendor-note', 'Version 1: name, optional target address, and 1–32 steps. Every step has action and uuid. Add service and zero-based instance to resolve repeated UUIDs; instances follow ascending handles. write uses hex and response; subscribe uses mode notify/indicate/off; wait accepts optional HEX prefix. timeoutMs: 100–30000, default 10000. Wait consumes the next matching notification received during this run, including replies received during the preceding write. Cancel stops later steps.'));
    const library = el('div', 'recipe-library'), advanced = el('details', 'recipe-advanced');
    advanced.append(el('summary', '', 'Edit, save, or import a recipe'), savedSelect, storageStatus, editor, importFile, help);
    body.append(library, status, controls, log, advanced); container.replaceChildren(heading, body);
    NanoRecipeBrowser.mount(library, lab, recipe => { editor.value = JSON.stringify(recipe, null, 2); status.textContent = `${recipe.name} loaded. Press Run to execute on the connected device.`; });
    renderSaved(); sync(); lab.onState((state, online = true) => { available = online; sync(); });
  }
  return { mount, createRunner };
})();
if (typeof module !== 'undefined') module.exports = NanoRecipes;
