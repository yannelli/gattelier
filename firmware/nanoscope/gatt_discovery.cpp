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

void discoverGatt(NimBLEClient* client, bool recorderOnly) {
  const String address = client->getPeerAddress().toString().c_str();
  String error;
  size_t serviceCount = 0, characteristicCount = 0, descriptorCount = 0;
  {
    StateLock lock;
    std::vector<ServiceInfo>().swap(state.services);
    state.mtu = client->getMTU();
  }
  if (discoveryReady(client, error)) {
    recordTrace("discovery-progress", address, "", 0, nullptr, 0, recorderOnly ? "Discovering PLAUD service 0x1910" : "Discovering all services");
    if (recorderOnly && !client->getService(NimBLEUUID(uint16_t(0x1910)))) error = "PLAUD recorder service 0x1910 was not found.";
    if (error.isEmpty() && discoveryReady(client, error)) {
      const auto& services = client->getServices(!recorderOnly);
      for (auto service : services) {
        if (!error.isEmpty() || !discoveryReady(client, error)) break;
        ServiceInfo info;
        info.uuid = service->getUUID().toString().c_str();
        recordTrace("discovery-progress", address, info.uuid, 0, nullptr, 0, "Discovering characteristics");
        const auto& characteristics = service->getCharacteristics(true);
        if (!discoveryReady(client, error)) break;
        info.characteristics.reserve(characteristics.size());
        for (auto characteristic : characteristics) {
          if (!discoveryReady(client, error)) break;
          CharacteristicInfo entry = characteristicInfo(characteristic);
          const auto& descriptors = characteristic->getDescriptors(true);
          if (discoveryReady(client, error)) entry.descriptors.reserve(descriptors.size());
          for (auto descriptor : descriptors) {
            if (!discoveryReady(client, error)) break;
            DescriptorInfo detail;
            detail.uuid = descriptor->getUUID().toString().c_str();
            detail.handle = descriptor->getHandle();
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
