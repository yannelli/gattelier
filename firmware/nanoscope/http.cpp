#include "http_access.h"
#include "activity_led.h"
#include "state.h"
#include "web_assets.h"
#include "trace.h"
#include "board_network.h"
#include "ble_security.h"
#include "usb_hci.h"
#include "collection.h"
#include "scan_stream.h"
#include "serial_api.h"
#include "board_server.h"

static BoardServer server(80);
static bool httpEnabled = false;

static void sendError(int code, const String& message) { sendJsonError(server, code, message); }

static bool validAddress(const cJSON* value) {
  if (!cJSON_IsString(value) || strlen(value->valuestring) != 17) return false;
  for (size_t i = 0; i < 17; ++i) if (i % 3 == 2 ? value->valuestring[i] != ':' : !isxdigit(value->valuestring[i])) return false;
  return true;
}

static void sendAsset(const WebAsset& asset) {
  server.sendHeader("Content-Encoding", "gzip");
  server.sendHeader("Cache-Control", "no-cache");
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.sendHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self' http: https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  server.send_P(200, asset.type, reinterpret_cast<const char*>(asset.data), asset.size);
}

static void submit(Action action, const char* argument = nullptr) {
  auto json = readJsonObject(server, 1400); if (!json) return;
  uint32_t value = 0;
  auto address = cJSON_GetObjectItemCaseSensitive(json, "address");
  auto addressType = cJSON_GetObjectItemCaseSensitive(json, "addressType");
  bool direct = action == Action::Connect && address;
  if (direct) {
    if (!validAddress(address) || !jsonInteger(addressType, 0, 3) || cJSON_GetObjectItemCaseSensitive(json, "id")) { cJSON_Delete(json); sendError(400, "Known-address connection requires address and addressType (0–3)."); return; }
  }
  if (argument && !direct) {
    auto number = cJSON_GetObjectItemCaseSensitive(json, argument);
    if (!jsonInteger(number, 1, action == Action::Connect ? 4294967295.0 : 65535)) {
      cJSON_Delete(json); sendError(400, "Expected a valid numeric device id or characteristic handle."); return;
    }
    value = static_cast<uint32_t>(number->valuedouble);
  }
  Command command{action, value};
  if (direct) {
    String normalized = address->valuestring; normalized.toLowerCase();
    memcpy(command.data, normalized.c_str(), 18); command.mode = addressType->valueint;
    // Connect has no payload, so length carries flags: bit 0 limits discovery to PLAUD, bit 1 reads identity values.
    auto scope = cJSON_GetObjectItemCaseSensitive(json, "scope");
    command.length = (cJSON_IsString(scope) && !strcmp(scope->valuestring, "plaud") ? 1 : 0) | (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "identify")) ? 2 : 0);
  }
  if (action == Action::Write) {
    auto hex = cJSON_GetObjectItemCaseSensitive(json, "hex");
    auto response = cJSON_GetObjectItemCaseSensitive(json, "response");
    if (!cJSON_IsString(hex) || !cJSON_IsBool(response)) {
      cJSON_Delete(json); sendError(400, "Write requires hex and a response boolean."); return;
    }
    size_t length = strlen(hex->valuestring);
    if (length > 1024 || length % 2) {
      cJSON_Delete(json); sendError(400, "Hex must contain complete bytes, up to 512 bytes."); return;
    }
    for (size_t i = 0; i < length; i += 2) {
      char pair[] = {hex->valuestring[i], hex->valuestring[i + 1], 0};
      if (!isxdigit(pair[0]) || !isxdigit(pair[1])) {
        cJSON_Delete(json); sendError(400, "Hex contains an invalid digit."); return;
      }
      command.data[command.length++] = strtoul(pair, nullptr, 16);
    }
    command.mode = cJSON_IsTrue(response) ? 1 : 0;
  }
  if (action == Action::Subscribe) {
    auto mode = cJSON_GetObjectItemCaseSensitive(json, "mode");
    command.mode = 0;
    while (cJSON_IsString(mode) && command.mode < 3 && strcmp(mode->valuestring, SubscriptionModes[command.mode])) ++command.mode;
    if (!cJSON_IsString(mode) || command.mode == 3) {
      cJSON_Delete(json); sendError(400, "Subscription mode must be off, notify, or indicate."); return;
    }
  }
  cJSON_Delete(json);
  String error;
  if (!queueCommand(command, error)) { sendError(409, error); return; }
  if (action == Action::Connect) {
    String accepted;
    { StateLock lock; accepted = "{\"ok\":true,\"connectionAttempt\":" + String(state.connectionAttempt) + ",\"address\":\"" + state.address + "\",\"addressType\":" + String(state.addressType) + "}"; }
    server.send(202, "application/json", accepted);
  } else server.send(202, "application/json", "{\"ok\":true}");
}

static void cancelConnectRequest() {
  auto json = readJsonObject(server, 160); if (!json) return;
  auto address = cJSON_GetObjectItemCaseSensitive(json, "address");
  auto type = cJSON_GetObjectItemCaseSensitive(json, "addressType");
  auto attempt = cJSON_GetObjectItemCaseSensitive(json, "connectionAttempt");
  if (!validAddress(address) || !jsonInteger(type, 0, 3) || !jsonInteger(attempt, 1, 4294967295.0)) { cJSON_Delete(json); sendError(400, "Provide the connection attempt, address and addressType."); return; }
  String error;
  const bool accepted = cancelConnection(address->valuestring, uint8_t(type->valueint), uint32_t(attempt->valuedouble), error);
  cJSON_Delete(json);
  if (!accepted) { sendError(409, error); return; }
  server.send(202, "application/json", "{\"ok\":true}");
}

void startHttp() {
  const char* headers[] = {"Origin", "Content-Type", "Access-Control-Request-Method", "Access-Control-Request-Headers"};
  server.collectHeaders(headers, 4);
  registerHttpAccess(server);
  registerActivityLedRoutes(server);
  registerNetworkRoutes(server);
  registerSecurityRoutes(server);
  registerUsbRoutes(server);
  registerCollectionRoutes(server);
  for (const auto& asset : webAssets) server.on(asset.path, HTTP_GET, [&asset] { sendAsset(asset); });
  server.on("/api/state", HTTP_GET, [] { sendState(server); });
  server.on("/api/advertisements", HTTP_GET, [] {
    const String cursor = server.arg("after"), boot = server.arg("bootId");
    if (cursor.length() > 16 || boot.length() > 32) { sendError(400, "Invalid advertisement cursor."); return; }
    for (size_t i = 0; i < cursor.length(); ++i) if (!isDigit(cursor[i])) { sendError(400, "Invalid advertisement cursor."); return; }
    const uint64_t after = strtoull(cursor.c_str(), nullptr, 10);
    if (after > 9007199254740991ULL) { sendError(400, "Invalid advertisement cursor."); return; }
    sendAdvertisements(server, after, boot, server.arg("format") == "raw", server.arg("compact") == "1", server.arg("offload") == "1");
  });
  server.on("/api/scan", HTTP_POST, [] { submit(Action::Scan); });
  server.on("/api/stop-scan", HTTP_POST, [] { submit(Action::StopScan); });
  server.on("/api/connect", HTTP_POST, [] { submit(Action::Connect, "id"); });
  server.on("/api/cancel-connect", HTTP_POST, cancelConnectRequest);
  server.on("/api/disconnect", HTTP_POST, [] { submit(Action::Disconnect); });
  server.on("/api/read", HTTP_POST, [] { submit(Action::Read, "handle"); });
  server.on("/api/write", HTTP_POST, [] { submit(Action::Write, "handle"); });
  server.on("/api/subscribe", HTTP_POST, [] { submit(Action::Subscribe, "handle"); });
  server.on("/api/events", HTTP_GET, [] {
    String cursor = server.arg("after");
    for (size_t i = 0; i < cursor.length(); ++i) if (!isDigit(cursor[i])) { sendError(400, "Invalid event cursor."); return; }
    sendTrace(server, strtoul(cursor.c_str(), nullptr, 10));
  });
  server.on("/api/capture", HTTP_POST, [] {
    auto json = readJsonObject(server, 160); if (!json) return;
    auto address = cJSON_GetObjectItemCaseSensitive(json, "address");
    if (!cJSON_IsString(address) || (strlen(address->valuestring) && strlen(address->valuestring) != 17)) {
      cJSON_Delete(json); sendError(400, "Provide a device address, or an empty string to stop advertisement capture."); return;
    }
    {
      StateLock lock;
      state.captureAddress = address->valuestring;
      state.captureAddress.toLowerCase();
    }
    cJSON_Delete(json);
    server.send(200, "application/json", "{\"ok\":true}");
  });
  server.onNotFound([] { sendError(404, "Not found."); });
  server.begin();
  httpEnabled = true;
}

void handleHttp() { if (httpEnabled) server.handleClient(); updateConnectionCancellation(); }

void handleSerialHttp() { handleSerialApi(server); }

void setHttpEnabled(bool enabled) {
  if (httpEnabled == enabled) return;
  httpEnabled = enabled;
  if (enabled) server.begin(); else server.stop();
}
