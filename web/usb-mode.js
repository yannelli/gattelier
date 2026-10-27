var NanoUSB = (() => {
  function summary(state) {
    if (!state) return 'Unavailable';
    if (state.restarting) return 'Restarting board';
    if (state.error) return state.error;
    return state.mode === 'hci' ? state.ready ? 'HCI controller ready' : 'Starting HCI controller' : 'Off · Bluetooth workbench active';
  }
  function mount(container, lab) {
    if (!container) return;
    let current, pending = false, available = false, requestedMode = '';
    container.classList.add('settings-card', 'usb-settings');
    container.innerHTML = '<div class="panel-heading"><div><h2>USB HCI mode</h2><p data-usb-status role="status">Loading</p></div><div class="heading-tools"><button class="button quiet" data-usb-refresh type="button">Refresh</button><details class="help"><summary aria-label="About USB HCI mode"><span aria-hidden="true">?</span></summary><div class="help-body"><p>In HCI mode a computer drives the board’s BLE radio over USB serial (H4), and Wireshark can capture the commands, events and ACL data.</p><p>Switching restarts the board and ends its BLE session. The browser USB connection closes; Wi-Fi stays up for these controls. Triple-press the board button to switch back.</p><h3>Capture from a computer</h3><pre><code>python3 scripts/usb_hci.py --port /dev/cu.usbmodem1101 --scan passive --pcap nanoscope.pcapng</code></pre><p>For a live Wireshark interface, put nanoscope_extcap.py and usb_hci.py together in Wireshark’s personal extcap folder.</p></div></details></div></div><div class="usb-body"><dl class="usb-counters"><div><dt>Host packets</dt><dd data-usb-host>0</dd></div><div><dt>Controller packets</dt><dd data-usb-controller>0</dd></div><div><dt>Dropped</dt><dd data-usb-dropped>0</dd></div><div><dt>Framing errors</dt><dd data-usb-rejected>0</dd></div></dl><button class="button secondary" data-usb-toggle type="button" disabled>Enable USB HCI</button><p class="usb-message" data-usb-message role="status"></p></div>';
    const get = name => container.querySelector(`[data-usb-${name}]`);
    function render() {
      get('status').textContent = summary(current);
      get('toggle').textContent = current?.mode === 'hci' ? 'Return to workbench' : 'Enable USB HCI';
      get('toggle').disabled = pending || !available || !current || current.restarting || !current.storageReady;
      for (const [name, key] of Object.entries({ host: 'hostPackets', controller: 'controllerPackets', dropped: 'droppedPackets', rejected: 'rejectedBytes' })) get(name).textContent = String(current?.[key] || 0);
    }
    async function request(body) {
      const { response, result } = await NanoAPI.requestJson('/api/usb-mode', body);
      if (!response.ok || !result) throw new Error(result?.error || 'USB mode request failed.');
      return result;
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
        get('message').textContent = `Restarting into ${mode === 'hci' ? 'USB HCI' : 'Bluetooth workbench'} mode. ${NanoAPI.transport() === 'serial' ? 'Triple-press the board button to restore workbench mode, then reconnect USB in Settings.' : 'The page reconnects when Wi-Fi is ready.'}`;
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
