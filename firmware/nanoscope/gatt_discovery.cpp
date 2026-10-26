#include "gatt.h"
#include "trace.h"

static bool discoveryReady(NimBLEClient* client, String& error) {
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
  if (characteristic->canRead()) result.properties.emplace_back("read");
  if (characteristic->canWrite()) result.properties.emplace_back("write");
  if (characteristic->canWriteNoResponse()) result.properties.emplace_back("write-no-response");
  if (characteristic->canNotify()) result.properties.emplace_back("notify");
  if (characteristic->canIndicate()) result.properties.emplace_back("indicate");
  if (characteristic->canBroadcast()) result.properties.emplace_back("broadcast");
  if (characteristic->canWriteSigned()) result.properties.emplace_back("signed-write");
  if (characteristic->hasExtendedProps()) result.properties.emplace_back("extended-properties");
  return result;
}

void discoverGatt(NimBLEClient* client, bool recorderOnly) {
  const String address = client->getPeerAddress().toString().c_str();
  String error;
  size_t serviceCount = 0, characteristicCount = 0, descriptorCount = 0;
  {
    StateLock lock;
    state.services.clear();
    state.mtu = client->getMTU();
  }
  if (discoveryReady(client, error)) {
    recordTrace("discovery-progress", address, "", 0, nullptr, 0, recorderOnly ? "Discovering PLAUD service 0x1910" : "Discovering all services");
    if (recorderOnly && !client->getService(NimBLEUUID(uint16_t(0x1910)))) error = "PLAUD recorder service 0x1910 was not found.";
    const auto& services = client->getServices(!recorderOnly);
    for (auto service : services) {
      if (!discoveryReady(client, error)) break;
      ServiceInfo info;
      info.uuid = service->getUUID().toString().c_str();
      recordTrace("discovery-progress", address, info.uuid, 0, nullptr, 0, "Discovering characteristics");
      const auto& characteristics = service->getCharacteristics(true);
      for (auto characteristic : characteristics) {
        if (!discoveryReady(client, error)) break;
        CharacteristicInfo entry = characteristicInfo(characteristic);
        recordTrace("discovery-progress", address, entry.uuid, entry.handle, nullptr, 0, "Discovering descriptors");
        const auto& descriptors = characteristic->getDescriptors(true);
        for (auto descriptor : descriptors) {
          if (!discoveryReady(client, error)) break;
          DescriptorInfo detail;
          detail.uuid = descriptor->getUUID().toString().c_str();
          detail.handle = descriptor->getHandle();
          entry.descriptors.push_back(std::move(detail));
          ++descriptorCount;
        }
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
  recordTrace(error.length() ? "error" : "discovery", address, "", 0, nullptr, 0, message, !error.length());
}
