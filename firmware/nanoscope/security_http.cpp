#include "http_access.h"
#include "ble_security.h"
#include "pairing_rules.h"
#include "state.h"
#include "usb_hci.h"
#include <WebServer.h>

static void reject(WebServer& server, int code, const String& message) {
  auto json = cJSON_CreateObject(); cJSON_AddStringToObject(json, "error", message.c_str());
  char* body = cJSON_PrintUnformatted(json); server.send(code, "application/json", body ? body : "{}");
  cJSON_free(body); cJSON_Delete(json);
}

static cJSON* request(WebServer& server) {
  server.sendHeader("Cache-Control", "no-store");
  if (usbHciMode()) { reject(server, 409, "Restore Bluetooth workbench mode before pairing from the web UI."); return nullptr; }
  if (!allowedHttpOrigin(server)) { reject(server, 403, "Open this board's own page to pair devices."); return nullptr; }
  if (!server.header("Content-Type").startsWith("application/json")) { reject(server, 415, "Expected application/json."); return nullptr; }
  String body = server.arg("plain");
  if (body.length() > 512) { reject(server, 413, "Pairing request is too large."); return nullptr; }
  if (body.indexOf("\\u0000") >= 0) { reject(server, 400, "Pairing strings cannot contain null characters."); return nullptr; }
  auto json = cJSON_Parse(body.c_str());
  if (!cJSON_IsObject(json)) { cJSON_Delete(json); reject(server, 400, "Expected a JSON object."); return nullptr; }
  auto address = cJSON_GetObjectItemCaseSensitive(json, "address");
  if (!cJSON_IsString(address) || strlen(address->valuestring) != 17) {
    cJSON_Delete(json); reject(server, 400, "Provide the connected device address."); return nullptr;
  }
  return json;
}

void registerSecurityRoutes(WebServer& server) {
  server.on("/api/pair", HTTP_POST, [&server] {
    auto json = request(server); if (!json) return;
    String address = cJSON_GetObjectItemCaseSensitive(json, "address")->valuestring; address.toLowerCase();
    Command command{Action::Pair}; memcpy(command.data, address.c_str(), 18);
    cJSON_Delete(json);
    String error;
    if (!queueCommand(command, error)) { reject(server, 409, error); return; }
    server.send(202, "application/json", "{\"ok\":true}");
  });
  auto respond = [&server](bool cancel) {
    auto json = request(server); if (!json) return;
    auto id = cJSON_GetObjectItemCaseSensitive(json, "challengeId");
    auto pin = cJSON_GetObjectItemCaseSensitive(json, "passkey");
    auto confirm = cJSON_GetObjectItemCaseSensitive(json, "accept");
    uint32_t parsed = 0;
    if (!cJSON_IsString(id) || strlen(id->valuestring) != 24 || (!cancel &&
        !((pin && !confirm && cJSON_IsString(pin) && parsePairingPasskey(pin->valuestring, parsed)) || (!pin && cJSON_IsBool(confirm))))) {
      cJSON_Delete(json); reject(server, 400, "Provide the current challengeId and a six-digit passkey or accept boolean."); return;
    }
    String address = cJSON_GetObjectItemCaseSensitive(json, "address")->valuestring; address.toLowerCase();
    String challengeId = id->valuestring;
    String passkey = cJSON_IsString(pin) ? pin->valuestring : "";
    bool hasAccept = confirm != nullptr, accept = cJSON_IsTrue(confirm);
    cJSON_Delete(json);
    String error;
    bool success = cancel ? cancelPairing(address, challengeId, error) : respondPairing(address, challengeId, passkey, hasAccept, accept, error);
    passkey = ""; parsed = 0;
    if (!success) { reject(server, 409, error); return; }
    server.send(202, "application/json", "{\"ok\":true}");
  };
  server.on("/api/pairing-response", HTTP_POST, [respond] { respond(false); });
  server.on("/api/pairing-cancel", HTTP_POST, [respond] { respond(true); });
}
