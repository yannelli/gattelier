#include "collection.h"
#include "state.h"
#include "usb_hci.h"
#include <SPIFFS.h>
#include <Preferences.h>
#include "board_server.h"
#include "http_access.h"
#include <esp_random.h>
#include <deque>

static portMUX_TYPE configMux = portMUX_INITIALIZER_UNLOCKED;
static CollectionConfig config;
static uint32_t epoch = 0, revision = 0, bootId = 0, nextSweep = 0, recordCount = 0, dropped = 0, writeErrors = 0;
static size_t logBytes = 0, cursor = 0;
static bool mounted = false, full = false, damaged = false, begun = false;
static bool persistenceReady = false, configSaved = false, savedEnabled = false, restored = false;
static Preferences preferences;
static String storageError, configError;
static std::deque<String> pending;
static constexpr const char* logPath = "/collection.ndjson";
static bool decodeConfig(const cJSON* json, CollectionConfig& next, String& error);

static cJSON* addConfig(cJSON* json, const CollectionConfig& current) {
  cJSON_AddBoolToObject(json, "enabled", current.enabled); cJSON_AddBoolToObject(json, "active", current.active);
  cJSON_AddNumberToObject(json, "intervalMs", current.intervalMs); cJSON_AddNumberToObject(json, "windowMs", current.windowMs);
  cJSON_AddNumberToObject(json, "periodMs", current.periodMs); cJSON_AddNumberToObject(json, "burstMs", current.burstMs);
  cJSON_AddStringToObject(json, "address", current.address); return json;
}

static bool persistConfig(const CollectionConfig& next, String& error) {
  auto json = cJSON_CreateObject(); cJSON_AddNumberToObject(json, "schemaVersion", 1); cJSON_AddItemToObject(json, "config", addConfig(cJSON_CreateObject(), next));
  char* encoded = cJSON_PrintUnformatted(json);
  const bool saved = persistenceReady && encoded && preferences.putString("config", encoded) == strlen(encoded);
  cJSON_free(encoded); cJSON_Delete(json);
  if (!saved) { error = configError = "Collection settings could not be saved. The previous configuration remains active."; return false; }
  configSaved = true; savedEnabled = next.enabled; configError = ""; return true;
}

static CollectionConfig readConfig() {
  portENTER_CRITICAL(&configMux); auto result = config; portEXIT_CRITICAL(&configMux); return result;
}

static void apply(const CollectionConfig& next) {
  portENTER_CRITICAL(&configMux); config = next; epoch = millis(); revision++; portEXIT_CRITICAL(&configMux);
  cursor = 0; nextSweep = 0;
}

bool collectionEnabled() { return readConfig().enabled; }

CollectionScanPlan collectionScanPlan(uint32_t now) {
  portENTER_CRITICAL(&configMux); auto current = config; auto started = epoch; auto version = revision; portEXIT_CRITICAL(&configMux);
  CollectionScanPlan plan; plan.revision = version;
  if (current.enabled) {
    plan.enabled = collectionBurstDue(current, now, started); plan.active = current.active;
    plan.intervalMs = current.intervalMs; plan.windowMs = current.windowMs;
  }
  return plan;
}

static void stopForError(const String& message) {
  storageError = message; auto next = readConfig(); next.enabled = false; apply(next);
}

static cJSON* record(const char* type) {
  auto item = cJSON_CreateObject();
  cJSON_AddNumberToObject(item, "version", 1); cJSON_AddStringToObject(item, "type", type);
  cJSON_AddNumberToObject(item, "bootId", bootId); cJSON_AddNumberToObject(item, "uptimeMs", millis());
  return item;
}

static void enqueue(cJSON* item) {
  char* text = cJSON_PrintUnformatted(item); cJSON_Delete(item);
  if (!text || strlen(text) > CollectionRecordLimit || pending.size() >= CollectionQueueLimit) dropped++;
  else pending.emplace_back(text);
  cJSON_free(text);
}

static void flush() {
  if (!mounted || damaged || pending.empty()) return;
  auto file = SPIFFS.open(logPath, FILE_APPEND);
  if (!file) { writeErrors++; stopForError("The collection log could not be opened. Export existing data and retry."); pending.clear(); return; }
  for (unsigned i = 0; i < 4 && !pending.empty(); ++i) {
    const String& line = pending.front();
    if (!collectionFits(logBytes, line.length()) || SPIFFS.totalBytes() - SPIFFS.usedBytes() < line.length() + 65536) {
      full = true; dropped += pending.size(); pending.clear(); stopForError("Collection storage is full. Download and clear the log to continue."); break;
    }
    size_t written = file.print(line); written += file.print('\n');
    logBytes += written;
    if (written != line.length() + 1) { writeErrors++; damaged = true; pending.clear(); stopForError("A log write was incomplete. Download and clear the log before continuing."); break; }
    recordCount++; pending.pop_front();
  }
  file.flush(); file.close();
}

static void inspectLog() {
  recordCount = 0; logBytes = 0; full = damaged = false;
  if (!SPIFFS.exists(logPath)) return;
  auto file = SPIFFS.open(logPath, FILE_READ);
  if (!file) { damaged = true; storageError = "The existing log could not be read."; return; }
  logBytes = file.size(); uint8_t buffer[256], last = '\n';
  while (file.available()) {
    size_t bytes = file.read(buffer, sizeof(buffer)); if (!bytes) break;
    for (size_t i = 0; i < bytes; ++i) if (buffer[i] == '\n') recordCount++;
    last = buffer[bytes - 1];
  }
  file.close(); damaged = logBytes && last != '\n'; full = logBytes >= CollectionLogLimit;
  if (damaged) storageError = "The previous log ends with an incomplete record. Download and clear it to continue.";
  else if (full) storageError = "Collection storage is full. Download and clear the log to continue.";
}

void startCollection(bool allowRun) {
  if (begun) return;
  begun = true; bootId = esp_random(); mounted = SPIFFS.begin(false, "/spiffs", 5);
  if (!mounted) storageError = "Onboard storage is not mounted. Initialize it explicitly in Collection setup.";
  else inspectLog();
  persistenceReady = preferences.begin("nanoscope-col", false);
  if (!persistenceReady) { configError = "Collection settings storage is unavailable. Collection remains stopped."; return; }
  String saved = preferences.getString("config", "");
  if (saved.isEmpty()) return;
  if (saved.length() > 512 || saved.indexOf("\\u0000") >= 0) { configError = "Saved collection settings are invalid. Apply the setup again."; return; }
  auto json = cJSON_Parse(saved.c_str());
  auto version = cJSON_GetObjectItemCaseSensitive(json, "schemaVersion"), value = cJSON_GetObjectItemCaseSensitive(json, "config");
  bool valid = cJSON_IsObject(json) && cJSON_GetArraySize(json) == 2 && cJSON_IsNumber(version) && version->valuedouble == 1 && cJSON_IsObject(value) && cJSON_GetArraySize(value) == 7;
  for (const char* key : {"enabled", "active", "intervalMs", "windowMs", "periodMs", "burstMs", "address"}) valid = valid && cJSON_GetObjectItemCaseSensitive(value, key);
  CollectionConfig next; String error;
  valid = valid && decodeConfig(value, next, error); cJSON_Delete(json);
  if (!valid) { configError = "Saved collection settings could not be restored. Apply the setup again."; return; }
  configSaved = restored = true; savedEnabled = next.enabled;
  if (next.enabled && (!allowRun || !mounted || full || damaged)) {
    next.enabled = false;
    configError = !allowRun ? "Saved collection is paused in USB controller mode. It resumes in workbench mode after restart." : "Saved collection stayed stopped because log storage is unavailable, full, or damaged.";
  }
  apply(next);
}

bool initializeCollectionStorage(String& error) {
  if (mounted) { error = "Storage is already mounted. Use Clear log to remove collection data."; return false; }
  if (!SPIFFS.format() || !SPIFFS.begin(false, "/spiffs", 5)) { error = storageError = "Storage initialization failed."; return false; }
  mounted = true; storageError = ""; inspectLog(); return true;
}

bool clearCollectionStorage(String& error) {
  if (collectionEnabled()) { error = "Stop collection before clearing its log."; return false; }
  if (!mounted) { error = "Initialize collection storage first."; return false; }
  if (SPIFFS.exists(logPath) && !SPIFFS.remove(logPath)) { error = "The collection log could not be cleared."; return false; }
  pending.clear(); recordCount = dropped = writeErrors = 0; logBytes = 0; full = damaged = false; storageError = ""; return true;
}

static bool decodeConfig(const cJSON* json, CollectionConfig& next, String& error) {
  if (!cJSON_IsObject(json)) { error = "Expected a collection configuration object."; return false; }
  const cJSON* item;
  cJSON_ArrayForEach(item, json) {
    const char* key = item->string;
    if (!strcmp(key, "enabled") || !strcmp(key, "active")) {
      if (!cJSON_IsBool(item)) { error = String(key) + " must be a boolean."; return false; }
      if (!strcmp(key, "enabled")) next.enabled = cJSON_IsTrue(item); else next.active = cJSON_IsTrue(item);
    } else if (!strcmp(key, "address")) {
      if (!cJSON_IsString(item) || strlen(item->valuestring) >= sizeof(next.address)) { error = "Enter a full Bluetooth address or leave it blank."; return false; }
      strncpy(next.address, item->valuestring, sizeof(next.address));
      for (char& letter : next.address) letter = tolower(static_cast<unsigned char>(letter));
    } else {
      bool scan = !strcmp(key, "intervalMs") || !strcmp(key, "windowMs");
      bool schedule = !strcmp(key, "periodMs") || !strcmp(key, "burstMs");
      if (!scan && !schedule) { error = "Unknown collection setting."; return false; }
      double value = item->valuedouble;
      if (!jsonInteger(item, 0, scan ? 10240 : 3600000)) { error = String(key) + " must be a whole number in range."; return false; }
      if (!strcmp(key, "intervalMs")) next.intervalMs = value;
      if (!strcmp(key, "windowMs")) next.windowMs = value;
      if (!strcmp(key, "periodMs")) next.periodMs = value;
      if (!strcmp(key, "burstMs")) next.burstMs = value;
    }
  }
  if (const char* invalid = validateCollection(next)) { error = invalid; return false; }
  return true;
}

bool configureCollection(const cJSON* json, String& error) {
  auto next = readConfig();
  if (!decodeConfig(json, next, error)) return false;
  if (next.enabled && usbHciMode()) { error = "Restore Bluetooth workbench mode before starting collection."; return false; }
  if (next.enabled && (!mounted || full || damaged)) { error = storageError.length() ? storageError : "Initialize collection storage before starting."; return false; }
  if (!persistConfig(next, error)) return false;
  if (mounted && !full && !damaged) storageError = "";
  apply(next);
  if (mounted && !full && !damaged) {
    enqueue(addConfig(record("collection_config"), next));
  }
  return true;
}

void collectionToggle() {
  auto json = cJSON_CreateObject(); cJSON_AddBoolToObject(json, "enabled", !collectionEnabled()); String error;
  if (!configureCollection(json, error)) storageError = error;
  cJSON_Delete(json);
}

void updateCollection() {
  if (!begun) return;
  const auto current = readConfig(); const uint32_t now = millis();
  if (current.enabled && collectionScanPlan(now).enabled && int32_t(now - nextSweep) >= 0) {
    DeviceInfo device; bool found = false;
    {
      StateLock lock;
      if (state.scanning && !state.connected && !state.busy) {
        if (cursor < state.devices.size()) { device = state.devices[cursor++]; found = true; }
        else { cursor = 0; nextSweep = now + 1000; }
      }
    }
    if (found && now / 1000 - device.lastSeen <= 2 && (!current.address[0] || device.address == current.address)) {
      auto item = record("advertisement");
      cJSON_AddStringToObject(item, "address", device.address.c_str()); cJSON_AddNumberToObject(item, "addressType", device.addressType);
      cJSON_AddStringToObject(item, "name", device.name.c_str()); cJSON_AddNumberToObject(item, "rssi", device.rssi);
      cJSON_AddNumberToObject(item, "lastSeenSeconds", device.lastSeen); cJSON_AddBoolToObject(item, "connectable", device.connectable);
      cJSON_AddNumberToObject(item, "advType", device.advType); cJSON_AddStringToObject(item, "manufacturer", device.manufacturer.c_str());
      cJSON_AddStringToObject(item, "payloadHex", device.payloadHex.substring(0, 1024).c_str());
      cJSON_AddBoolToObject(item, "payloadTruncated", device.payloadHex.length() > 1024);
      auto services = cJSON_AddArrayToObject(item, "services");
      for (const auto& uuid : device.services) cJSON_AddItemToArray(services, cJSON_CreateString(uuid.c_str()));
      enqueue(item);
    }
  }
  flush();
}

cJSON* collectionState() {
  const auto current = readConfig(); auto json = addConfig(cJSON_CreateObject(), current);
  bool connected, busy, scanning; { StateLock lock; connected = state.connected; busy = state.busy; scanning = state.scanning; }
  const char* status = !current.enabled ? "stopped" : connected ? "paused-connected" : busy ? "paused-busy" : !collectionScanPlan(millis()).enabled ? "scheduled" : scanning ? "collecting" : "starting";
  cJSON_AddStringToObject(json, "status", status);
  cJSON_AddNumberToObject(json, "bootId", bootId);
  cJSON_AddBoolToObject(json, "persistenceReady", persistenceReady); cJSON_AddBoolToObject(json, "configSaved", configSaved);
  cJSON_AddBoolToObject(json, "savedEnabled", savedEnabled); cJSON_AddBoolToObject(json, "restored", restored);
  cJSON_AddStringToObject(json, "configError", configError.c_str());
  cJSON_AddBoolToObject(json, "storageReady", mounted); cJSON_AddBoolToObject(json, "full", full); cJSON_AddBoolToObject(json, "damaged", damaged);
  cJSON_AddNumberToObject(json, "recordCount", recordCount); cJSON_AddNumberToObject(json, "bytes", logBytes);
  cJSON_AddNumberToObject(json, "limitBytes", CollectionLogLimit); cJSON_AddNumberToObject(json, "queued", pending.size());
  cJSON_AddNumberToObject(json, "dropped", dropped); cJSON_AddNumberToObject(json, "writeErrors", writeErrors);
  cJSON_AddNumberToObject(json, "freeBytes", mounted ? SPIFFS.totalBytes() - SPIFFS.usedBytes() : 0);
  cJSON_AddStringToObject(json, "error", storageError.c_str()); return json;
}

uint32_t collectionLedColor(uint32_t base, uint32_t now) { return collectionColor(collectionEnabled(), storageError.length(), base, now); }

void downloadCollection(BoardServer& server) {
  flush();
  if (!mounted || !SPIFFS.exists(logPath)) { sendJsonError(server, 404, "No saved collection log."); return; }
  auto file = SPIFFS.open(logPath, FILE_READ);
  if (!file) { sendJsonError(server, 500, "The collection log could not be opened."); return; }
  server.sendHeader("Content-Disposition", "attachment; filename=nanoscope-collection.ndjson");
  server.streamFile(file, "application/x-ndjson"); file.close();
}
