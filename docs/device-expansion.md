# Device and tool expansion

Source inspection dated 2026-10-25. "Implemented" describes code in this checkout. Protocol unit tests and the app build pass. RadiaCode spectrum capture is checked separately on hardware; G7 direct authentication and device tests remain incomplete. Proposed features below are separate from implemented behavior.

## Device modules

| Module | Implemented | Proposed next capability | Required evidence or access |
| --- | --- | --- | --- |
| PLAUD Note Pro | Account/device authentication, file listing, BLE download, recording decryption, Ogg CRC/end-page validation and export | Resume interrupted downloads; strengthen Ogg stream/channel validation; local audio preview | Authorized device identity/private key; retained encrypted prefix tied to the same recording and size |
| Pocket | Session-key authentication, date/file listing, firmware/storage queries, exact-length BLE download and MP3 export | Battery/recording-state/slider queries; live audio; Wi-Fi transfer | Device session key; Wi-Fi needs AP association and a TCP-capable local bridge |
| Sleep Number Fuzion | Auth/session framing; system capabilities, firmness and privacy reads | Capability-gated position, presence and climate/lighting state reads | Valid Auth session, link security when required, fresh GATT discovery |
| Sleep Number MCR | Persistent client identity, session binding, correlated pump/firmness reads | Foundation capabilities and positions | Assigned session addresses; distinct foundation message layout and discovered capabilities |
| RadiaCode | Identity/status/measurements; spectrum formats 0/1; calibrated chart; serial live polling; confirmed accumulated-dose reset | Spectrum export, local timed spectrum history, accumulated-spectrum selection | Firmware 4.8+ for measurements/spectrum/reset; configuration format; reset acknowledgement |
| Dexcom G7 | Direct applicator-code authentication, saved sessions, current/history/identity requests, reconnect, captured-packet decoding | User testing on a sensor | Certificate acceptance and sensor interoperability remain untested |
| Health thermometers | Standard temperature FLOAT, units, timestamps/location, interval/type and indication recipes | Measurement history, export and indication readiness | Service/characteristic properties and an actual measurement from the peripheral |
| Environmental Sensing | Standard ambient temperature, humidity and pressure reads/subscriptions | Timed observations and sensor-specific optional fields | Discovered Environmental Sensing characteristics; device security requirements |
| BTHome | v2 numeric/binary subset, CO2, current, 24/32-bit energy, malformed-frame checks; encrypted-frame metadata | Remaining objects/events; authenticated decryption | Correct object layout; encrypted frames need per-device key, nonce and tag validation |
| Ruuvi | RAWv2 format 5 measurements, acceleration, battery/TX, counters and unavailable sentinels | Ruuvi Air format 6/E1; device-specific history export | Extended advertisement delivery for E1; distinct Tag/Air history protocols |
| Trackers/beacons | Find My envelope, Tile services, iBeacon, Eddystone UID/URL/TLM/EID | Signal/telemetry history; explicitly provisioned EID resolver | Resolver identity key/clock for EID; envelope or RSSI alone supplies no owner/location identity |
| Locks | Nuki service recognition, security metadata and generic identity/battery recipes; other names route as candidates | Authorized Nuki state/battery adapter | Authorization ID/shared secret, authenticated frames and generation-specific protocol |
| ResMed Air11 | FIG service recognition and exposed generic metadata | Offline FIG inspection; authorized encrypted GetVersion/read RPCs | Displayed passkey/custom SRP first pairing; saved clientId/masterPairKey and fresh AES session |
| GE appliances | Candidate names, generic BLE metadata and external GEA transport description | USB/UDP bridge for appliance identity and model-specific ERDs | Compatible GEA interface/adapter and exact appliance ERD definitions |
| Samsung TVs | Candidate names, generic BLE metadata and LAN API transport description | LAN identity/app status, then approved WebSocket remote control | Known LAN endpoint, supported TV/firmware, browser/network requirements and remote approval token |

A name, manufacturer ID, service UUID or generic NUS match establishes the stated observation. Each device protocol still needs its documented characteristics, framing, authentication and model/firmware checks.

## Source-backed next steps

### PLAUD and Pocket

[OpenPlod's range transfer](https://github.com/RemiPelloux/OpenPlod/blob/d5c27989b05837cd49ff7780595514e133bd1c0d/src/sync/plaud-transfer.ts#L109) supplies an offset plus retained prefix and checkpoints. Gattelier already encodes a PLAUD download range, so resume fits the existing transport. [Its Ogg validation](https://github.com/RemiPelloux/OpenPlod/blob/d5c27989b05837cd49ff7780595514e133bd1c0d/src/sync/plaud-audio.ts#L29) checks stream sequence and Opus channels as well as CRCs.

[Pocket commands](https://github.com/Enigma-Labs-Technology/pocket-client/blob/3386dae33289daa46bbdbff3b631766dd9267f39/Sources/PocketClient/Wire/Command.swift#L52) and [responses](https://github.com/Enigma-Labs-Technology/pocket-client/blob/3386dae33289daa46bbdbff3b631766dd9267f39/Sources/PocketClient/Wire/Response.swift#L52) define battery, MAC, Wi-Fi firmware, slider and recording-state queries. These are small extensions to the existing authenticated command exchange. Upstream documents firmware 1.7 rejecting pause/resume, and the download command has no byte offset. A resume feature needs a new established wire operation. [Wi-Fi transfer](https://github.com/Enigma-Labs-Technology/pocket-client/blob/3386dae33289daa46bbdbff3b631766dd9267f39/Sources/PocketClient/Transport/WiFiTransfer.swift) uses AP association and TCP, requiring a separate local transport.

### Sleep Number

[Fuzion position reads](https://github.com/kristofferR/ha-adjustable-bed/blob/3bbe58262ed902a3892153b08e9c096cd67cd0da/custom_components/adjustable_bed/beds/sleep_number.py#L856) and [MCR capability/position decoders](https://github.com/kristofferR/ha-adjustable-bed/blob/3bbe58262ed902a3892153b08e9c096cd67cd0da/custom_components/adjustable_bed/beds/sleep_number_mcr_protocol.py#L47) support read-only expansion before motor controls. Keep the two transports separate. MCR wire side 0 is right and side 1 is left.

The [upstream transport account](https://github.com/kristofferR/ha-adjustable-bed/blob/3bbe58262ed902a3892153b08e9c096cd67cd0da/docs/beds/sleep_number.md) records changing characteristic handle layouts and distinct Auth failures. Resolve UUIDs after discovery and distinguish zero/short Auth replies from valid sessions. Its expanded controls still await physical validation. Cloud sleep scores require a separate data source.

### RadiaCode

[The spectrum decoder](https://github.com/cdump/radiacode/blob/2b217916f49f5eedddf8f0d9116fcfd3c6b8832e/src/radiacode/decoders/spectrum.py) defines acquisition duration, calibration coefficients and formats 0/1. [The device client](https://github.com/cdump/radiacode/blob/2b217916f49f5eedddf8f0d9116fcfd3c6b8832e/src/radiacode/radiacode.py) distinguishes dose reset, spectrum reset and accumulated-spectrum reads. Gattelier's reset clears accumulated dose after confirmation; its UI reports device acknowledgement. Spectrum reset remains a separate operation.

[RadiaCode Tools spectrum files](https://github.com/ckuethe/radiacode-tools/blob/e299af6cb3d3155dab8e3c9f6de9e92076176658/src/radiacode_tools/rc_files.py) and [N42 conversion](https://github.com/ckuethe/radiacode-tools/blob/e299af6cb3d3155dab8e3c9f6de9e92076176658/src/n42convert.py) support an export project without new detector commands. Validate exported schemas/interoperability. Dose displays retain device units until configuration-aware normalization is implemented. Automatic isotope identification requires a separate validated analysis pipeline.

### Dexcom G7

[xDrip glucose decoding](https://github.com/NightscoutFoundation/xDrip/blob/c42cf55c6b972215654bc2a34ce563c87a7aa594/app/src/main/java/com/eveningoutpost/dexdrip/cgm/dex/g7/EGlucoseRxMessage.java#L56) and [native backfill](https://github.com/NightscoutFoundation/xDrip/blob/c42cf55c6b972215654bc2a34ce563c87a7aa594/app/src/main/java/com/eveningoutpost/dexdrip/g5model/BackFillStream.java#L59) supply captured-packet layouts. Gattelier authenticates through EC J-PAKE and an AES challenge, coordinates BLE bonding, subscribes to control/backfill, and sends current, bounded history, and identity requests. Sensor-start display is an estimate anchored to original receive time; supported packets do not supply an exact stop time or a model-independent expiry.

[Juggluco's BLE state machine](https://github.com/j-kaltes/Juggluco/blob/e41f4aa239d389bee78cdb8fc7d0dbe9ceb4df53/Common/src/dex/java/tk/glucodata/DexGattCallback.java#L376) and [EC J-PAKE](https://github.com/j-kaltes/Juggluco/blob/e41f4aa239d389bee78cdb8fc7d0dbe9ceb4df53/Common/src/main/cpp/dexcom/ecJPake.cpp#L452) supply the direct reader protocol. Independent OpenSSL fixtures and upstream captured proofs cover the crypto; scripted transports cover pairing and session resumption. Sensor testing is left to the user. The four-digit applicator code enters the G7 module authentication form. Saved sessions are scoped to the browser, board endpoint, and sensor address/type. The code is not saved. See [source and license notices](../DEXCOM-CRYPTO-NOTICE.md).

### Thermometers and environmental sensors

[Zephyr's Health Thermometer sample](https://github.com/zephyrproject-rtos/zephyr/blob/bc5d59d1b6657cfeef30124b818c8fbd69da68ac/samples/bluetooth/peripheral_ht/src/hts.c#L56) declares measurement indications and builds a standard five-byte FLOAT value. Measurement history and export fit the existing decoder. Preserve characteristic UUID, arrival time and device timestamp so ambient and body measurements retain their source context.

[BTHome's MIT constants](https://github.com/Bluetooth-Devices/bthome-ble/blob/12358ba49054ddfdb06a04a216a71096ee9ef895/src/bthome_ble/const.py) corroborate the [published examples](https://github.com/home-assistant/bthome.io/blob/2b5c93ad1ea8c5b61a907c2267cfa894b0adfdc3/src/format.html). The new objects decode little-endian values as follows:

| Object | Encoding | Scale/unit |
| --- | --- | --- |
| `0x0A` | uint24 | 0.001 kWh |
| `0x12` | uint16 | 1 ppm CO2 |
| `0x43` | uint16 | 0.001 A |
| `0x4D` | uint32 | 0.001 kWh |

Remaining [BTHome events](https://github.com/Bluetooth-Devices/bthome-ble/blob/12358ba49054ddfdb06a04a216a71096ee9ef895/src/bthome_ble/event.py) are a modest extension. [Encrypted measurements](https://bthome.io/encryption/) require authenticated AES-CCM processing with the correct key/address/counter before displaying values.

[Ruuvi's current decoder router](https://github.com/ttu/ruuvitag-sensor/blob/150ac6cfd3a671773ed28660b59b1f33143f4dd0/ruuvitag_sensor/decoder.py) supports Air formats [6](https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-6) and [E1](https://docs.ruuvi.com/communication/bluetooth-advertisements/data-format-e1). These add particulate/CO2/VOC/NOX/light data, with format-specific flags and unavailable sentinels. E1 needs intact extended advertisements. Tag/Air history protocols differ, so a generic UART service match does not supply history compatibility.

### Trackers, beacons and locks

[Eddystone EID](https://github.com/google/eddystone/blob/bb8738d7ddac0ddd3dfa70e594d011a0475e763d/eddystone-eid/README.md#L7) has a ten-byte frame containing type, calibrated TX and eight opaque identifier bytes. Decoding that frame does not resolve its identity. [OpenHaystack's broadcaster](https://github.com/seemoo-lab/openhaystack/blob/ea05dadb9e6e71075ef08afb5c2087302fbb7210/Firmware/ESP32/main/openhaystack_main.c) explains the Find My envelope. Signal history fits existing captures; rotating addresses/IDs remain separate observed identities without stronger evidence.

[Nuki state/battery queries](https://github.com/I-Connect/NukiBleEsp32/blob/560cda315847fae79a721d86d4d8185fdd8fd185/src/NukiLock.cpp#L59) run inside the authorized encrypted transport. [Its crypto routines](https://github.com/I-Connect/NukiBleEsp32/blob/560cda315847fae79a721d86d4d8185fdd8fd185/src/NukiUtils.cpp#L44) use authenticated secretbox operations. A state-only adapter needs credential handling and equivalent reviewed crypto. Schlage, Yale and August name routing currently supplies no corresponding protocol implementation.

### ResMed, GE and Samsung

[Air11 FIG framing/session documentation](https://github.com/m-kozlowski/airbreak-plus/blob/d6474221a1940970c1eaa3878618a9dd1813dba9/docs/as11/bluetooth_protocol.md#L40) and [BLE transport](https://github.com/m-kozlowski/airbreak-plus/blob/d6474221a1940970c1eaa3878618a9dd1813dba9/python/lib/as11_ble.py) support offline frame inspection first. Ordinary GetVersion requires encrypted RPC after pairing/resumption. Generic metadata reads do not establish therapy-data access.

[GE's SDK adapter contract](https://github.com/GEMakers/gea-sdk/blob/23484c73f2c211177bef71618da80147a5cda729/README.md#L101) specifies separate USB/UDP adapters. [Identity ERDs](https://github.com/GEMakers/gea-sdk/blob/23484c73f2c211177bef71618da80147a5cda729/src/appliance.js#L373) provide model, serial and appliance type. Cycle data needs exact appliance ERD definitions. This SDK supplies no established local BLE washer/dryer cycle protocol.

[Samsung REST](https://github.com/xchwarze/samsung-tv-ws-api/blob/e48d6377faede37db1f034d726a079b9d8034fac/samsungtvws/rest.py#L53) reads device/app info; [connection code](https://github.com/xchwarze/samsung-tv-ws-api/blob/e48d6377faede37db1f034d726a079b9d8034fac/samsungtvws/connection.py#L58) defines HTTP 8001/TLS 8002 URLs and remote tokens. A compatible LAN adapter is separate from BLE recognition.

[Chrome 142 Local Network Access](https://developer.chrome.com/blog/local-network-access) permits HTTPS-to-HTTP fetch to a recognized local destination after permission. Reading TV responses still requires TV CORS support. Use a local bridge where those requirements are unmet. Assess WebSocket mixed-content, TLS, origin and permission behavior separately; HTTP fetch permission does not establish remote-channel compatibility.

## Workbench tools

| Tool | Implemented | Proposed next capability | Transport or correctness limit |
| --- | --- | --- | --- |
| Discovery/GATT | Advertisement inspection, service/property/handle discovery, reads and subscriptions | Service Changed handling and rediscovery diagnostics | Cached handles need fresh UUID/property validation after a layout change |
| Pairing/security | Passkey input/display, numeric comparison, bond/encryption state and challenge-bound replies | Bond inventory/targeted removal and recovery diagnostics | Application authorization is separate from BLE security |
| Traffic | Live event buffer, PKLG/ATT import, redaction, JSON/CSV and RX-binary export | Android btsnoop import and EATT channel tracking | Retain timestamps/direction/session boundaries, drops and incomplete-record evidence |
| Analysis | Direction/UUID filters, previous-packet match, byte deltas/XOR masks and stream markers | Timing/length distributions and correlated request/reply latency | Statistical correlation does not establish a protocol field meaning |
| Console replay | Explicit resend of selected command history | Session/target evidence and editable recipe conversion | Rebuild authenticated messages with fresh session/counter data |
| Recipes | Bounded read/write/subscribe/wait sequences, UUID/service/instance lookup, prefix waits and gap abort | Typed nonsecret parameters, assertions and result export | Captured credentials/session ciphertext do not become reusable protocol templates |
| Snapshots | Advertisement/GATT/property/value capture, import/export and comparisons | Firmware/model/capture provenance on diffs | Values describe capture time; credentials remain excluded |
| Credentials | Device-scoped recorder credentials, local backups/import and traffic redaction | Protocol-specific credentials for new authorized adapters | New adapters need explicit secret formats and export/redaction rules |
| USB HCI | H4 USB serial controller mode, pcapng/extcap, scanning and raw H4 sends | Host-stack attachment instructions and shared capture import | Mode switch restarts/disconnects board BLE; serial ownership belongs to one host process |
| External sniffing | Import/capture workflows use local-controller observations | External radio-sniffer import | Capturing another phone's radio connection requires suitable sniffer hardware/workflow |

[Espressif's NimBLE central example](https://github.com/espressif/esp-idf/tree/master/examples/bluetooth/nimble/blecent) documents discovery/encryption sequencing. [Wireshark's btsnoop reader](https://github.com/wireshark/wireshark/blob/a0752ed1f75e75ea252d34d7e02a02100205e387/wiretap/btsnoop.c#L36) defines capture framing. [BlueZ btmon](https://github.com/bluez/bluez/blob/a0580dad5655e86314a0a777eb5f602c237a7e19/doc/btmon.rst) provides capture/latency-analysis references. Its TX-completion and RX-inter-arrival measures differ; use wall-clock windows for throughput. [Nordic's sniffer](https://www.nordicsemi.com/Products/Development-tools/nRF-Sniffer-for-Bluetooth-LE) requires a supported Nordic board/dongle. USB HCI exposes this controller's traffic.

## Licensing before code reuse

Protocol facts support independently written decoders. Copying implementation code requires its license and notices; dependencies retain their own terms.

| Source | Inspected license or gap |
| --- | --- |
| cdump/radiacode; ckuethe/radiacode-tools | MIT |
| Bluetooth-Devices/bthome-ble; ttu/ruuvitag-sensor | MIT |
| ha-adjustable-bed; NukiBleEsp32; airbreak-plus | MIT or MIT-style grant |
| pocket-client; google/eddystone; Zephyr HTS sample | Apache-2.0 |
| xDrip; Juggluco | GPLv3 license files; preserve applicable source and notice obligations when adapting code |
| GE gea-sdk | GPL-2.0-or-later source headers |
| samsung-tv-ws-api | LGPL-3.0 source headers |
| OpenHaystack | AGPL-3.0 |
| Wireshark btsnoop reader | GPL-2.0-or-later |
| OpenPlod | MIT for original contributions; [LICENSING.md](https://github.com/RemiPelloux/OpenPlod/blob/d5c27989b05837cd49ff7780595514e133bd1c0d/LICENSING.md) records an unresolved inherited-code grant gap |
| bthome.io website; legacy ruuvi-sensor-protocols | No root LICENSE found in inspected checkouts; corroborate with explicitly licensed parsers and current specifications |

Pin the linked revisions when implementing. Each new adapter needs protocol fixtures and the relevant build/browser checks; physical device behavior remains a separate validation step.
