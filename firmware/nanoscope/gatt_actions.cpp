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

static DescriptorInfo* findDescriptor(uint32_t handle) {
  for (auto& service : state.services) {
    for (auto& characteristic : service.characteristics) {
      for (auto& descriptor : characteristic.descriptors) if (descriptor.handle == handle) return &descriptor;
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
  if (!entry && command.action == Action::Read && findDescriptor(command.argument)) return true;
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

void updateValue(uint16_t handle, const uint8_t* data, size_t length, const String& error, const TracePeer* peer) {
  String hex = error.length() ? "" : hexBytes(data, length);
  StateLock lock;
  if (peer && (!state.connected || !peer->matches(state.address.c_str(), state.addressType, state.connectionAttempt))) return;
  auto entry = findEntry(handle);
  if (!entry) {
    auto descriptor = findDescriptor(handle);
    if (descriptor && error.isEmpty()) { descriptor->valueHex = std::move(hex); descriptor->hasValue = true; }
    return;
  }
  String text = error.length() ? "" : printableBytes(data, length);
  entry->valueHex = std::move(hex);
  entry->valueText = std::move(text);
  entry->readError = error;
  entry->hasValue = error.isEmpty();
}

static void failOperation(const TracePeer& peer, const String& uuid, uint16_t handle, const String& error) {
  {
    StateLock lock;
    state.error = error;
  }
  recordTrace("error", peer.address, uuid, handle, nullptr, 0, error, false, peer.provenance);
}

static void notificationReceived(const TracePeer& peer, const String& uuid, uint16_t handle, uint8_t* data, size_t length, bool isNotify) {
  recordTrace(isNotify ? "notification" : "indication", peer.address, uuid, handle, data, length, "", true, peer.provenance);
  updateValue(handle, data, length, "", &peer);
}

static String readError(int result) {
  if (!result) return "";
  const String prefix = "GATT read failed (BLE code " + String(result) + "). ";
  if (result == BLE_HS_ATT_ERR(0x05)) return prefix + "Insufficient authentication. Pair explicitly in Security before retrying.";
  if (result == BLE_HS_ATT_ERR(0x08)) return prefix + "Insufficient authorization. The device requires permission for this value.";
  if (result == BLE_HS_ATT_ERR(0x0c)) return prefix + "Insufficient encryption key size. Review the pairing in Security.";
  if (result == BLE_HS_ATT_ERR(0x0f)) return prefix + "Insufficient encryption. Pair explicitly in Security before retrying.";
  return prefix + "Inspect the connection and characteristic permissions.";
}

static void readCharacteristic(NimBLERemoteCharacteristic* characteristic, const TracePeer& peer, const String& uuid) {
  const uint16_t handle = characteristic->getHandle();
  std::string value;
  const int result = readAttribute(characteristic->getClient(), handle, value);
  const String error = readError(result);
  const auto data = reinterpret_cast<const uint8_t*>(value.data());
  updateValue(handle, data, value.size(), error, &peer);
  recordTrace("read", peer.address, uuid, handle, result ? nullptr : data, result ? 0 : value.size(), error, result == 0, peer.provenance);
  if (error.length()) {
    StateLock lock;
    state.error = error;
  }
}

static void writeCharacteristic(NimBLEClient* client, NimBLERemoteCharacteristic* characteristic, const Command& command,
                                const TracePeer& peer, const String& uuid) {
  if (command.length > sizeof(command.data) || command.mode > 1) {
    failOperation(peer, uuid, command.argument, "Invalid write payload or write mode.");
    return;
  }
  if ((!command.mode && !characteristic->canWriteNoResponse()) || (command.mode && !characteristic->canWrite())) {
    failOperation(peer, uuid, command.argument, "The selected write mode is no longer available.");
    return;
  }
  if (!command.mode && command.length > client->getMTU() - 3) {
    failOperation(peer, uuid, command.argument, "Write without response exceeds negotiated MTU payload of " + String(client->getMTU() - 3) + " bytes.");
    return;
  }
  recordTrace("write", peer.address, uuid, command.argument, command.data, command.length,
              command.mode ? "Write request with response" : "Write request without response", true, peer.provenance);
  if (!characteristic->writeValue(command.data, command.length, command.mode == 1)) {
    failOperation(peer, uuid, command.argument, "GATT write failed (BLE code " + String(client->getLastError()) + "). Check the connection, permissions, and selected write mode.");
    return;
  }
  recordTrace("write-result", peer.address, uuid, command.argument, nullptr, 0,
              command.mode ? "Write acknowledged" : "Write submitted without response", true, peer.provenance);
}

static void subscribeCharacteristic(NimBLERemoteCharacteristic* characteristic, const Command& command,
                                    const TracePeer& peer, const String& uuid) {
  if (command.mode > 2 || (command.mode == 1 && !characteristic->canNotify()) ||
      (command.mode == 2 && !characteristic->canIndicate())) {
    failOperation(peer, uuid, command.argument, "The selected subscription mode is unavailable.");
    return;
  }
  if (!characteristic->getDescriptor(NimBLEUUID(uint16_t(0x2902)))) {
    failOperation(peer, uuid, command.argument, "Subscription requires a client configuration descriptor (0x2902), which was not found.");
    return;
  }
  const char* mode = SubscriptionModes[command.mode];
  const uint16_t handle = characteristic->getHandle();
  const auto callback = [peer, uuid, handle](NimBLERemoteCharacteristic*, uint8_t* data, size_t length, bool isNotify) {
    notificationReceived(peer, uuid, handle, data, length, isNotify);
  };
  recordTrace("subscribe", peer.address, uuid, command.argument, nullptr, 0, String("Subscription requested: ") + mode, true, peer.provenance);
  bool success = command.mode ? characteristic->subscribe(command.mode == 1, callback, true) : characteristic->unsubscribe(true);
  if (!success) {
    failOperation(peer, uuid, command.argument, "Subscription update failed. The device rejected the request or disconnected.");
    return;
  }
  {
    StateLock lock;
    auto entry = state.connected && peer.matches(state.address.c_str(), state.addressType, state.connectionAttempt) ? findEntry(command.argument) : nullptr;
    if (entry) entry->subscription = command.mode;
  }
  recordTrace("subscribe-result", peer.address, uuid, command.argument, nullptr, 0, String("Subscription active: ") + mode, true, peer.provenance);
}

static int onAttributeRead(uint16_t, const ble_gatt_error* error, ble_gatt_attr* attr, void* arg) {
  auto& task = *static_cast<NimBLETaskData*>(arg);
  auto& value = *static_cast<std::string*>(task.m_pBuf);
  if (!error->status && attr) {
    for (const os_mbuf* om = attr->om; om; om = SLIST_NEXT(om, om_next)) {
      if (om->om_len > BLE_ATT_ATTR_MAX_LEN - value.size()) {
        const int result = BLE_HS_ATT_ERR(BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN);
        NimBLEUtils::taskRelease(task, result);
        return result;
      }
      value.append(reinterpret_cast<const char*>(om->om_data), om->om_len);
    }
    return 0;
  }
  // A value exactly one MTU long ends with a blob read some servers reject; the first chunk is the whole value.
  const bool complete = error->status == BLE_HS_EDONE || (!value.empty() &&
    (error->status == BLE_HS_ATT_ERR(BLE_ATT_ERR_ATTR_NOT_LONG) || error->status == BLE_HS_ATT_ERR(BLE_ATT_ERR_INVALID_OFFSET)));
  NimBLEUtils::taskRelease(task, complete ? 0 : error->status);
  return 0;
}

int readAttribute(NimBLEClient* client, uint16_t handle, std::string& value) {
  value.clear();
  NimBLETaskData task(nullptr, 0, &value);
  const int rc = ble_gattc_read_long(client->getConnHandle(), handle, 0, onAttributeRead, &task);
  if (rc) return rc;
  NimBLEUtils::taskWait(task, BLE_NPL_TIME_FOREVER);
  return task.m_flags;
}

static void readDescriptor(NimBLEClient* client, const TracePeer& peer, uint16_t handle) {
  String uuid;
  { StateLock lock; if (auto descriptor = findDescriptor(handle)) uuid = descriptor->uuid; }
  std::string value;
  const int rc = readAttribute(client, handle, value);
  const auto data = reinterpret_cast<const uint8_t*>(value.data());
  if (rc) { failOperation(peer, uuid, handle, readError(rc)); return; }
  updateValue(handle, data, value.size(), "", &peer);
  recordTrace("read", peer.address, uuid, handle, data, value.size(), "", true, peer.provenance);
}

void executeGatt(NimBLEClient* client, const Command& command, const TracePeer& peer) {
  if (!client->isConnected()) {
    failOperation(peer, "", command.argument, "Device disconnected before the GATT operation.");
    return;
  }
  bool descriptor;
  { StateLock lock; descriptor = !findEntry(command.argument) && findDescriptor(command.argument); }
  if (descriptor && command.action == Action::Read) { readDescriptor(client, peer, command.argument); return; }
  auto characteristic = client->getCharacteristic(command.argument);
  if (!characteristic) {
    failOperation(peer, "", command.argument, "Characteristic is no longer available. Reconnect and inspect again.");
    return;
  }
  const String uuid = characteristic->getUUID().toString().c_str();
  switch (command.action) {
    case Action::Read:
      if (characteristic->canRead()) readCharacteristic(characteristic, peer, uuid);
      else failOperation(peer, uuid, command.argument, "This characteristic is no longer readable.");
      break;
    case Action::Write: writeCharacteristic(client, characteristic, command, peer, uuid); break;
    case Action::Subscribe: subscribeCharacteristic(characteristic, command, peer, uuid); break;
    default: failOperation(peer, uuid, command.argument, "Unsupported GATT operation.");
  }
}
