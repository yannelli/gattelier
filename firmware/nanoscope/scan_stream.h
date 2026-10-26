#pragma once
#include "state.h"
#include <NimBLEDevice.h>
#include <cJSON.h>

void startScanStream();
void recordAdvertisement(const NimBLEAdvertisedDevice* advertised);
void clearScanCache();
void eraseScanCache(size_t index);
void addScanStreamState(cJSON* ble);
cJSON* scanDeviceJson(const DeviceInfo& device);
void sendAdvertisements(BoardServer& server, uint64_t after, const String& bootId, bool raw = false, bool compact = false, bool offload = false);
