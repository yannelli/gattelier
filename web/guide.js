'use strict';

const NanoGuide = (() => {
  function mount(container) {
    container.innerHTML = '<div class="panel-heading"><div><h2>Tools &amp; capture workflows</h2><p>Choose a source based on what you need to inspect.</p></div></div><div class="detail"><div id="guide-capabilities" class="table-scroll"></div><h3 class="section-label">Investigation workflow</h3><ol class="guide-steps"><li>Discover a device, give it a local label, and save a baseline snapshot.</li><li>Connect and inspect its services. Subscribe to the characteristic you want to observe.</li><li>Add a traffic marker, perform one action on your device, then compare packets and timing.</li><li>Save a second snapshot and compare advertisements, services, properties, and optional values.</li><li>Turn a verified sequence into a recipe. Recipes run when you press Run.</li></ol><h3 class="section-label">Local API &amp; host automation</h3><p class="vendor-note">The browser handles matching, sorting, storage, and decoding. Host scripts can use the same API without a browser. Scan samples come from the board cache and are not a packet-by-packet RF capture.</p><pre class="mono guide-code">GET /api/state\nGET /api/events?after=42\nPOST /api/scan {}\nPOST /api/stop-scan {}\nPOST /api/connect {"id":123}\nPOST /api/read {"handle":12}\nPOST /api/subscribe {"handle":15,"mode":"notify"}\nPOST /api/disconnect {}</pre><p class="vendor-note">POST requests use Content-Type: application/json. Connect with a current device ID. Capture exports report gaps and truncation.</p><pre class="mono guide-code">python3 scripts/stream_capture.py http://nanoscope.local \\\n  --mode events --seconds 60 --output capture.ndjson</pre><p class="vendor-note">The host helper writes NDJSON for scripts and analysis tools without changing scans or connections. MQTT and ESPHome require a separate bridge because Gattelier does not expose the ESPHome protocol.</p><h3 class="section-label">References</h3><div id="guide-references" class="guide-references"></div></div>';
    const table = document.createElement('table'); table.className = 'byte-table';
    const rows = [
      ['Workflow', 'Available here', 'Additional requirement'],
      ['Discover and follow broadcasts', 'Continuous BLE scan, browser history, filters, signal trends and passive decoders', 'Keep the page or host helper open to collect history'],
      ['Inspect your GATT connection', 'Read, write, subscribe, typed decoding, snapshots and recipes', 'Select and connect to the device; protected attributes require pairing'],
      ['Capture companion-app commands', 'Import iPhone PacketLogger ATT traffic; compare payloads and export', 'Capture on the phone that runs the companion app'],
      ['Capture another over-the-air BLE connection', 'External capture workflow', 'Compatible Nordic sniffer or other sniffer hardware; applicable encryption keys'],
      ['Bluetooth Classic / audio / RFCOMM', 'External host workflow', 'ESP32-C6 supports BLE, without Classic BR/EDR'],
      ['Use the computer Bluetooth adapter', 'Bleak host workflow', 'Web Bluetooth also requires a secure origin and user device chooser']
    ];
    rows.forEach((values, index) => { const row = document.createElement('tr'); for (const value of values) { const cell = document.createElement(index ? 'td' : 'th'); cell.textContent = value; row.append(cell); } table.append(row); });
    container.querySelector('#guide-capabilities').append(table);
    const sources = [
      ['nRF Connect macros', 'https://github.com/nordicsemi/Android-nRF-Connect/blob/main/documentation/Macros/README.md'],
      ['Wireshark packet analysis', 'https://www.wireshark.org/docs/wsug_html_chunked/ChWorkFindPacketSection.html'],
      ['Nordic BLE sniffer', 'https://docs.nordicsemi.com/r/bundle/nrfutil/page/nrfutil-ble-sniffer/guides/overview.html'],
      ['BTLEjack', 'https://github.com/virtualabs/btlejack'],
      ['Ubertooth', 'https://github.com/greatscottgadgets/ubertooth'],
      ['Bleak host API', 'https://bleak.readthedocs.io/en/latest/'],
      ['ESPHome Bluetooth proxy', 'https://esphome.io/components/bluetooth_proxy/'],
      ['Web Bluetooth requirements', 'https://developer.chrome.com/docs/capabilities/bluetooth'],
      ['ESP32-C6 Bluetooth capabilities', 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32c6/api-guides/bt-architecture/overview.html']
    ];
    for (const [title, url] of sources) { const link = document.createElement('a'); link.textContent = title; link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; container.querySelector('#guide-references').append(link); }
  }
  return { mount };
})();
