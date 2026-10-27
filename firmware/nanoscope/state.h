#pragma once
#include <Arduino.h>
#include <vector>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include "gatt_properties.h"

struct ServiceDataInfo { String uuid, hex; };

struct DeviceInfo {
  uint32_t id = 0;
  String address, name, manufacturer, payloadHex;
  uint8_t addressType = 0;
  uint8_t advType = 0;
  int rssi = 0;
  int txPower = 0;
  bool hasTxPower = false;
  bool connectable = false;
  bool remembered = false;
  uint32_t lastSeen = 0;
  std::vector<String> services;
  std::vector<ServiceDataInfo> serviceData;
};

struct DescriptorInfo { String uuid; uint16_t handle = 0; };

struct CharacteristicInfo {
  String uuid, valueHex, valueText, readError;
  uint16_t handle = 0;
  bool hasValue = false;
  uint8_t subscription = 0;
  uint8_t properties = 0;
  std::vector<DescriptorInfo> descriptors;
};

struct ServiceInfo {
  String uuid;
  std::vector<CharacteristicInfo> characteristics;
};

struct AppState {
  bool busy = false, connected = false, scanCompleted = false;
  bool scanning = false, scanEnabled = true;
  String operation = "idle", address, error;
  String discoveryScope = "all services";
  uint16_t mtu = 23;
  uint32_t connectionAttempt = 0;
  uint8_t addressType = 0;
  String captureAddress;
  std::vector<DeviceInfo> devices;
  std::vector<ServiceInfo> services;
};

extern AppState state;
extern SemaphoreHandle_t stateMutex;

class StateLock {
 public:
  StateLock() { xSemaphoreTake(stateMutex, portMAX_DELAY); }
  ~StateLock() { xSemaphoreGive(stateMutex); }
};

enum class Action { Scan, StopScan, Connect, Disconnect, Read, Write, Subscribe, Pair };
struct Command {
  Action action;
  uint32_t argument = 0;
  uint16_t length = 0;
  uint8_t data[512] = {};
  uint8_t mode = 0;
  uint32_t connectionAttempt = 0;
};

void startBle();
bool queueCommand(Command& command, String& error);
bool cancelConnection(const String& address, uint8_t addressType, uint32_t attempt, String& error);
bool connectionCancellationRequested();
void updateConnectionCancellation();
class BoardServer;
void sendState(BoardServer& server);
String hexBytes(const uint8_t* bytes, size_t length);
struct cJSON;
// Prints and deletes the item.
String jsonText(cJSON* value);
void startHttp();
void handleHttp();
void handleSerialHttp();
void setHttpEnabled(bool enabled);
