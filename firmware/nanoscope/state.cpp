#include "state.h"
#include "board_network.h"
#include "ble_security.h"
#include "usb_hci.h"
#include "collection.h"
#include <WiFi.h>
#include <cJSON.h>
#include <WebServer.h>
#include <algorithm>

AppState state;
SemaphoreHandle_t stateMutex;

String hexBytes(const uint8_t* bytes, size_t length) {
  const char* digits = "0123456789abcdef";
  String result;
  result.reserve(length * 2);
  for (size_t i = 0; i < length; ++i) {
    result += digits[bytes[i] >> 4];
    result += digits[bytes[i] & 15];
  }
  return result;
}

static void addText(cJSON* object, const char* key, const String& value) {
  cJSON_AddStringToObject(object, key, value.c_str());
}

static void addStrings(cJSON* object, const char* key, const std::vector<String>& values) {
  auto array = cJSON_AddArrayToObject(object, key);
  for (const auto& value : values) cJSON_AddItemToArray(array, cJSON_CreateString(value.c_str()));
}

static String jsonText(cJSON* value) {
  char* json = cJSON_PrintUnformatted(value);
  String result = json ? json : "null";
  cJSON_free(json);
  cJSON_Delete(value);
  return result;
}

void sendState(WebServer& server) {
  auto root = cJSON_CreateObject();
  auto wifi = cJSON_AddObjectToObject(root, "wifi");
  addNetworkState(wifi);
  addSecurityState(root);
  addUsbState(cJSON_AddObjectToObject(root, "usb"));
  cJSON_AddItemToObject(root, "collection", collectionState());
  cJSON_AddNumberToObject(root, "uptime", millis() / 1000);
  cJSON_AddNumberToObject(root, "freeHeap", ESP.getFreeHeap());
  std::vector<uint32_t> deviceIds;
  size_t serviceCount;
  {
    StateLock lock;
    auto ble = cJSON_AddObjectToObject(root, "ble");
    cJSON_AddBoolToObject(ble, "busy", state.busy);
    cJSON_AddBoolToObject(ble, "connected", state.connected);
    cJSON_AddBoolToObject(ble, "scanning", state.scanning);
    cJSON_AddBoolToObject(ble, "scanEnabled", state.scanEnabled);
    addText(ble, "operation", state.operation);
    addText(ble, "discoveryScope", state.discoveryScope);
    addText(ble, "address", state.address);
    addText(ble, "error", state.error);
    addText(ble, "captureAddress", state.captureAddress);
    cJSON_AddNumberToObject(ble, "mtu", state.mtu);
    cJSON_AddNumberToObject(ble, "addressType", state.addressType);
    cJSON_AddNumberToObject(ble, "connectionAttempt", state.connectionAttempt);
    cJSON_AddBoolToObject(root, "scanCompleted", state.scanCompleted);
    deviceIds.reserve(state.devices.size());
    for (const auto& device : state.devices) deviceIds.push_back(device.id);
    serviceCount = state.services.size();
  }
  String header = jsonText(root);
  header.remove(header.length() - 1);
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json", "");
  String chunk;
  chunk.reserve(4096);
  auto send = [&](const String& text) {
    if (chunk.length() + text.length() > 4096) {
      server.sendContent(chunk);
      chunk = "";
    }
    chunk += text;
  };
  send(header + ",\"devices\":[");
  bool first = true;
  for (uint32_t id : deviceIds) {
      DeviceInfo device;
      {
        StateLock lock;
        auto it = std::find_if(state.devices.begin(), state.devices.end(), [id](const DeviceInfo& d) { return d.id == id; });
        if (it == state.devices.end()) continue;
        device = *it;
      }
      auto item = cJSON_CreateObject();
      cJSON_AddNumberToObject(item, "id", device.id);
      addText(item, "address", device.address);
      addText(item, "name", device.name);
      cJSON_AddNumberToObject(item, "addressType", device.addressType);
      cJSON_AddNumberToObject(item, "rssi", device.rssi);
      cJSON_AddBoolToObject(item, "connectable", device.connectable);
      cJSON_AddBoolToObject(item, "remembered", device.remembered);
      cJSON_AddNumberToObject(item, "lastSeen", device.lastSeen);
      addText(item, "manufacturer", device.manufacturer);
      addText(item, "payloadHex", device.payloadHex);
      cJSON_AddNumberToObject(item, "advType", device.advType);
      if (device.hasTxPower) cJSON_AddNumberToObject(item, "txPower", device.txPower);
      else cJSON_AddNullToObject(item, "txPower");
      addStrings(item, "services", device.services);
      auto data = cJSON_AddArrayToObject(item, "serviceData");
      for (const auto& serviceData : device.serviceData) {
        auto entry = cJSON_CreateObject();
        addText(entry, "uuid", serviceData.uuid);
        addText(entry, "hex", serviceData.hex);
        cJSON_AddItemToArray(data, entry);
      }
      if (!first) send(",");
      send(jsonText(item));
      first = false;
  }
  send("],\"services\":[");
  for (size_t i = 0; i < serviceCount; ++i) {
      String uuid;
      size_t count;
      {
        StateLock lock;
        if (i >= state.services.size()) break;
        uuid = state.services[i].uuid;
        count = state.services[i].characteristics.size();
      }
      auto item = cJSON_CreateObject();
      addText(item, "uuid", uuid);
      String serviceHeader = jsonText(item);
      serviceHeader.remove(serviceHeader.length() - 1);
      if (i) send(",");
      send(serviceHeader + ",\"characteristics\":[");
      for (size_t j = 0; j < count; ++j) {
        CharacteristicInfo characteristic;
        {
          StateLock lock;
          if (i >= state.services.size() || j >= state.services[i].characteristics.size()) break;
          characteristic = state.services[i].characteristics[j];
        }
        auto value = cJSON_CreateObject();
        addText(value, "uuid", characteristic.uuid);
        cJSON_AddNumberToObject(value, "handle", characteristic.handle);
        addStrings(value, "properties", characteristic.properties);
        addText(value, "subscription", characteristic.subscription);
        auto descriptors = cJSON_AddArrayToObject(value, "descriptors");
        for (const auto& descriptor : characteristic.descriptors) {
          auto entry = cJSON_CreateObject();
          addText(entry, "uuid", descriptor.uuid);
          cJSON_AddNumberToObject(entry, "handle", descriptor.handle);
          cJSON_AddItemToArray(descriptors, entry);
        }
        if (characteristic.hasValue) {
          addText(value, "valueHex", characteristic.valueHex);
          addText(value, "valueText", characteristic.valueText);
        } else {
          cJSON_AddNullToObject(value, "valueHex");
          cJSON_AddNullToObject(value, "valueText");
        }
        addText(value, "readError", characteristic.readError);
        if (j) send(",");
        send(jsonText(value));
      }
      send("]}");
  }
  send("]}");
  server.sendContent(chunk);
  server.sendContent("");
}
