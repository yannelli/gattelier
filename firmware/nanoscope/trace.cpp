#include "trace.h"
#include "trace_retention.h"
#include "state.h"
#include "activity_led.h"
#include <WebServer.h>
#include <cJSON.h>
#include <esp_random.h>
#include <array>
#include <algorithm>
#include <optional>

static std::array<std::optional<TraceEvent>, 256> events;
static TraceRetention<256, 48 * 1024> retention;
static SemaphoreHandle_t traceMutex;
static uint32_t sequence = 0;
static String bootId;

void startTrace() {
  traceMutex = xSemaphoreCreateMutex();
  if (!traceMutex) abort();
  bootId = String(esp_random(), HEX);
}

void recordTrace(const String& kind, const String& address, const String& uuid,
                 uint16_t handle, const uint8_t* data, size_t length,
                 const String& message, bool success) {
  if (kind == "read" || kind == "write" || kind == "notification" || kind == "indication" ||
      kind == "connect" || kind == "disconnect" || kind == "mtu" || kind == "subscribe-result") signalActivityLed();
  TraceEvent event;
  event.ms = millis();
  event.kind = kind;
  event.address = address;
  event.uuid = uuid;
  event.handle = handle;
  event.length = length;
  event.success = success;
  event.truncated = length > 512;
  event.message = message;
  if (data && length >= 7 && memcmp(data, "APP&SK&", 7) == 0) {
    event.message = "Pocket session key sent (redacted)";
    event.redacted = true;
  } else if (data && length >= 4 && data[0] == 0x10 && data[1] == 0xfe &&
             (uuid == "0x2bb1" || uuid == "00002bb1-0000-1000-8000-00805f9b34fb")) {
    event.message = "PLAUD authentication signature sent (redacted)";
    event.redacted = true;
  } else if (data && kind == "write" &&
             (uuid == "f8083535-849e-531c-c594-30f1f86a4ea5" || uuid == "f8083538-849e-531c-c594-30f1f86a4ea5")) {
    event.message = "Dexcom authentication payload sent (redacted)";
    event.redacted = true;
  } else if (data) {
    event.hex = hexBytes(data, std::min(length, size_t(512)));
  }
  xSemaphoreTake(traceMutex, portMAX_DELAY);
  const size_t cost = event.hex.length() + event.kind.length() + event.address.length() + event.uuid.length() + event.message.length() + 80;
  while (!retention.empty() && !retention.room(cost)) {
    events[(retention.first - 1) % events.size()].reset();
    retention.discard();
  }
  retention.append(cost);
  event.seq = ++sequence;
  events[(sequence - 1) % events.size()].emplace(std::move(event));
  xSemaphoreGive(traceMutex);
}

static String eventJson(const TraceEvent& event) {
  auto item = cJSON_CreateObject();
  cJSON_AddNumberToObject(item, "seq", event.seq);
  cJSON_AddNumberToObject(item, "ms", event.ms);
  cJSON_AddStringToObject(item, "kind", event.kind.c_str());
  cJSON_AddStringToObject(item, "address", event.address.c_str());
  cJSON_AddStringToObject(item, "uuid", event.uuid.c_str());
  cJSON_AddNumberToObject(item, "handle", event.handle);
  cJSON_AddStringToObject(item, "hex", event.hex.c_str());
  cJSON_AddStringToObject(item, "message", event.message.c_str());
  cJSON_AddNumberToObject(item, "length", event.length);
  cJSON_AddBoolToObject(item, "success", event.success);
  cJSON_AddBoolToObject(item, "truncated", event.truncated);
  cJSON_AddBoolToObject(item, "redacted", event.redacted);
  char* raw = cJSON_PrintUnformatted(item);
  String result = raw ? raw : "null";
  cJSON_free(raw);
  cJSON_Delete(item);
  return result;
}

void sendTrace(WebServer& server, uint32_t after) {
  xSemaphoreTake(traceMutex, portMAX_DELAY);
  uint32_t end = sequence;
  uint32_t oldest = retention.first;
  xSemaphoreGive(traceMutex);
  uint32_t begin = std::max(after + 1, oldest);
  uint32_t dropped = after < oldest - 1 ? oldest - 1 - after : 0;
  server.sendHeader("Cache-Control", "no-store");
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json", "");
  String chunk = "{\"bootId\":\"" + bootId + "\",\"oldestSeq\":" + String(oldest) +
    ",\"nextSeq\":" + String(end) + ",\"events\":[";
  bool first = true;
  for (uint32_t seq = begin; seq <= end && seq > 0; ++seq) {
    xSemaphoreTake(traceMutex, portMAX_DELAY);
    const auto& slot = events[(seq - 1) % events.size()];
    TraceEvent event = slot ? *slot : TraceEvent{};
    xSemaphoreGive(traceMutex);
    if (event.seq != seq) { ++dropped; continue; }
    if (!first) chunk += ',';
    chunk += eventJson(event);
    first = false;
    if (chunk.length() > 3072) { server.sendContent(chunk); chunk = ""; }
  }
  chunk += "],\"dropped\":" + String(dropped) + "}";
  server.sendContent(chunk);
  server.sendContent("");
}
