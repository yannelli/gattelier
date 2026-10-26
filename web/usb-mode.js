var NanoUSB = (() => {
  function summary(state) {
    if (!state) return 'USB mode unavailable';
    if (state.restarting) return 'Restarting board';
    if (state.error) return state.error;
    return state.mode === 'hci' ? state.ready ? 'USB controller ready' : 'Starting USB controller' : 'Bluetooth workbench active';
  }
  function mount(container, lab) {
    if (!container) return;
    let current, pending = false, available = false, requestedMode = '';
    container.classList.add('settings-card', 'usb-settings');
    container.innerHTML = '<div class="panel-heading"><div><h2>USB controller</h2><p data-usb-status role="status">Loading USB mode</p></div><button class="button quiet" data-usb-refresh type="button">Refresh</button></div><div class="usb-body"><p>A computer can control this board’s BLE radio through H4 over USB serial. Wireshark captures commands, events and ACL data exchanged with this controller.</p><p>Switching modes restarts the board and disconnects its BLE session. Wi-Fi stays available for mode controls. Triple-press the board button to switch back.</p><dl class="usb-counters"><div><dt>Host packets</dt><dd data-usb-host>0</dd></div><div><dt>Controller packets</dt><dd data-usb-controller>0</dd></div><div><dt>Dropped packets</dt><dd data-usb-dropped>0</dd></div><div><dt>Framing errors</dt><dd data-usb-rejected>0</dd></div></dl><button class="button secondary" data-usb-toggle type="button" disabled>Enable USB HCI</button><p class="usb-message" data-usb-message role="status"></p><details class="usb-help"><summary>Computer capture tools</summary><p>Enable USB HCI, then run this from the project directory with the NanoC6 serial port:</p><pre><code>python3 scripts/usb_hci.py --port /dev/cu.usbmodem1101 --scan passive --pcap nanoscope.pcapng</code></pre><p>For a Wireshark capture interface, place nanoscope_extcap.py and usb_hci.py together in Wireshark’s personal extcap folder. The USB device retains its serial identity. Captures contain this controller’s traffic.</p></details></div>';
    const get = name => container.querySelector(`[data-usb-${name}]`);
    function render() {
      get('status').textContent = summary(current);
      get('toggle').textContent = current?.mode === 'hci' ? 'Restore Bluetooth workbench' : 'Enable USB HCI';
      get('toggle').disabled = pending || !available || !current || current.restarting || !current.storageReady;
      for (const [name, key] of Object.entries({ host: 'hostPackets', controller: 'controllerPackets', dropped: 'droppedPackets', rejected: 'rejectedBytes' })) get(name).textContent = String(current?.[key] || 0);
    }
    async function request(body) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await NanoAPI.fetch('/api/usb-mode', { signal: controller.signal,
          ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'USB mode request failed.');
        return result;
      } finally { clearTimeout(timeout); }
    }
    async function refresh() {
      try { current = await request(); available = true; }
      catch (error) { available = false; get('message').textContent = error.message; }
      render();
    }
    get('refresh').addEventListener('click', refresh);
    get('toggle').addEventListener('click', async () => {
      if (pending || !available || !current) return;
      pending = true; render();
      const mode = current.mode === 'hci' ? 'workbench' : 'hci';
      requestedMode = mode;
      try {
        current = await request({ mode });
        get('message').textContent = `Restarting into ${mode === 'hci' ? 'USB HCI' : 'Bluetooth workbench'} mode. The page reconnects when Wi-Fi is ready.`;
        setTimeout(refresh, 2500);
      } catch (error) { get('message').textContent = error.message; }
      finally { pending = false; render(); }
    });
    lab?.onState((state, online) => {
      const wasAvailable = available; available = online;
      if (state.usb) current = state.usb;
      else if (online && !wasAvailable) refresh();
      if (current && !current.restarting && current.mode === requestedMode) { get('message').textContent = summary(current); requestedMode = ''; }
      render();
    });
    refresh();
  }
  return { mount, summary };
})();
if (typeof module !== 'undefined') module.exports = NanoUSB;
