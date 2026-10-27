#include "http_access.h"
#include "board_network.h"
#include "board_server.h"

void registerNetworkRoutes(BoardServer& server) {
  server.on("/api/network", HTTP_GET, [&server] {
    auto json = cJSON_CreateObject(); addNetworkState(json); sendJson(server, 200, json);
  });
  server.on("/api/network", HTTP_POST, [&server] {
    auto json = readJsonObject(server, 1400); if (!json) return;
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
    if (error.length()) { sendJsonError(server, 400, error); return; }
    if (!queueNetworkChange(change, error)) { sendJsonError(server, 400, error); return; }
    auto result = cJSON_CreateObject(); addNetworkState(result); cJSON_AddBoolToObject(result, "ok", true);
    sendJson(server, 202, result);
    deferNetworkApply();
  });
  server.on("/api/network/hotspot-password", HTTP_POST, [&server] {
    auto json = readJsonObject(server, 1400); if (!json) return;
    cJSON_Delete(json);
    auto result = cJSON_CreateObject(); cJSON_AddStringToObject(result, "apPassword", networkHotspotPassword().c_str());
    sendJson(server, 200, result);
  });
}
