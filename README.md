# Gattelier

> [!WARNING]
> **Work in progress.** Interfaces and stored data formats can change.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yannelli/gattelier)

Gattelier is a Bluetooth Low Energy workbench for the M5Stack NanoC6. The board scans nearby BLE devices and serves a browser interface for inspection, GATT operations, capture, and repeatable device workflows.

The board address is `http://nanoscope.local`. Existing NanoScope storage keys and backup formats still work.

## What works

- Continuous BLE discovery streamed into browser history, with bounded board RAM, filters, signal history, OUI lookup, and a company database
- GATT service discovery, reads, writes, notifications, pairing prompts, packet capture, snapshots, and saved recipes
- Contextual apps selected from discovered device metadata
- PacketLogger and Android/BlueZ btsnoop H4/H1 imports, shared ATT decoding, exact timestamps, loss counters, and authentication redaction
- Tracker and beacon signal statistics, Eddystone configuration decoding, and offline configuration previews
- Bose BMAP capture inspection and QC Ultra Gen1 command previews
- Apple/AirPods broadcast decoding, Vertuo state and maintenance flags, and Core 200S saved-status inspection, with local change history and snapshot export
- Offline command previews for Vertuo settings, AirPods AACP, and VeSync cloud controls, with transport requirements and source links
- Import and export of PLAUD and Pocket recorder credentials, plus authenticated recording access
- RadiaCode identity, status, measurements, calibrated spectrum plots, live refresh, and confirmed dose reset
- Sleep Number Fuzion and MCR readers
- Dexcom G7 authentication with the applicator code, saved sessions, latest/history requests, serial/firmware, and sensor states
- Environmental sensor readings, charts, browser history, and JSON/CSV exports for BTHome, Ruuvi Tag, and Ruuvi Air formats 6/E1; encrypted BTHome readings decode locally with a device key
- Optional browser-cached supplemental metadata from `https://gattelier.ryanyannelli.com`
- 743 bundled UUID names and 1,734 names in hosted libraries, named descriptors and units, plus readable GATT feature flags, service-change ranges, connection parameters, and descriptor values
- LG webOS saved-response inspection and offline LAN request previews for audio, apps, inputs, remote keys, and power-off
- ResMed Air11 FIG capture inspection with CRC checks, fragment handling, plaintext RPC decoding, and authenticated request templates
- Metadata and investigation helpers for locks, GE appliances, and Samsung devices, including SmartTag broadcast state and battery bands

Gattelier does not include full TV or GE appliance control. [Device expansion research](docs/device-expansion.md) lists the next supported protocol paths and their source repositories.

## Hardware limits

The NanoC6 supports BLE. Its ESP32-C6 has no Bluetooth Classic or USB host controller. Gattelier captures advertisements and traffic from its own connections; it does not sniff connections between other devices.

USB controller mode exposes the board's own H4 controller traffic over serial. Wireshark reads it through the extcap plugin in `scripts/nanoscope_extcap.py`.

The board button controls its operating mode:

- Short press: switch between saved Wi-Fi and the board hotspot. Blue means Wi-Fi; amber means hotspot.
- Triple press: switch to USB HCI mode. The LED turns purple.
- Hold for three seconds: start or stop collection. The LED shows a teal double pulse while collection is active.

The separate blue LED flashes for BLE advertisements, GATT traffic, connection events, and USB HCI traffic. Settings > Activity LED provides a brightness slider, test flash, and off button; the board saves the chosen brightness. Sustained activity produces spaced flashes. The RGB LED continues to show the operating mode.

Discovery offload sends raw advertisements to the browser for decoding, filtering, matching, and optional IndexedDB storage. Compact transfers and a renewable 15-second browser lease keep advertisement decoding and history in the browser. During that lease, discovery skips the decoded board cache; it resumes when the browser stops collecting. The board keeps a fixed transfer buffer; missed updates and shortened advertisements appear in Settings > Browser storage. Keep the app open to receive updates, or enable background collection. Discovery offload does not write scan history to board flash. Raw transfer requires current firmware; older firmware still streams its decoded records. GATT discovery keeps compact property flags and releases duplicate descriptor caches after copying their metadata.

Onboard collection stores up to 512 KiB of NDJSON. Active or passive scan mode, interval, window, and scheduled bursts are configurable and persist across restarts. Download the log from the Collection screen.

## Build and flash

The setup script installs Arduino CLI for Apple Silicon macOS, the ESP32 Arduino core, and NimBLE-Arduino.

```sh
npm ci
sh scripts/setup.sh
cp firmware/nanoscope/secrets.example.h firmware/nanoscope/secrets.h
```

Set `WIFI_SSID` and `WIFI_PASSWORD` in `firmware/nanoscope/secrets.h`, then build and flash:

```sh
sh scripts/build.sh
sh scripts/flash.sh /dev/cu.usbmodemXXXX
```

The board serves the app at `http://nanoscope.local` when mDNS is available. A short button press starts its hotspot if saved Wi-Fi is unavailable. The hotspot is named `NanoScope-XXXXXX` and uses the password `nanoscope` until you change it in Settings > Wi-Fi & hotspot; Settings shows a notice while the default is in use. To build with a different default, define `HOTSPOT_PASSWORD` in `secrets.h`.

The board API answers only when the browser reaches it by IP address, a single-label name, or a local suffix such as `.local`, `.lan`, `.home`, `.home.arpa`, or `.internal`. This blocks DNS rebinding from public websites.

## Development

```sh
npm test
npm run build:web
npm run build:cloud
```

`npm run build:web` bundles the browser code for the firmware build. `npm run build:cloud` prepares the static Cloudflare Workers app.

## Deployment

The hosted app runs on Cloudflare Workers. On iPhone, open its HTTPS URL in Safari and choose Share > Add to Home Screen. The app caches its files for offline launch; live tools wait for the board connection. Settings includes a manual cache refresh.

Use the **Deploy to Cloudflare** button above. Cloudflare copies the repository into your GitHub account and opens its Worker setup page. It reads the build configuration, publishes the app at a `workers.dev` URL, and connects the new repository to Workers Builds for automatic deployment on pushes. You choose the account and Worker name during setup.

The app needs no Cloudflare bindings or application secrets. Recorder credentials and board addresses are configured in your own browser after deployment. Cloudflare documents the setup flow in its [deploy button guide](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

### Deploy the existing repository with GitHub Actions

For deployment directly from this repository, the GitHub workflow tests each update and deploys successful pushes to `main`. Add these two repository settings:

| Setting | GitHub location |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Actions variable |
| `CLOUDFLARE_API_TOKEN` | Actions secret |

Use a Cloudflare token with Workers deployment permission for the target account. The deploy job stays disabled until the account ID is set. After adding both settings, run the Check workflow manually or push a commit. Cloudflare's [GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) covers token setup.

Cloudflare Workers hosts only the static app files. The browser stores recorder credentials and private keys locally. The app sends board API requests directly to the board or through the private bridge.

In desktop Chrome, connect the NanoC6 by USB, open the hosted app, and choose **Settings > Board connection > Connect USB**. Select the Espressif USB serial device. Scanning, GATT tools, recorder apps, and collection export use the same board API over USB. The board needs the current firmware in Bluetooth workbench mode. Chrome asks for serial access; each page reload requires reconnecting. [Chrome's Web Serial documentation](https://developer.chrome.com/docs/capabilities/serial) covers browser support and permissions.

**Pause Wi-Fi while USB is connected** stops Wi-Fi and its HTTP listener to release heap. Uncheck it to keep USB and Wi-Fi running together. Disconnecting restores the previous network mode; an interrupted session has a 90-second recovery timeout. A short button press also resumes Wi-Fi. Network settings saved during a pause apply when Wi-Fi resumes. USB connection changes do not write saved network settings or scan history to flash. HCI controller mode uses a separate serial protocol and requires returning to workbench mode before connecting the browser.

Chrome 142+ on desktop and Android supports direct local HTTP connections after a local-network permission prompt. In the hosted app's Settings, enter `http://nanoscope.local` or the board's private IP address, then allow access. The firmware allows `https://gattelier.ryanyannelli.com` by default. For a different hosted URL, open the board's local page and set **Allowed hosted app** in Settings to that exact HTTPS origin. [Chrome's Local Network Access guide](https://developer.chrome.com/blog/local-network-access) describes the permission and mixed-content exemption.

Safari on iPhone does not support this local HTTP exemption. It needs an HTTPS endpoint. The board itself does not need a certificate: run the private HTTPS bridge on a Mac connected to the board and Tailscale:

```sh
NANOSCOPE_BOARD_URL=http://nanoscope.local \
  sh scripts/start-pwa.sh --serve --allow-origin https://your-app.workers.dev
```

Open Settings in the hosted app and set the board connection URL to the private HTTPS address printed by the bridge. The bridge accepts requests from the app origin you allow. The computer running the bridge and the iPhone must both be connected to your Tailscale network.

### Metadata and discovery libraries

Settings > Metadata & libraries downloads public catalogs from `https://gattelier.ryanyannelli.com`. The hosted PWA downloads them on first launch and checks for updates after 24 hours. The embedded board UI downloads them when requested. Libraries stay in browser IndexedDB for offline use; each can be disabled or removed. Removing them also stops automatic downloads until you choose Download libraries again.

| Catalog | Entries | Contents |
| --- | ---: | --- |
| Bluetooth UUIDs | 1,484 | Services, characteristics, descriptors, units, declarations, and member/SDO assignments |
| Vendor UUIDs | 250 | Custom services and characteristics from Nordic’s database and Polar’s SDK definitions |
| Appearance | 342 | Assigned device categories and subcategories |
| Advertising data | 51 | AD type names, retaining context-specific duplicate assignments |
| Protocol signatures | 36 | Meshtastic, Nordic, micro:bit, LEGO, Polar, GoPro, SwitchBot, Xiaomi, Victron, Adafruit, fitness profiles, and others |

The library browser searches names, UUIDs, codes, and protocols. Discover also searches downloaded service names and protocol matches. Device pages show matching evidence from advertisements and discovered GATT services, source links, and limitations.

The Worker serves `/catalogs/index.json` and the versioned catalogs listed in it. Requests download complete public files; device addresses, packets, recordings, credentials, and health readings stay local. Rules contain bounded field comparisons, with no downloaded executable code. The browser validates the complete set before replacing its cache and preserves existing libraries if a download fails. Catalog files are excluded from board firmware.

Bluetooth assignments come from a pinned Bluetooth SIG registry commit. Regenerate them with `python3 scripts/update_bluetooth_catalogs.py`; `--source-dir` accepts a local assigned-numbers checkout. Regenerate custom UUID names with `python3 scripts/generate-vendor-uuids.py`. Two conflicting upstream experimental DFU definitions are excluded. Each protocol entry links to its source documentation or pinned repository revision. The distribution includes the [Nordic database license](catalogs/vendor-uuids-LICENSE.txt) and [Polar source notice](catalogs/vendor-uuids-Polar-LICENSE.txt). `npm run build:cloud` validates and publishes the catalogs and their manifest.

Supplemental value decoders remain available under the same settings panel. They use `/metadata-v1.json` for declarative numeric and enumerated-value definitions. Built-in decoders continue to work without downloaded libraries.

The repository does not have a project-wide license yet. Attributed G7 certificate material and captured crypto fixtures are GPL-3.0-or-later; see [G7 source notices](DEXCOM-CRYPTO-NOTICE.md) and the [license text](licenses/GPL-3.0-or-later.txt).
