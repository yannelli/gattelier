#include "scan_stream.h"
#include "scan_retention.h"
#include "scan_encoding.h"
#include "collection.h"
#include "board_server.h"
#include <esp_random.h>
#include <algorithm>

static ScanJournal<ScanJournalCapacity> journal;
static String bootId;
static uint32_t nextId = 1;
static uint64_t evicted = 0;
static uint64_t cacheSkipped = 0;
static ScanOffloadLease offloadLease;

void startScanStream() { if (bootId.isEmpty()) bootId = String(esp_random(), HEX); }

static size_t textBytes(const String& value) { return ((value.length() + 16) & ~size_t(15)) + 16; }

static size_t deviceBytes(const DeviceInfo& device) {
  size_t bytes = sizeof(DeviceInfo) + textBytes(device.address) + textBytes(device.name) + textBytes(device.manufacturer) + textBytes(device.payloadHex);
  bytes += device.services.capacity() * sizeof(String) + device.serviceData.capacity() * sizeof(ServiceDataInfo);
  if (device.services.capacity()) bytes += 16;
  if (device.serviceData.capacity()) bytes += 16;
  for (const auto& uuid : device.services) bytes += textBytes(uuid);
  for (const auto& data : device.serviceData) bytes += textBytes(data.uuid) + textBytes(data.hex);
  return bytes;
}

static size_t cacheBytes() {
  size_t bytes = (state.devices.capacity() - state.devices.size()) * sizeof(DeviceInfo) + (state.devices.capacity() ? 16 : 0);
  for (const auto& device : state.devices) bytes += deviceBytes(device);
  return bytes;
}

static String uuidFrom(const uint8_t* bytes, size_t size) {
  if (size == 2) return "0x" + hexBytes(bytes + 1, 1) + hexBytes(bytes, 1);
  if (size == 4) {
    uint8_t reversed[4]; for (size_t i = 0; i < 4; ++i) reversed[i] = bytes[3 - i];
    return "0x" + hexBytes(reversed, 4);
  }
  uint8_t reversed[16]; for (size_t i = 0; i < 16; ++i) reversed[i] = bytes[15 - i];
  String raw = hexBytes(reversed, 16);
  return raw.substring(0, 8) + "-" + raw.substring(8, 12) + "-" + raw.substring(12, 16) + "-" + raw.substring(16, 20) + "-" + raw.substring(20);
}

static DeviceInfo deviceFrom(const ScanAdvertisement& record) {
  DeviceInfo device;
  device.id = record.id; device.address = record.address; device.name = record.name; device.addressType = record.addressType;
  device.rssi = record.rssi; device.connectable = record.connectable; device.lastSeen = record.ms / 1000;
  device.advType = record.advType; device.hasTxPower = record.hasTxPower; device.txPower = record.txPower;
  device.payloadHex = hexBytes(record.payload, record.length());
  for (size_t at = 0; at < record.length();) {
    const size_t length = record.payload[at++];
    if (!length || at + length > record.length()) break;
    const uint8_t type = record.payload[at]; const uint8_t* data = record.payload + at + 1; const size_t size = length - 1;
    if (type == 0xff && device.manufacturer.isEmpty()) device.manufacturer = hexBytes(data, size);
    size_t width = type == 2 || type == 3 ? 2 : type == 4 || type == 5 ? 4 : type == 6 || type == 7 ? 16 : 0;
    for (size_t pos = 0; width && pos + width <= size && device.services.size() < 8; pos += width) device.services.push_back(uuidFrom(data + pos, width));
    width = type == 0x16 ? 2 : type == 0x20 ? 4 : type == 0x21 ? 16 : 0;
    if (width && size >= width && device.serviceData.size() < 8) device.serviceData.push_back({uuidFrom(data, width), hexBytes(data + width, size - width)});
    at += length;
  }
  return device;
}

void recordAdvertisement(const NimBLEAdvertisedDevice* advertised) {
  ScanAdvertisement record;
  // Same text as NimBLEAddress::toString(), without its two heap copies per advertisement.
  const auto address = advertised->getAddress(); const uint8_t* bytes = address.getVal();
  snprintf(record.address, sizeof(record.address), "%02x:%02x:%02x:%02x:%02x:%02x", bytes[5], bytes[4], bytes[3], bytes[2], bytes[1], bytes[0]);
  record.addressType = advertised->getAddressType();
  const auto& payload = advertised->getPayload();
  record.payloadBytes = std::min(payload.size(), size_t(UINT16_MAX));
  memcpy(record.payload, payload.data(), std::min(payload.size(), ScanPayloadCapacity));
  if (advertised->haveName()) { const auto name = advertised->getName(); memcpy(record.name, name.data(), std::min(name.size(), sizeof(record.name) - 1)); }
  record.ms = millis(); record.rssi = advertised->getRSSI(); record.connectable = advertised->isConnectable(); record.advType = advertised->getAdvType();
  record.hasTxPower = advertised->haveTXPower(); record.txPower = record.hasTxPower ? advertised->getTXPower() : 0;
  if (offloadLease.active(record.ms, collectionEnabled())) {
    record.id = nextId++; if (!nextId) ++nextId;
    journal.append(record); ++cacheSkipped; return;
  }
  auto found = std::find_if(state.devices.begin(), state.devices.end(), [&](const DeviceInfo& device) { return device.address == record.address && device.addressType == record.addressType; });
  record.id = found == state.devices.end() ? nextId++ : found->id;
  if (!nextId) ++nextId;
  if (found != state.devices.end() && !record.name[0]) strncpy(record.name, found->name.c_str(), sizeof(record.name) - 1);
  journal.append(record);
  if (ESP.getFreeHeap() < 98304) { evicted += state.devices.size(); state.devices.clear(); state.devices.shrink_to_fit(); return; }
  if (found != state.devices.end()) {
    if (scanPayloadMatches(record, found->payloadHex.c_str(), found->payloadHex.length())) {
      found->rssi = record.rssi; found->lastSeen = record.ms / 1000;
      found->connectable = record.connectable; found->advType = record.advType;
      found->hasTxPower = record.hasTxPower; found->txPower = record.txPower;
      if (found->name != record.name) {
        found->name = record.name;
        while (!state.devices.empty() && cacheBytes() > ScanCacheLimitBytes) { eraseScanCache(0); ++evicted; }
      }
      return;
    }
    eraseScanCache(size_t(found - state.devices.begin()));
  }
  DeviceInfo device = deviceFrom(record); const size_t incoming = deviceBytes(device);
  while (!state.devices.empty() && !scanCacheFits(state.devices.size(), cacheBytes(), incoming)) {
    const auto oldest = std::min_element(state.devices.begin(), state.devices.end(), [](const DeviceInfo& left, const DeviceInfo& right) { return left.lastSeen < right.lastSeen || (left.lastSeen == right.lastSeen && left.id < right.id); });
    eraseScanCache(size_t(oldest - state.devices.begin())); ++evicted;
  }
  if (scanCacheFits(state.devices.size(), cacheBytes(), incoming)) state.devices.push_back(std::move(device));
  while (!state.devices.empty() && cacheBytes() > ScanCacheLimitBytes) { eraseScanCache(0); ++evicted; }
}

void clearScanCache() { state.devices.clear(); state.devices.shrink_to_fit(); }

void eraseScanCache(size_t index) {
  eraseScanCacheEntry(state.devices, index);
}

void addScanStreamState(cJSON* ble) {
  startScanStream();
  cJSON_AddBoolToObject(ble, "advertisementStream", true);
  cJSON_AddNumberToObject(ble, "scanCacheSize", state.devices.size());
  cJSON_AddNumberToObject(ble, "scanCacheCapacity", ScanCacheCapacity);
  cJSON_AddNumberToObject(ble, "scanCacheBytes", cacheBytes());
  cJSON_AddNumberToObject(ble, "scanCacheLimitBytes", ScanCacheLimitBytes);
  cJSON_AddNumberToObject(ble, "scanCacheEvicted", double(evicted));
  cJSON_AddBoolToObject(ble, "browserOffload", offloadLease.active(millis(), collectionEnabled()));
  cJSON_AddNumberToObject(ble, "browserOffloadLeaseMs", ScanOffloadLeaseMs);
  cJSON_AddNumberToObject(ble, "scanCacheSkipped", double(cacheSkipped));
  cJSON_AddNumberToObject(ble, "advertisementCapacity", ScanJournalCapacity);
  cJSON_AddNumberToObject(ble, "advertisementJournalBytes", sizeof(journal));
  cJSON_AddNumberToObject(ble, "advertisementJournalLimitBytes", ScanJournalLimitBytes);
  cJSON_AddNumberToObject(ble, "advertisementsDropped", double(journal.overwritten()));
  cJSON_AddNumberToObject(ble, "advertisementsTruncated", double(journal.truncated()));
}

cJSON* scanDeviceJson(const DeviceInfo& device) {
  auto item = cJSON_CreateObject();
  cJSON_AddNumberToObject(item, "id", device.id); cJSON_AddStringToObject(item, "address", device.address.c_str()); cJSON_AddStringToObject(item, "name", device.name.c_str());
  cJSON_AddNumberToObject(item, "addressType", device.addressType); cJSON_AddNumberToObject(item, "rssi", device.rssi); cJSON_AddBoolToObject(item, "connectable", device.connectable);
  cJSON_AddBoolToObject(item, "remembered", device.remembered); cJSON_AddNumberToObject(item, "lastSeen", device.lastSeen);
  cJSON_AddStringToObject(item, "manufacturer", device.manufacturer.c_str()); cJSON_AddStringToObject(item, "payloadHex", device.payloadHex.c_str()); cJSON_AddNumberToObject(item, "advType", device.advType);
  if (device.hasTxPower) cJSON_AddNumberToObject(item, "txPower", device.txPower); else cJSON_AddNullToObject(item, "txPower");
  auto services = cJSON_AddArrayToObject(item, "services"); for (const auto& uuid : device.services) cJSON_AddItemToArray(services, cJSON_CreateString(uuid.c_str()));
  auto data = cJSON_AddArrayToObject(item, "serviceData");
  for (const auto& entry : device.serviceData) { auto value = cJSON_CreateObject(); cJSON_AddStringToObject(value, "uuid", entry.uuid.c_str()); cJSON_AddStringToObject(value, "hex", entry.hex.c_str()); cJSON_AddItemToArray(data, value); }
  return item;
}

void sendAdvertisements(BoardServer& server, uint64_t after, const String& expectedBoot, bool raw, bool compact, bool offload) {
  uint64_t end, oldest, dropped, overwritten, truncated; String header;
  {
    StateLock lock;
    startScanStream();
    if (raw && offload && !collectionEnabled()) {
      for (size_t index = 0; index < state.devices.size();) {
        const auto& device = state.devices[index];
        if ((state.connected || state.busy) && device.address == state.address && device.addressType == state.addressType) ++index;
        else eraseScanCache(index);
      }
      if (state.devices.capacity() != state.devices.size()) state.devices.shrink_to_fit();
      offloadLease.renew(millis());
    }
    const bool reset = !expectedBoot.isEmpty() && expectedBoot != bootId;
    if (reset) after = 0;
    end = journal.next(); oldest = journal.oldest(); dropped = journal.dropped(after); overwritten = journal.overwritten(); truncated = journal.truncated();
    header = "{\"bootId\":\"" + bootId + "\",\"reset\":" + (reset ? "true" : "false") + ",\"uptime\":" + String(millis() / 1000) + ",\"oldestSeq\":" + String(oldest) + ",\"nextSeq\":" + String(end) + ",\"cursor\":" + String(end) + ",\"capacity\":" + String(ScanJournalCapacity) + ",\"journalBytes\":" + String(sizeof(journal)) + ",\"cacheCapacity\":" + String(ScanCacheCapacity) + ",\"cacheBytes\":" + String(cacheBytes()) + ",\"cacheLimitBytes\":" + String(ScanCacheLimitBytes) + ",\"droppedTotal\":" + String(overwritten) + ",\"truncatedTotal\":" + String(truncated) + ",\"cacheIds\":[";
    for (size_t i = 0; i < state.devices.size(); ++i) { if (i) header += ','; header += String(state.devices[i].id); }
    header += "],\"browserOffload\":" + String(offloadLease.active(millis(), collectionEnabled()) ? "true" : "false") + ",\"offloadLeaseMs\":" + String(ScanOffloadLeaseMs) + ",\"cacheSkippedTotal\":" + String(cacheSkipped);
  }
  server.sendHeader("X-Content-Type-Options", "nosniff"); server.setContentLength(CONTENT_LENGTH_UNKNOWN); server.send(200, "application/json", "");
  String chunk; chunk.reserve(3072);
  const auto append = [&](const char* data) {
    size_t length = strlen(data);
    while (length) {
      const size_t count = std::min(length, size_t(3072) - chunk.length());
      chunk.concat(data, count); data += count; length -= count;
      if (chunk.length() == 3072) { server.sendContent(chunk); chunk = ""; }
    }
  };
  append(header.c_str()); append(raw ? compact ? ",\"format\":\"raw-v2\",\"devices\":[" : ",\"format\":\"raw-v1\",\"devices\":[" : ",\"devices\":["); bool first = true;
  const uint64_t begin = after >= end ? end + 1 : std::max(after + 1, oldest);
  for (uint64_t seq = begin; seq <= end; ++seq) {
    ScanAdvertisement record; bool available;
    { StateLock lock; available = journal.read(seq, record); }
    if (!available) { ++dropped; continue; }
    if (raw) {
      char encoded[ScanJsonCapacity];
      if (!rawAdvertisementJson(record, encoded, sizeof(encoded), compact)) { ++dropped; continue; }
      if (!first) append(","); append(encoded); first = false;
      continue;
    }
    auto json = scanDeviceJson(deviceFrom(record)); cJSON_AddNumberToObject(json, "seq", double(seq)); cJSON_AddNumberToObject(json, "ms", record.ms);
    cJSON_AddBoolToObject(json, "payloadTruncated", record.truncated()); cJSON_AddNumberToObject(json, "payloadBytes", record.payloadBytes);
    char* raw = cJSON_PrintUnformatted(json); cJSON_Delete(json);
    if (!raw) { ++dropped; continue; }
    if (!first) append(","); append(raw); first = false; cJSON_free(raw);
  }
  const String footer = "],\"dropped\":" + String(dropped) + "}"; append(footer.c_str());
  if (chunk.length()) server.sendContent(chunk);
  server.sendContent("");
}
