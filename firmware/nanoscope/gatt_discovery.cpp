#include "gatt.h"
#include "trace.h"

static bool discoveryReady(NimBLEClient* client, String& error) {
  if (connectionCancellationRequested()) { error = "Connection cancelled."; return false; }
  if (!client->isConnected()) {
    error = "Device disconnected during GATT discovery.";
    return false;
  }
  if (ESP.getFreeHeap() < 65536) {
    error = "GATT discovery stopped because device memory is low. The available results are shown.";
    return false;
  }
  return true;
}

static CharacteristicInfo characteristicInfo(NimBLERemoteCharacteristic* characteristic) {
  CharacteristicInfo result;
  result.uuid = characteristic->getUUID().toString().c_str();
  result.handle = characteristic->getHandle();
  if (characteristic->canRead()) result.properties |= GattRead;
  if (characteristic->canWrite()) result.properties |= GattWrite;
  if (characteristic->canWriteNoResponse()) result.properties |= GattWriteNoResponse;
  if (characteristic->canNotify()) result.properties |= GattNotify;
  if (characteristic->canIndicate()) result.properties |= GattIndicate;
  if (characteristic->canBroadcast()) result.properties |= GattBroadcast;
  if (characteristic->canWriteSigned()) result.properties |= GattSignedWrite;
  if (characteristic->hasExtendedProps()) result.properties |= GattExtended;
  return result;
}

// Name, appearance, battery, Device Information strings and characteristic user descriptions.
static const char* identityUuid(const String& uuid) {
  static const char* const uuids[] = {"0x2a00", "0x2a01", "0x2a19", "0x2a24", "0x2a25", "0x2a26", "0x2a27", "0x2a28", "0x2a29", "0x2a50", "0x2901"};
  for (auto candidate : uuids) if (uuid == candidate) return candidate;
  return nullptr;
}

void discoverGatt(NimBLEClient* client, const TracePeer& peer, bool recorderOnly, bool identify) {
  String error;
  size_t serviceCount = 0, characteristicCount = 0, descriptorCount = 0, identityCount = 0;
  std::vector<std::pair<uint16_t, const char*>> identity;
  const auto wantIdentity = [&](const String& uuid, uint16_t handle) {
    const char* match = identify && identity.size() < 32 ? identityUuid(uuid) : nullptr;
    if (match) identity.emplace_back(handle, match);
  };
  {
    StateLock lock;
    std::vector<ServiceInfo>().swap(state.services);
    state.mtu = client->getMTU();
  }
  if (discoveryReady(client, error)) {
    recordTrace("discovery-progress", peer.address, "", 0, nullptr, 0, recorderOnly ? "Discovering PLAUD service 0x1910" : "Discovering all services", true, peer.provenance);
    if (recorderOnly && !client->getService(NimBLEUUID(uint16_t(0x1910)))) error = "PLAUD recorder service 0x1910 was not found.";
    if (error.isEmpty() && discoveryReady(client, error)) {
      const auto& services = client->getServices(!recorderOnly);
      for (auto service : services) {
        if (!error.isEmpty() || !discoveryReady(client, error)) break;
        ServiceInfo info;
        info.uuid = service->getUUID().toString().c_str();
        recordTrace("discovery-progress", peer.address, info.uuid, 0, nullptr, 0, "Discovering characteristics", true, peer.provenance);
        const auto& characteristics = service->getCharacteristics(true);
        if (!discoveryReady(client, error)) break;
        info.characteristics.reserve(characteristics.size());
        for (auto characteristic : characteristics) {
          if (!discoveryReady(client, error)) break;
          CharacteristicInfo entry = characteristicInfo(characteristic);
          if (entry.properties & GattRead) wantIdentity(entry.uuid, entry.handle);
          const auto& descriptors = characteristic->getDescriptors(true);
          if (discoveryReady(client, error)) entry.descriptors.reserve(descriptors.size());
          for (auto descriptor : descriptors) {
            if (!discoveryReady(client, error)) break;
            DescriptorInfo detail;
            detail.uuid = descriptor->getUUID().toString().c_str();
            // NimBLE ends each descriptor search at the next characteristic's declaration, so drop it.
            if (detail.uuid == "0x2803") continue;
            detail.handle = descriptor->getHandle();
            wantIdentity(detail.uuid, detail.handle);
            entry.descriptors.push_back(std::move(detail));
            ++descriptorCount;
          }
          characteristic->deleteDescriptors();
          info.characteristics.push_back(std::move(entry));
          ++characteristicCount;
          if (error.length()) break;
        }
        {
          StateLock lock;
          if (state.connected) {
            state.services.push_back(std::move(info));
            ++serviceCount;
          }
        }
        if (error.length()) break;
      }
    }
    for (const auto& [handle, uuid] : identity) {
      if (!error.isEmpty() || !discoveryReady(client, error)) break;
      std::string value;
      if (readAttribute(client, handle, value)) continue;  // Left unread; a manual Read can still pair if the device needs it.
      const auto data = reinterpret_cast<const uint8_t*>(value.data());
      updateValue(handle, data, value.size(), "", &peer);
      recordTrace("read", peer.address, uuid, handle, data, value.size(), "Identity read after discovery", true, peer.provenance);
      ++identityCount;
    }
    if (!client->isConnected()) error = "Device disconnected during GATT discovery.";
    else if (!serviceCount && !error.length()) error = "Connected, but GATT service discovery returned no services.";
  }
  {
    StateLock lock;
    state.mtu = client->getMTU();
    if (error.length()) state.error = error;
  }
  String message = error.length() ? error : String(serviceCount) + " services, " +
    String(characteristicCount) + " characteristics, " + String(descriptorCount) + " descriptors";
  if (identify && error.isEmpty()) message += ", " + String(identityCount) + " identity values";
  recordTrace(error.length() ? "error" : "discovery", peer.address, "", 0, nullptr, 0, message, !error.length(), peer.provenance);
}
