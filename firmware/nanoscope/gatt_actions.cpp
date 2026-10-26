#include "gatt.h"
#include "trace.h"
#include <algorithm>

static CharacteristicInfo* findEntry(uint32_t handle) {
  for (auto& service : state.services) {
    for (auto& characteristic : service.characteristics) {
      if (characteristic.handle == handle) return &characteristic;
    }
  }
  return nullptr;
}

static bool hasProperty(const CharacteristicInfo& entry, GattProperty property) {
  return (entry.properties & property) != 0;
}

bool validateGatt(const Command& command, String& error) {
  if (!state.connected) { error = "No device is connected."; return false; }
  auto entry = findEntry(command.argument);
  if (!entry) { error = "Characteristic handle is not part of the current connection."; return false; }
  switch (command.action) {
    case Action::Read:
      if (!hasProperty(*entry, GattRead)) error = "This characteristic does not support reads.";
      break;
    case Action::Write:
      if (command.length > sizeof(command.data)) error = "Write payload exceeds 512 bytes.";
      else if (command.mode > 1) error = "Write mode must select with or without response.";
      else if (!hasProperty(*entry, command.mode ? GattWrite : GattWriteNoResponse)) error = "This characteristic does not support the selected write mode.";
      break;
    case Action::Subscribe:
      if (command.mode > 2) error = "Subscription mode must be off, notify, or indicate.";
      else if (command.mode == 1 && !hasProperty(*entry, GattNotify)) error = "This characteristic does not support notifications.";
      else if (command.mode == 2 && !hasProperty(*entry, GattIndicate)) error = "This characteristic does not support indications.";
      else if (!command.mode && !hasProperty(*entry, GattNotify) && !hasProperty(*entry, GattIndicate)) error = "This characteristic does not support subscriptions.";
      break;
    default: error = "Unsupported GATT operation.";
  }
  return error.isEmpty();
}

static String printableBytes(const uint8_t* data, size_t length) {
  String text;
  text.reserve(length);
  for (size_t i = 0; i < length; ++i) text += data[i] >= 32 && data[i] <= 126 ? char(data[i]) : '.';
  return text;
}

static void updateValue(uint16_t handle, const uint8_t* data, size_t length, const String& error = "") {
  String hex = error.length() ? "" : hexBytes(data, length);
  String text = error.length() ? "" : printableBytes(data, length);
  StateLock lock;
  auto entry = findEntry(handle);
  if (!entry) return;
  entry->valueHex = std::move(hex);
  entry->valueText = std::move(text);
  entry->readError = error;
  entry->hasValue = error.isEmpty();
}

static void failOperation(const String& address, const String& uuid, uint16_t handle, const String& error) {
  {
    StateLock lock;
    state.error = error;
  }
  recordTrace("error", address, uuid, handle, nullptr, 0, error, false);
}

static void notificationReceived(NimBLERemoteCharacteristic* characteristic, uint8_t* data, size_t length, bool isNotify) {
  const String address = characteristic->getClient()->getPeerAddress().toString().c_str();
  const String uuid = characteristic->getUUID().toString().c_str();
  const uint16_t handle = characteristic->getHandle();
  recordTrace(isNotify ? "notification" : "indication", address, uuid, handle, data, length);
  updateValue(handle, data, length);
}

static void readCharacteristic(NimBLERemoteCharacteristic* characteristic, const String& address, const String& uuid) {
  time_t timestamp = -1;
  auto value = characteristic->readValue(&timestamp);
  String error;
  if (timestamp == -1) error = "GATT read failed (BLE code " + String(characteristic->getClient()->getLastError()) + "). Inspect the connection and security state.";
  updateValue(characteristic->getHandle(), value.data(), value.size(), error);
  recordTrace("read", address, uuid, characteristic->getHandle(), value.data(), value.size(), error, timestamp != -1);
  if (error.length()) {
    StateLock lock;
    state.error = error;
  }
}

static void writeCharacteristic(NimBLEClient* client, NimBLERemoteCharacteristic* characteristic, const Command& command,
                                const String& address, const String& uuid) {
  if (command.length > sizeof(command.data) || command.mode > 1) {
    failOperation(address, uuid, command.argument, "Invalid write payload or write mode.");
    return;
  }
  if ((!command.mode && !characteristic->canWriteNoResponse()) || (command.mode && !characteristic->canWrite())) {
    failOperation(address, uuid, command.argument, "The selected write mode is no longer available.");
    return;
  }
  if (!command.mode && command.length > client->getMTU() - 3) {
    failOperation(address, uuid, command.argument, "Write without response exceeds negotiated MTU payload of " + String(client->getMTU() - 3) + " bytes.");
    return;
  }
  recordTrace("write", address, uuid, command.argument, command.data, command.length,
              command.mode ? "Write request with response" : "Write request without response");
  if (!characteristic->writeValue(command.data, command.length, command.mode == 1)) {
    failOperation(address, uuid, command.argument, "GATT write failed (BLE code " + String(client->getLastError()) + "). Check the connection, permissions, and selected write mode.");
    return;
  }
  recordTrace("write-result", address, uuid, command.argument, nullptr, 0,
              command.mode ? "Write acknowledged" : "Write submitted without response");
}

static void subscribeCharacteristic(NimBLERemoteCharacteristic* characteristic, const Command& command,
                                    const String& address, const String& uuid) {
  if (command.mode > 2 || (command.mode == 1 && !characteristic->canNotify()) ||
      (command.mode == 2 && !characteristic->canIndicate())) {
    failOperation(address, uuid, command.argument, "The selected subscription mode is unavailable.");
    return;
  }
  if (!characteristic->getDescriptor(NimBLEUUID(uint16_t(0x2902)))) {
    failOperation(address, uuid, command.argument, "Subscription requires a client configuration descriptor (0x2902), which was not found.");
    return;
  }
  const char* mode = command.mode == 1 ? "notify" : command.mode == 2 ? "indicate" : "off";
  recordTrace("subscribe", address, uuid, command.argument, nullptr, 0, String("Subscription requested: ") + mode);
  bool success = command.mode ? characteristic->subscribe(command.mode == 1, notificationReceived, true) : characteristic->unsubscribe(true);
  if (!success) {
    failOperation(address, uuid, command.argument, "Subscription update failed. The device rejected the request or disconnected.");
    return;
  }
  {
    StateLock lock;
    auto entry = findEntry(command.argument);
    if (entry) entry->subscription = mode;
  }
  recordTrace("subscribe-result", address, uuid, command.argument, nullptr, 0, String("Subscription active: ") + mode);
}

void executeGatt(NimBLEClient* client, const Command& command) {
  const String address = client->getPeerAddress().toString().c_str();
  if (!client->isConnected()) {
    failOperation(address, "", command.argument, "Device disconnected before the GATT operation.");
    return;
  }
  auto characteristic = client->getCharacteristic(command.argument);
  if (!characteristic) {
    failOperation(address, "", command.argument, "Characteristic is no longer available. Reconnect and inspect again.");
    return;
  }
  const String uuid = characteristic->getUUID().toString().c_str();
  switch (command.action) {
    case Action::Read:
      if (characteristic->canRead()) readCharacteristic(characteristic, address, uuid);
      else failOperation(address, uuid, command.argument, "This characteristic is no longer readable.");
      break;
    case Action::Write: writeCharacteristic(client, characteristic, command, address, uuid); break;
    case Action::Subscribe: subscribeCharacteristic(characteristic, command, address, uuid); break;
    default: failOperation(address, uuid, command.argument, "Unsupported GATT operation.");
  }
}
