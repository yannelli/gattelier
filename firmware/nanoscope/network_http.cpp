#include "board_network.h"
#include <WebServer.h>

static void respond(WebServer& server, int status, cJSON* json) {
  char* body = cJSON_PrintUnformatted(json);
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.send(status, "application/json", body ? body : "{}");
  cJSON_free(body); cJSON_Delete(json);
}

static void reject(WebServer& server, int status, const String& message) {
  auto json = cJSON_CreateObject(); cJSON_AddStringToObject(json, "error", message.c_str()); respond(server, status, json);
}

static cJSON* request(WebServer& server) {
  String origin = server.header("Origin");
  if (origin.length() && origin != "http://" + server.hostHeader()) { reject(server, 403, "Use this device's own page to change network settings."); return nullptr; }
  if (!server.header("Content-Type").startsWith("application/json")) { reject(server, 415, "Expected application/json."); return nullptr; }
  String body = server.arg("plain");
  if (body.length() > 1400) { reject(server, 413, "Network request is too large."); return nullptr; }
  if (body.indexOf("\\u0000") >= 0) { reject(server, 400, "Network strings cannot contain a null character."); return nullptr; }
  auto json = cJSON_Parse(body.c_str());
  if (!cJSON_IsObject(json)) { cJSON_Delete(json); reject(server, 400, "Expected a JSON object."); return nullptr; }
  return json;
}

void registerNetworkRoutes(WebServer& server) {
  server.on("/api/network", HTTP_GET, [&server] {
    String origin = server.header("Origin");
    if (origin.length() && origin != "http://" + server.hostHeader()) { reject(server, 403, "Open this device's own page."); return; }
    auto json = cJSON_CreateObject(); addNetworkState(json); respond(server, 200, json);
  });
  server.on("/api/network", HTTP_POST, [&server] {
    auto json = request(server); if (!json) return;
    NetworkChange change; String error;
    auto read = [&](const char* key, String& target, bool& present) {
      auto value = cJSON_GetObjectItemCaseSensitive(json, key); present = value != nullptr;
      if (present && !cJSON_IsString(value)) { error = String(key) + " must be a string."; return; }
      if (present) target = value->valuestring;
    };
    bool modePresent;
    read("mode", change.mode, modePresent); read("ssid", change.ssid, change.hasSSID);
    read("password", change.password, change.hasPassword); read("apSsid", change.apSSID, change.hasAPSSID);
    read("apPassword", change.apPassword, change.hasAPPassword);
    auto keep = cJSON_GetObjectItemCaseSensitive(json, "keepPassword");
    if (keep && !cJSON_IsBool(keep)) error = "keepPassword must be a boolean.";
    change.keepPassword = cJSON_IsTrue(keep);
    if (modePresent && change.mode.isEmpty()) error = "Mode must be station or hotspot.";
    cJSON_Delete(json);
    if (error.length()) { reject(server, 400, error); return; }
    if (!queueNetworkChange(change, error)) { reject(server, 400, error); return; }
    auto result = cJSON_CreateObject(); addNetworkState(result); cJSON_AddBoolToObject(result, "ok", true);
    respond(server, 202, result);
    deferNetworkApply();
  });
  server.on("/api/network/hotspot-password", HTTP_POST, [&server] {
    auto json = request(server); if (!json) return;
    cJSON_Delete(json);
    auto result = cJSON_CreateObject(); cJSON_AddStringToObject(result, "apPassword", networkHotspotPassword().c_str());
    respond(server, 200, result);
  });
}
