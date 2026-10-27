#include "serial_api.h"
#include "serial_api_frame.h"
#include "board_server.h"
#include "board_network.h"
#include "http_access.h"
#include <cstring>

static SerialApiLine input;
static SerialApiLease lease;
static SerialApiConnection connection;
static uint32_t heapBeforePause = 0;

bool serialApiActive() { return lease.active(); }

void addSerialApiState(cJSON* object) {
  cJSON_AddStringToObject(object, "protocol", "gattelier-serial");
  cJSON_AddNumberToObject(object, "version", 1);
  cJSON_AddBoolToObject(object, "active", lease.active());
  cJSON_AddBoolToObject(object, "wifiSuspended", serialWifiSuspended());
  cJSON_AddNumberToObject(object, "leaseMs", SerialApiLease::Duration);
  cJSON_AddNumberToObject(object, "maxRequestBytes", SerialApiLine::MaxJsonBytes);
  cJSON_AddNumberToObject(object, "maxResponseBytes", SerialApiResponse::MaxBytes);
  cJSON_AddNumberToObject(object, "freeHeap", ESP.getFreeHeap());
  if (heapBeforePause) cJSON_AddNumberToObject(object, "heapBeforePause", heapBeforePause);
}

static void releaseSession() {
  String error;
  setSerialWifiSuspended(false, error);
  lease.close();
  heapBeforePause = 0;
}

static bool validPath(const char* path) {
  size_t length = strlen(path);
  if (length > 512 || strncmp(path, "/api/", 5)) return false;
  for (size_t i = 0; i < length; ++i) {
    unsigned char character = path[i];
    if (character < 33 || character > 126 || character == '#' || character == '\\') return false;
    if (character != '%') continue;
    if (i + 2 >= length || !isxdigit(path[i + 1]) || !isxdigit(path[i + 2])) return false;
    char hex[] = {path[i + 1], path[i + 2], 0};
    unsigned decoded = strtoul(hex, nullptr, 16);
    if (decoded < 32 || decoded == 127) return false;
    i += 2;
  }
  return true;
}

static bool boundedJson(const char* text) {
  unsigned depth = 0;
  bool quoted = false, escaped = false;
  for (const char* cursor = text; *cursor; ++cursor) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (*cursor == '\\') escaped = true;
      else if (*cursor == '"') quoted = false;
    } else if (*cursor == '"') quoted = true;
    else if (*cursor == '{' || *cursor == '[') { if (++depth > 8) return false; }
    else if (*cursor == '}' || *cursor == ']') { if (!depth) return false; --depth; }
  }
  return !quoted && depth == 0 && !strstr(text, "\\u0000");
}

static bool noNulls(cJSON* json) {
  if (cJSON_IsNull(json)) return false;
  for (auto child = json->child; child; child = child->next) if (!noNulls(child)) return false;
  return true;
}

static bool validBody(const char* text) {
  if (!boundedJson(text)) return false;
  auto json = cJSON_ParseWithOpts(text, nullptr, true);
  bool valid = cJSON_IsObject(json) && noNulls(json);
  cJSON_Delete(json); return valid;
}

static bool validEnvelope(cJSON* json) {
  if (!cJSON_IsObject(json)) return false;
  unsigned fields = 0;
  for (auto item = json->child; item; item = item->next) {
    unsigned flag = !strcmp(item->string, "v") ? 1 : !strcmp(item->string, "id") ? 2 :
      !strcmp(item->string, "method") ? 4 : !strcmp(item->string, "path") ? 8 : !strcmp(item->string, "body") ? 16 : 0;
    if (!flag || (fields & flag)) return false;
    fields |= flag;
  }
  return (fields & 15) == 15;
}

static void sendStatus(BoardServer& server, bool closing) {
  auto json = cJSON_CreateObject(); addSerialApiState(json);
  if (closing) {
    cJSON_ReplaceItemInObjectCaseSensitive(json, "active", cJSON_CreateBool(false));
    cJSON_ReplaceItemInObjectCaseSensitive(json, "wifiSuspended", cJSON_CreateBool(false));
  }
  sendJson(server, 200, json);
}

static bool sessionRequest(BoardServer& server) {
  if (server.method() == HTTP_GET) { if (lease.active()) lease.renew(millis()); sendStatus(server, false); return false; }
  String body = server.arg("plain");
  const char* end = nullptr;
  auto json = cJSON_ParseWithOpts(body.c_str(), &end, true);
  auto action = cJSON_GetObjectItemCaseSensitive(json, "action");
  auto wifiOff = cJSON_GetObjectItemCaseSensitive(json, "wifiOff");
  if (!cJSON_IsObject(json) || !cJSON_IsString(action) || (wifiOff && !cJSON_IsBool(wifiOff))) {
    cJSON_Delete(json); sendJsonError(server, 400, "Provide an action and optional wifiOff boolean."); return false;
  }
  String requested = action->valuestring;
  bool pause = cJSON_IsTrue(wifiOff);
  cJSON_Delete(json);
  if (requested == "open") {
    String error;
    uint32_t before = ESP.getFreeHeap();
    bool wasPaused = serialWifiSuspended();
    if (!setSerialWifiSuspended(pause, error)) { sendJsonError(server, 503, error.c_str()); return false; }
    if (pause && !wasPaused) heapBeforePause = before;
    if (!pause) heapBeforePause = 0;
    lease.renew(millis()); sendStatus(server, false); return false;
  }
  if (requested == "close") { sendStatus(server, true); return true; }
  if (requested != "ping") { sendJsonError(server, 400, "Choose open, ping, or close."); return false; }
  if (!lease.active()) { sendJsonError(server, 428, "Open a serial session first."); return false; }
  lease.renew(millis()); sendStatus(server, false); return false;
}

static void request(BoardServer& server, const char* line) {
  const char* end = nullptr;
  auto json = boundedJson(line) ? cJSON_ParseWithOpts(line, &end, true) : nullptr;
  auto id = cJSON_GetObjectItemCaseSensitive(json, "id");
  bool validId = jsonInteger(id, 1, 4294967295.0);
  uint32_t requestId = validId ? uint32_t(id->valuedouble) : 0;
  auto version = cJSON_GetObjectItemCaseSensitive(json, "v");
  auto method = cJSON_GetObjectItemCaseSensitive(json, "method");
  auto path = cJSON_GetObjectItemCaseSensitive(json, "path");
  auto body = cJSON_GetObjectItemCaseSensitive(json, "body");
  bool valid = strlen(line) <= SerialApiLine::MaxJsonBytes && !strstr(line, "\\u0000") && validEnvelope(json) && validId &&
    cJSON_IsNumber(version) && version->valuedouble == 1 && cJSON_IsString(method) &&
    (!strcmp(method->valuestring, "GET") || !strcmp(method->valuestring, "POST")) &&
    cJSON_IsString(path) && validPath(path->valuestring) && (!body || (cJSON_IsString(body) && strlen(body->valuestring) <= 1400));
  if (valid && !strcmp(method->valuestring, "POST")) valid = body && validBody(body->valuestring);
  HTTPMethod verb = valid && !strcmp(method->valuestring, "POST") ? HTTP_POST : HTTP_GET;
  server.beginSerial(requestId, verb, valid ? path->valuestring : "/api/serial", valid && body ? body->valuestring : "");
  cJSON_Delete(json);
  bool close = false;
  if (!valid) sendJsonError(server, 400, "Invalid serial request.");
  else if (server.uri() == "/api/serial") close = sessionRequest(server);
  else if (!lease.active()) sendJsonError(server, 428, "Open a serial session first.");
  else { lease.renew(millis()); server.dispatchSerial(); }
  bool complete = server.endSerial();
  if (close || !complete) releaseSession();
}

void handleSerialApi(BoardServer& server) {
  bool disconnected = connection.lost(bool(Serial), millis());
  if (lease.expired(millis()) || (lease.active() && disconnected)) { releaseSession(); input.reset(); }
  input.expire(millis());
  for (unsigned count = 0; count < 512 && Serial.available(); ++count) {
    if (!input.feed(char(Serial.read()), millis())) continue;
    const char* line = input.line();
    if (!strncmp(line, "@G1 ", 4)) request(server, line + 4);
    else if (!strncmp(line, "network ", 8)) handleNetworkConsole(String(line));
    break;
  }
}
