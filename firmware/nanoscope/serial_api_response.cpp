#include "serial_api_response.h"
#include <algorithm>
#include <mbedtls/base64.h>

void SerialApiResponse::reset(uint32_t id) {
  id_ = id; startedAt_ = millis(); bytes_ = 0;
  started_ = ended_ = failed_ = false;
  disposition_ = error_ = "";
}

void SerialApiResponse::header(const String& name, const String& value) {
  if (name.equalsIgnoreCase("Content-Disposition") && value.length() <= 256) disposition_ = value;
}

bool SerialApiResponse::write(const char* bytes, size_t length) {
  uint32_t progress = millis();
  while (length) {
    if (uint32_t(millis() - progress) >= 1000 || uint32_t(millis() - startedAt_) >= 10000) {
      failed_ = true; return false;
    }
    if (!Serial) { delay(1); continue; }
    size_t available = size_t(std::max(0, Serial.availableForWrite()));
    if (!available) { delay(1); continue; }
    size_t count = Serial.write(reinterpret_cast<const uint8_t*>(bytes), std::min(length, available));
    if (!count) { delay(1); continue; }
    bytes += count; length -= count; progress = millis();
  }
  return true;
}

cJSON* SerialApiResponse::event(const char* name) {
  auto json = cJSON_CreateObject();
  cJSON_AddNumberToObject(json, "v", 1);
  cJSON_AddNumberToObject(json, "id", id_);
  cJSON_AddStringToObject(json, "event", name);
  return json;
}

bool SerialApiResponse::frame(cJSON* json) {
  char* encoded = cJSON_PrintUnformatted(json); cJSON_Delete(json);
  if (!encoded) { failed_ = true; return false; }
  bool ok = write("@G1 ", 4) && write(encoded, strlen(encoded)) && write("\n", 1);
  cJSON_free(encoded); return ok;
}

void SerialApiResponse::start(int status, const char* type) {
  if (started_ || failed_) return;
  started_ = true;
  if (!write("\n", 1)) return;
  auto json = event("start");
  cJSON_AddNumberToObject(json, "status", status);
  cJSON_AddStringToObject(json, "type", type ? type : "application/octet-stream");
  auto headers = cJSON_AddObjectToObject(json, "headers");
  cJSON_AddStringToObject(headers, "Cache-Control", "no-store");
  if (disposition_.length()) cJSON_AddStringToObject(headers, "Content-Disposition", disposition_.c_str());
  frame(json);
}

void SerialApiResponse::data(const char* bytes, size_t length) {
  if (!started_ || ended_ || failed_ || error_.length()) return;
  if (length > MaxBytes - bytes_) { error_ = "Response exceeds the byte limit."; return; }
  while (length && !failed_) {
    size_t count = std::min(length, size_t(768)), encodedLength = 0;
    unsigned char encoded[1025];
    if (mbedtls_base64_encode(encoded, sizeof(encoded), &encodedLength, reinterpret_cast<const unsigned char*>(bytes), count)) {
      error_ = "Response encoding failed."; return;
    }
    encoded[encodedLength] = 0;
    auto json = event("data");
    cJSON_AddStringToObject(json, "data", reinterpret_cast<const char*>(encoded));
    if (!frame(json)) return;
    bytes += count; length -= count; bytes_ += count;
  }
}

bool SerialApiResponse::finish() {
  if (ended_) return !failed_ && error_.isEmpty();
  ended_ = true;
  if (failed_) return false;
  auto json = event("end");
  cJSON_AddBoolToObject(json, "ok", error_.isEmpty());
  if (error_.length()) cJSON_AddStringToObject(json, "error", error_.c_str());
  return frame(json) && error_.isEmpty();
}
