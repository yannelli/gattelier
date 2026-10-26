#include "http_access.h"
#include "activity_led.h"
#include "state.h"
#include "web_assets.h"
#include "trace.h"
#include "board_network.h"
#include "ble_security.h"
#include "usb_hci.h"
#include "collection.h"
#include <WebServer.h>
#include <cJSON.h>
#include <cmath>

static WebServer server(80);

static void sendError(int code, const String& message) {
  auto root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "error", message.c_str());
  char* body = cJSON_PrintUnformatted(root);
  server.send(code, "application/json", body ? body : "{}");
  cJSON_free(body);
  cJSON_Delete(root);
}

static void sendAsset(const char* contentType, const uint8_t* data, size_t size) {
  server.sendHeader("Content-Encoding", "gzip");
  server.sendHeader("Cache-Control", "no-cache");
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.sendHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' http: https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  server.send_P(200, contentType, reinterpret_cast<const char*>(data), size);
}

static void submit(Action action, const char* argument = nullptr) {
  server.sendHeader("Cache-Control", "no-store");
  if (!allowedHttpOrigin(server)) {
    sendError(403, "Open Gattelier directly to control this board."); return;
  }
  if (!server.header("Content-Type").startsWith("application/json")) {
    sendError(415, "Expected application/json."); return;
  }
  String body = server.arg("plain");
  if (body.length() > 1400) { sendError(413, "Request is too large."); return; }
  auto json = cJSON_Parse(body.c_str());
  if (!cJSON_IsObject(json)) { cJSON_Delete(json); sendError(400, "Expected a JSON object."); return; }
  uint32_t value = 0;
  auto address = cJSON_GetObjectItemCaseSensitive(json, "address");
  auto addressType = cJSON_GetObjectItemCaseSensitive(json, "addressType");
  bool direct = action == Action::Connect && address;
  if (direct) {
    bool valid = cJSON_IsString(address) && strlen(address->valuestring) == 17 && cJSON_IsNumber(addressType)
      && addressType->valuedouble >= 0 && addressType->valuedouble <= 3 && std::floor(addressType->valuedouble) == addressType->valuedouble
      && !cJSON_GetObjectItemCaseSensitive(json, "id");
    for (size_t i = 0; valid && i < 17; ++i) valid = i % 3 == 2 ? address->valuestring[i] == ':' : isxdigit(address->valuestring[i]);
    if (!valid) { cJSON_Delete(json); sendError(400, "Known-address connection requires address and addressType (0–3)."); return; }
  }
  if (argument && !direct) {
    auto number = cJSON_GetObjectItemCaseSensitive(json, argument);
    double maxValue = action == Action::Connect ? 4294967295.0 : 65535;
    if (!cJSON_IsNumber(number) || number->valuedouble < 1 || number->valuedouble > maxValue || std::floor(number->valuedouble) != number->valuedouble) {
      cJSON_Delete(json); sendError(400, "Expected a valid numeric device id or characteristic handle."); return;
    }
    value = static_cast<uint32_t>(number->valuedouble);
  }
  Command command{action, value};
  if (direct) {
    String normalized = address->valuestring; normalized.toLowerCase();
    memcpy(command.data, normalized.c_str(), 18); command.mode = addressType->valueint;
    auto scope = cJSON_GetObjectItemCaseSensitive(json, "scope");
    command.length = cJSON_IsString(scope) && !strcmp(scope->valuestring, "plaud") ? 1 : 0;
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
    if (!cJSON_IsString(mode) || (strcmp(mode->valuestring, "off") && strcmp(mode->valuestring, "notify") && strcmp(mode->valuestring, "indicate"))) {
      cJSON_Delete(json); sendError(400, "Subscription mode must be off, notify, or indicate."); return;
    }
    command.mode = !strcmp(mode->valuestring, "notify") ? 1 : !strcmp(mode->valuestring, "indicate") ? 2 : 0;
  }
  cJSON_Delete(json);
  String error;
  if (!queueCommand(command, error)) { sendError(409, error); return; }
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
  server.on("/", HTTP_GET, [] { sendAsset("text/html; charset=utf-8", index_html, sizeof(index_html)); });
  server.on("/app.bundle.js", HTTP_GET, [] { sendAsset("text/javascript; charset=utf-8", app_bundle_js, sizeof(app_bundle_js)); });
  server.on("/app.bundle.css", HTTP_GET, [] { sendAsset("text/css; charset=utf-8", app_bundle_css, sizeof(app_bundle_css)); });
  server.on("/metadata-v1.json", HTTP_GET, [] { sendAsset("application/json", metadata_json, sizeof(metadata_json)); });
  server.on("/vendors.json", HTTP_GET, [] { sendAsset("application/json", vendors_json, sizeof(vendors_json)); });
  server.on("/manifest.webmanifest", HTTP_GET, [] { sendAsset("application/manifest+json", manifest_json, sizeof(manifest_json)); });
  server.on("/sw.js", HTTP_GET, [] { sendAsset("text/javascript; charset=utf-8", service_worker_js, sizeof(service_worker_js)); });
  server.on("/icons/nanoscope-180.png", HTTP_GET, [] { sendAsset("image/png", icon_180_png, sizeof(icon_180_png)); });
  server.on("/icons/nanoscope-192.png", HTTP_GET, [] { sendAsset("image/png", icon_192_png, sizeof(icon_192_png)); });
  server.on("/icons/nanoscope-512.png", HTTP_GET, [] { sendAsset("image/png", icon_512_png, sizeof(icon_512_png)); });
  server.on("/api/state", HTTP_GET, [] {
    server.sendHeader("Cache-Control", "no-store");
    sendState(server);
  });
  server.on("/api/scan", HTTP_POST, [] { submit(Action::Scan); });
  server.on("/api/stop-scan", HTTP_POST, [] { submit(Action::StopScan); });
  server.on("/api/connect", HTTP_POST, [] { submit(Action::Connect, "id"); });
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
    if (!allowedHttpOrigin(server) || !server.header("Content-Type").startsWith("application/json")) {
      sendError(403, "Use the board UI with a JSON request."); return;
    }
    auto json = cJSON_Parse(server.arg("plain").c_str());
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
}

void handleHttp() { server.handleClient(); }
