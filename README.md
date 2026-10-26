# Gattelier

> [!WARNING]
> **Work in progress.** Interfaces and stored data formats can change, and hardware support varies by device.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yannelli/gattelier)

Gattelier is a Bluetooth Low Energy workbench for the M5Stack NanoC6. The board scans nearby BLE devices and serves a browser interface for inspection, GATT operations, capture, and repeatable device workflows.

The board address is `http://nanoscope.local`. Existing NanoScope storage keys and backup formats still work.

## What works

- Continuous BLE scanning with browser history, filters, signal history, OUI lookup, and a company database
- GATT service discovery, reads, writes, notifications, pairing prompts, packet capture, snapshots, and saved recipes
- Contextual apps selected from discovered device metadata
- Import and export of PLAUD and Pocket recorder credentials, plus authenticated recording access
- RadiaCode identity, status, and measurement reads verified on hardware
- Sleep Number Fuzion and MCR readers with passing unit tests; a live link has not been verified
- Standard Bluetooth thermometer and environmental sensor recipes
- Metadata and investigation helpers for locks, ResMed devices, GE appliances, and Samsung TVs

Gattelier does not include full TV or GE appliance control.

## Hardware limits

The NanoC6 supports BLE. Its ESP32-C6 has no Bluetooth Classic or USB host controller. Gattelier captures advertisements and traffic from its own connections; it does not sniff connections between other devices.

USB controller mode exposes the board's own H4 controller traffic over serial. The Wireshark extcap path has been tested with that traffic.

The board button controls its operating mode:

- Short press: switch between saved Wi-Fi and the board hotspot. Blue means Wi-Fi; amber means hotspot.
- Triple press: switch to USB HCI mode. The LED turns purple.
- Hold for three seconds: start or stop collection. The LED shows a teal double pulse while collection is active.

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

The board serves the app at `http://nanoscope.local` when mDNS is available. A short button press starts its hotspot if saved Wi-Fi is unavailable.

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

A page loaded over public HTTPS cannot call the board's plain HTTP endpoint because browsers block mixed content. Run the private HTTPS bridge on a Mac connected to the board and Tailscale:

```sh
NANOSCOPE_BOARD_URL=http://nanoscope.local \
  sh scripts/start-pwa.sh --serve --allow-origin https://your-app.workers.dev
```

Open Settings in the hosted app and set the board connection URL to the private HTTPS address printed by the bridge. The bridge accepts requests from the app origin you allow. The computer running the bridge and the iPhone must both be connected to your Tailscale network.

The repository does not have a license yet.
