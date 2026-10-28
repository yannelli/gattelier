#include "state.h"
#include "gatt.h"
#include "trace.h"
#include "ble_security.h"
#include "usb_hci.h"
#include "collection.h"
#include "activity_led.h"
#include "scan_stream.h"
#include "connection_cancellation.h"
#include <NimBLEDevice.h>
#include <algorithm>
#include <freertos/queue.h>
#include <esp_random.h>

static QueueHandle_t commands;
static NimBLEClient* client;
static ConnectionCancellation connectionCancellation;
static SemaphoreHandle_t cancellationMutex;
static uint32_t lastCancellation = 0;
static std::atomic<int> connectionOutcome{0};
static std::atomic<uint32_t> startedAttempt{0};
static std::atomic<bool> deferredCancellation{false}, connectionTimedOut{false}, peerChoseInterval{false};

bool connectionCancellationRequested() { return connectionCancellation.requested(connectionCancellation.active()); }

static void interruptConnection() {
  if (client->getConnHandle() != BLE_HS_CONN_HANDLE_NONE) client->disconnect();
  else client->cancelConnect();
  lastCancellation = millis();
}

static bool connectionTornDown(uint32_t attempt) {
  return startedAttempt.load() != attempt || (connectionOutcome.load() != 0 && client->getConnHandle() == BLE_HS_CONN_HANDLE_NONE);
}

static void finishCancellation(uint32_t attempt) {
  {
    StateLock lock;
    state.connected = false;
    std::vector<ServiceInfo>().swap(state.services);
    state.error = connectionTimedOut.load() ? "Connection timed out." : "Connection cancelled.";
    state.busy = false;
    state.operation = "idle";
  }
  connectionCancellation.finish(attempt);
  deferredCancellation.store(false);
}

bool cancelConnection(const String& address, uint8_t addressType, uint32_t attempt, String& error) {
  if (!cancellationMutex) { error = "Bluetooth workbench is unavailable."; return false; }
  if (xSemaphoreTake(cancellationMutex, 0) != pdTRUE) { error = "Connection cleanup is in progress. Check board status."; return false; }
  bool accepted = false;
  {
    StateLock lock;
    if (state.busy && state.connectionAttempt == attempt && state.address.equalsIgnoreCase(address) && state.addressType == addressType &&
        (state.operation == "connecting" || state.operation == "discovering" || state.operation == "cancelling") && connectionCancellation.request(attempt)) {
      state.operation = "cancelling";
      accepted = true;
    } else error = "This connection attempt is no longer active.";
  }
  if (accepted) interruptConnection();
  xSemaphoreGive(cancellationMutex);
  return accepted;
}

void updateConnectionCancellation() {
  if (!cancellationMutex || !connectionCancellationRequested() || uint32_t(millis() - lastCancellation) < 25) return;
  if (xSemaphoreTake(cancellationMutex, 0) != pdTRUE) return;
  if (connectionCancellationRequested()) {
    if (deferredCancellation.load() && connectionTornDown(connectionCancellation.active())) finishCancellation(connectionCancellation.active());
    else interruptConnection();
  }
  xSemaphoreGive(cancellationMutex);
}

class ScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* advertised) override {
    signalActivityLed();
    StateLock lock;
    if (!state.scanning) return;
    recordAdvertisement(advertised);
    if (state.captureAddress.isEmpty()) return;
    const String address = advertised->getAddress().toString().c_str();
    if (state.captureAddress == address) {
      const auto& payload = advertised->getPayload();
      recordTrace("advertisement", address, "", 0, payload.data(), payload.size(), "RSSI " + String(advertised->getRSSI()) + " dBm");
    }
  }
};

class ClientCallbacks : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient* peer) override { auto info = peer->getConnInfo(); securityConnected(info); connectionOutcome.store(1); }
  void onConnectFail(NimBLEClient*, int) override { connectionOutcome.store(-1); }
  bool onConnParamsUpdateRequest(NimBLEClient* peer, const ble_gap_upd_params* params) override {
    // NimBLE answers with the client's parameters, so adopt the peer's to grant what it asked for.
    peer->setConnectionParams(params->itvl_min, params->itvl_max, params->latency, params->supervision_timeout);
    peerChoseInterval.store(true);
    return true;
  }
  void onPassKeyEntry(NimBLEConnInfo& info) override { securityPasskeyInput(info); }
  void onConfirmPasskey(NimBLEConnInfo& info, uint32_t pin) override { securityNumericComparison(info, pin); }
  uint32_t onPassKeyDisplay(NimBLEConnInfo& info) override { return securityPasskeyDisplay(info); }
  void onAuthenticationComplete(NimBLEConnInfo& info) override { securityAuthenticationComplete(info); }
  void onMTUChange(NimBLEClient* peer, uint16_t mtu) override {
    StateLock lock;
    state.mtu = mtu;
    recordTrace("mtu", peer->getPeerAddress().toString().c_str(), "", 0, nullptr, 0, "Negotiated MTU " + String(mtu));
  }
  void onDisconnect(NimBLEClient*, int reason) override {
    connectionOutcome.store(-1);
    securityDisconnected();
    StateLock lock;
    recordTrace("disconnect", state.address, "", 0, nullptr, 0, "BLE reason " + String(reason));
    state.connected = false;
    std::vector<ServiceInfo>().swap(state.services);
    if (state.operation != "disconnecting" && state.operation != "cancelling") state.error = "Device disconnected (BLE code " + String(reason) + ").";
  }
};

static ScanCallbacks scanCallbacks;
static ClientCallbacks clientCallbacks;

static void scanDevices(bool enabled) {
  auto scan = NimBLEDevice::getScan();
  bool success = true;
  if (enabled && !scan->isScanning()) success = scan->start(0);
  if (!enabled && scan->isScanning()) success = scan->stop();
  StateLock lock;
  state.scanning = scan->isScanning();
  if (!enabled) state.scanCompleted = true;
  if (!success) {
    state.error = "BLE scan could not change state. Try again.";
    state.scanEnabled = false;
  }
}

static void maintainScan() {
  static uint32_t appliedRevision = UINT32_MAX;
  const auto plan = collectionScanPlan(millis());
  const bool collecting = collectionEnabled();
  auto scan = NimBLEDevice::getScan();
  if (plan.revision != appliedRevision) {
    scanDevices(false);
    scan->setActiveScan(plan.active); scan->setInterval(plan.intervalMs); scan->setWindow(plan.windowMs);
    appliedRevision = plan.revision;
  }
  bool shouldScan;
  {
    StateLock lock;
    shouldScan = (collecting ? plan.enabled : state.scanEnabled) && !state.connected && !state.busy;
    if (state.scanning) {
      uint32_t now = millis() / 1000;
      for (size_t i = 0; i < state.devices.size();) {
        if (now - state.devices[i].lastSeen > 120) eraseScanCache(i);
        else ++i;
      }
      if (ESP.getFreeHeap() > 110592 && state.error.startsWith("Device memory is low")) state.error = "";
    }
  }
  if (shouldScan && !scan->isScanning()) scanDevices(true);
  if (!shouldScan && scan->isScanning()) scanDevices(false);
  StateLock lock;
  if (!state.busy) state.operation = state.scanning ? "scanning" : "idle";
}

static void connectDevice(const Command& command) {
  if (connectionCancellation.requested(command.connectionAttempt)) return;
  scanDevices(false);
  const String address = reinterpret_cast<const char*>(command.data);
  bool recorderOnly = command.length & 1;
  {
    StateLock lock;
    for (const auto& candidate : state.devices) {
      if (candidate.address != address || candidate.addressType != command.mode) continue;
      for (const auto& uuid : candidate.services) if (uuid == "0x504c") recorderOnly = true;
      break;
    }
    state.address = address;
    std::vector<ServiceInfo>().swap(state.services);
    clearScanCache();
  }
  if (connectionCancellation.requested(command.connectionAttempt)) return;
  connectionOutcome.store(0);
  connectionTimedOut.store(false);
  startedAttempt.store(command.connectionAttempt);
  // 15 ms, the floor iOS accessories are built for, makes discovery about four times faster than NimBLE's 30-50 ms default.
  client->setConnectionParams(12, 12, 0, BLE_GAP_INITIAL_SUPERVISION_TIMEOUT);
  peerChoseInterval.store(false);
  const bool started = address.length() == 17 && client->connect(NimBLEAddress(address.c_str(), command.mode), true, true, true);
  if (!started) connectionOutcome.store(-1);
  const uint32_t began = millis();
  while (started && connectionOutcome.load() == 0 && !connectionCancellation.requested(command.connectionAttempt) && uint32_t(millis() - began) < 35000) vTaskDelay(pdMS_TO_TICKS(10));
  if (started && connectionOutcome.load() == 0 && !connectionCancellation.requested(command.connectionAttempt)) {
    connectionTimedOut.store(true);
    connectionCancellation.request(command.connectionAttempt);
    StateLock lock; state.operation = "cancelling";
  }
  if (connectionCancellation.requested(command.connectionAttempt)) return;
  if (!started || connectionOutcome.load() != 1 || !client->isConnected()) {
    StateLock lock;
    state.error = "Connection failed (BLE code " + String(client->getLastError()) + "). Retry using this device's known address.";
    return;
  }
  if (connectionCancellation.requested(command.connectionAttempt)) return;
  {
    StateLock lock;
    state.connected = true;
    if (!connectionCancellation.requested(command.connectionAttempt)) state.operation = "discovering";
    state.discoveryScope = recorderOnly ? "PLAUD recorder service 0x1910" : "all services";
  }
  recordTrace("connect", address, "", 0, nullptr, 0, "Connected");
  discoverGatt(client, recorderOnly, command.length & 2);
  // Restore the default afterwards so notification streams pace as before, unless the peer already chose an interval.
  if (peerChoseInterval.load() || !client->isConnected()) return;
  client->setConnectionParams(BLE_GAP_INITIAL_CONN_ITVL_MIN, BLE_GAP_INITIAL_CONN_ITVL_MAX, 0, BLE_GAP_INITIAL_SUPERVISION_TIMEOUT);
  client->updateConnParams(BLE_GAP_INITIAL_CONN_ITVL_MIN, BLE_GAP_INITIAL_CONN_ITVL_MAX, 0, BLE_GAP_INITIAL_SUPERVISION_TIMEOUT);
}

static void bleWorker(void*) {
  Command command;
  for (;;) {
    if (xQueueReceive(commands, &command, pdMS_TO_TICKS(500)) != pdTRUE) {
      maintainScan();
      continue;
    }
    switch (command.action) {
      case Action::Scan: scanDevices(true); break;
      case Action::StopScan: scanDevices(false); break;
      case Action::Connect: connectDevice(command); break;
      case Action::Pair: beginPairing(); break;
      case Action::Read:
      case Action::Write:
      case Action::Subscribe: executeGatt(client, command); break;
      case Action::Disconnect:
        if (client->isConnected()) client->disconnect();
        for (int i = 0; i < 100 && client->getConnHandle() != BLE_HS_CONN_HANDLE_NONE; ++i) vTaskDelay(pdMS_TO_TICKS(50));
        break;
    }
    if (command.action == Action::Connect) {
      xSemaphoreTake(cancellationMutex, portMAX_DELAY);
      if (connectionCancellation.requested(command.connectionAttempt)) {
        if (!connectionTornDown(command.connectionAttempt)) interruptConnection();
        for (int i = 0; i < 500 && !connectionTornDown(command.connectionAttempt); ++i) vTaskDelay(pdMS_TO_TICKS(10));
        if (!connectionTornDown(command.connectionAttempt)) {
          deferredCancellation.store(true);
          { StateLock lock; state.operation = "cancelling"; std::vector<ServiceInfo>().swap(state.services); state.error = "Waiting for Bluetooth connection cancellation."; }
          xSemaphoreGive(cancellationMutex);
          continue;
        }
      }
    }
    if (client->getConnHandle() == BLE_HS_CONN_HANDLE_NONE) client->deleteServices();
    {
      StateLock lock;
      state.connected = client->getConnHandle() != BLE_HS_CONN_HANDLE_NONE;
      if (!state.connected) std::vector<ServiceInfo>().swap(state.services);
      if (command.action == Action::Disconnect && state.connected) state.error = "Disconnect did not complete. Try again.";
      if (command.action == Action::Connect && connectionCancellation.requested(command.connectionAttempt)) {
        std::vector<ServiceInfo>().swap(state.services);
        state.error = connectionTimedOut.load() ? "Connection timed out." : "Connection cancelled.";
      }
      state.busy = false;
      state.operation = "idle";
    }
    if (command.action == Action::Connect) { connectionCancellation.finish(command.connectionAttempt); xSemaphoreGive(cancellationMutex); }
    maintainScan();
  }
}

bool queueCommand(Command& command, String& error) {
  if (usbHciMode()) { error = "Restore Bluetooth workbench mode before using web BLE commands."; return false; }
  if (collectionEnabled() && (command.action == Action::Scan || command.action == Action::StopScan)) { error = "Stop collection in Settings or hold the button for 3 seconds before using manual scanning."; return false; }
  StateLock lock;
  if (state.busy) { error = "A BLE operation is already running."; return false; }
  if (pairingActive() && command.action != Action::Disconnect) { error = "Finish or cancel the current pairing request first."; return false; }
  if (command.action == Action::Pair && (!state.connected || state.address != reinterpret_cast<const char*>(command.data))) {
    error = "Pairing requires the current connected device address."; return false;
  }
  if ((command.action == Action::Scan || command.action == Action::StopScan) && state.connected) { error = "Scanning is paused while connected."; return false; }
  if (command.action == Action::Connect) {
    if (state.connected) { error = "Disconnect the current device first."; return false; }
    auto device = std::find_if(state.devices.begin(), state.devices.end(), [&](const DeviceInfo& d) { return command.argument ? d.id == command.argument : d.address == reinterpret_cast<const char*>(command.data) && d.addressType == command.mode; });
    if (command.argument && (device == state.devices.end() || !device->connectable)) { error = "Select a connectable device from the latest scan."; return false; }
    if (!command.argument && strlen(reinterpret_cast<const char*>(command.data)) != 17) { error = "A known Bluetooth address is required."; return false; }
    if (command.argument) { memcpy(command.data, device->address.c_str(), 18); command.mode = device->addressType; }
    if (device != state.devices.end() && std::find(device->services.begin(), device->services.end(), String("0x504c")) != device->services.end()) command.length = 1;
    state.address = reinterpret_cast<const char*>(command.data);
    state.addressType = command.mode;
    connectionTimedOut.store(false);
    startedAttempt.store(0);
    deferredCancellation.store(false);
    command.connectionAttempt = state.connectionAttempt = connectionCancellation.begin();
  }
  if ((command.action == Action::Disconnect || command.action == Action::Read) && !state.connected) {
    error = "No device is connected."; return false;
  }
  if ((command.action == Action::Read || command.action == Action::Write || command.action == Action::Subscribe) && !validateGatt(command, error)) return false;
  state.busy = true;
  state.error = "";
  switch (command.action) {
    case Action::Scan: state.scanEnabled = true; state.operation = "scanning"; break;
    case Action::StopScan: state.scanEnabled = false; state.operation = "stopping"; break;
    case Action::Connect: state.operation = "connecting"; break;
    case Action::Disconnect: state.operation = "disconnecting"; break;
    case Action::Read: state.operation = "reading"; break;
    case Action::Write: state.operation = "writing"; break;
    case Action::Subscribe: state.operation = "subscribing"; break;
    case Action::Pair: state.operation = "pairing"; break;
  }
  if (xQueueSend(commands, &command, 0) == pdTRUE) return true;
  state.busy = false;
  state.operation = "idle";
  if (command.action == Action::Connect) connectionCancellation.finish(command.connectionAttempt);
  error = "BLE worker is unavailable.";
  return false;
}

void startBle() {
  startScanStream();
  connectionCancellation.seed(esp_random());
  cancellationMutex = xSemaphoreCreateMutex();
  if (!cancellationMutex) abort();
  NimBLEDevice::init("NanoScope");
  NimBLEDevice::setMTU(247);
  auto scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&scanCallbacks, true);
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(45);
  scan->setMaxResults(0);
  scan->setScanResponseTimeout(10);
  client = NimBLEDevice::createClient();
  if (!client) abort();
  client->setClientCallbacks(&clientCallbacks, false);
  client->setConnectTimeout(30000);
  startSecuritySupport(client);
  commands = xQueueCreate(1, sizeof(Command));
  if (!commands || xTaskCreate(bleWorker, "ble-worker", 8192, nullptr, 1, nullptr) != pdPASS) abort();
}
