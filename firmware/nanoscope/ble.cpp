#include "state.h"
#include "gatt.h"
#include "trace.h"
#include "ble_security.h"
#include "usb_hci.h"
#include "collection.h"
#include <NimBLEDevice.h>
#include <algorithm>
#include <freertos/queue.h>

static QueueHandle_t commands;
static NimBLEClient* client;
static uint32_t nextDeviceId = 1;

class ScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* advertised) override {
    StateLock lock;
    if (!state.scanning) return;
    String address = advertised->getAddress().toString().c_str();
    auto it = std::find_if(state.devices.begin(), state.devices.end(), [&](const DeviceInfo& d) {
      return d.address == address && d.addressType == advertised->getAddressType();
    });
    if (it == state.devices.end()) {
      if (ESP.getFreeHeap() < 98304) {
        state.error = "Device memory is low. New discoveries will appear as inactive devices expire.";
        return;
      }
      state.devices.emplace_back();
      it = state.devices.end() - 1;
      it->id = nextDeviceId++;
    }
    it->address = address;
    it->addressType = advertised->getAddressType();
    if (advertised->haveName()) it->name = String(advertised->getName().c_str()).substring(0, 80);
    it->rssi = advertised->getRSSI();
    it->connectable = advertised->isConnectable();
    it->lastSeen = millis() / 1000;
    it->advType = advertised->getAdvType();
    it->hasTxPower = advertised->haveTXPower();
    it->txPower = it->hasTxPower ? advertised->getTXPower() : 0;
    const auto& payload = advertised->getPayload();
    it->payloadHex = hexBytes(payload.data(), payload.size());
    it->serviceData.clear();
    for (uint8_t i = 0; i < advertised->getServiceDataCount(); ++i) {
      auto bytes = advertised->getServiceData(i);
      it->serviceData.push_back({advertised->getServiceDataUUID(i).toString().c_str(),
        hexBytes(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size())});
    }
    if (advertised->haveManufacturerData()) {
      auto bytes = advertised->getManufacturerData();
      it->manufacturer = hexBytes(reinterpret_cast<const uint8_t*>(bytes.data()), std::min(bytes.size(), size_t(128)));
    }
    if (advertised->haveServiceUUID()) {
      it->services.clear();
      for (uint8_t i = 0; i < std::min(advertised->getServiceUUIDCount(), uint8_t(8)); ++i) {
        it->services.emplace_back(advertised->getServiceUUID(i).toString().c_str());
      }
    }
    if (state.captureAddress == address) recordTrace("advertisement", address, "", 0, payload.data(), payload.size(), "RSSI " + String(it->rssi) + " dBm");
  }
};

class ClientCallbacks : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient* peer) override { auto info = peer->getConnInfo(); securityConnected(info); }
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
    securityDisconnected();
    StateLock lock;
    recordTrace("disconnect", state.address, "", 0, nullptr, 0, "BLE reason " + String(reason));
    state.connected = false;
    state.services.clear();
    if (state.operation != "disconnecting") state.error = "Device disconnected (BLE code " + String(reason) + ").";
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
      auto expired = [now](const DeviceInfo& device) { return !device.remembered && now - device.lastSeen > 120; };
      state.devices.erase(std::remove_if(state.devices.begin(), state.devices.end(), expired), state.devices.end());
      if (ESP.getFreeHeap() > 110592 && state.error.startsWith("Device memory is low")) state.error = "";
    }
  }
  if (shouldScan && !scan->isScanning()) scanDevices(true);
  if (!shouldScan && scan->isScanning()) scanDevices(false);
  StateLock lock;
  if (!state.busy) state.operation = state.scanning ? "scanning" : "idle";
}

static void connectDevice(const Command& command) {
  scanDevices(false);
  DeviceInfo device;
  {
    StateLock lock;
    for (const auto& candidate : state.devices) if (candidate.id == command.argument) device = candidate;
    if (!command.argument) { device.address = reinterpret_cast<const char*>(command.data); device.addressType = command.mode; }
    state.address = device.address;
    state.services.clear();
  }
  bool recorderOnly = command.length == 1 || std::find(device.services.begin(), device.services.end(), String("0x504c")) != device.services.end();
  if (device.address.length() != 17 || !client->connect(NimBLEAddress(device.address.c_str(), device.addressType), true, false, false)) {
    StateLock lock;
    state.error = "Connection failed (BLE code " + String(client->getLastError()) + "). Retry using this device's known address.";
    return;
  }
  {
    StateLock lock;
    state.connected = true;
    for (auto& candidate : state.devices) if (candidate.address == device.address && candidate.addressType == device.addressType) candidate.remembered = true;
    state.operation = "discovering";
    state.discoveryScope = recorderOnly ? "PLAUD recorder service 0x1910" : "all services";
  }
  recordTrace("connect", device.address, "", 0, nullptr, 0, "Connected");
  discoverGatt(client, recorderOnly);
  if (client->isConnected()) client->exchangeMTU();
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
        for (int i = 0; i < 100 && client->isConnected(); ++i) vTaskDelay(pdMS_TO_TICKS(50));
        break;
    }
    {
      StateLock lock;
      state.connected = client->isConnected();
      if (!state.connected) state.services.clear();
      if (command.action == Action::Disconnect && state.connected) state.error = "Disconnect did not complete. Try again.";
      state.busy = false;
      state.operation = "idle";
    }
    maintainScan();
  }
}

bool queueCommand(Command command, String& error) {
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
    auto device = std::find_if(state.devices.begin(), state.devices.end(), [&](const DeviceInfo& d) { return d.id == command.argument; });
    if (command.argument && (device == state.devices.end() || !device->connectable)) { error = "Select a connectable device from the latest scan."; return false; }
    if (!command.argument && strlen(reinterpret_cast<const char*>(command.data)) != 17) { error = "A known Bluetooth address is required."; return false; }
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
  error = "BLE worker is unavailable.";
  return false;
}

void startBle() {
  NimBLEDevice::init("NanoScope");
  NimBLEDevice::setMTU(247);
  auto scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&scanCallbacks, true);
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(45);
  scan->setMaxResults(0);
  client = NimBLEDevice::createClient();
  if (!client) abort();
  client->setClientCallbacks(&clientCallbacks, false);
  client->setConnectTimeout(30000);
  startSecuritySupport(client);
  commands = xQueueCreate(1, sizeof(Command));
  if (!commands || xTaskCreate(bleWorker, "ble-worker", 8192, nullptr, 1, nullptr) != pdPASS) abort();
}
