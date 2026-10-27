#include "http_access.h"
#include "ble_security.h"
#include "pairing_rules.h"
#include "state.h"
#include "usb_hci.h"
#include "board_server.h"

static cJSON* request(BoardServer& server) {
  if (usbHciMode()) { sendJsonError(server, 409, "Restore Bluetooth workbench mode before pairing from the web UI."); return nullptr; }
  auto json = readJsonObject(server, 512); if (!json) return nullptr;
  auto address = cJSON_GetObjectItemCaseSensitive(json, "address");
  if (!cJSON_IsString(address) || strlen(address->valuestring) != 17) {
    cJSON_Delete(json); sendJsonError(server, 400, "Provide the connected device address."); return nullptr;
  }
  return json;
}

void registerSecurityRoutes(BoardServer& server) {
  server.on("/api/pair", HTTP_POST, [&server] {
    auto json = request(server); if (!json) return;
    String address = cJSON_GetObjectItemCaseSensitive(json, "address")->valuestring; address.toLowerCase();
    Command command{Action::Pair}; memcpy(command.data, address.c_str(), 18);
    cJSON_Delete(json);
    String error;
    if (!queueCommand(command, error)) { sendJsonError(server, 409, error); return; }
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
      cJSON_Delete(json); sendJsonError(server, 400, "Provide the current challengeId and a six-digit passkey or accept boolean."); return;
    }
    String address = cJSON_GetObjectItemCaseSensitive(json, "address")->valuestring; address.toLowerCase();
    String challengeId = id->valuestring;
    String passkey = cJSON_IsString(pin) ? pin->valuestring : "";
    bool hasAccept = confirm != nullptr, accept = cJSON_IsTrue(confirm);
    cJSON_Delete(json);
    String error;
    bool success = cancel ? cancelPairing(address, challengeId, error) : respondPairing(address, challengeId, passkey, hasAccept, accept, error);
    passkey = ""; parsed = 0;
    if (!success) { sendJsonError(server, 409, error); return; }
    server.send(202, "application/json", "{\"ok\":true}");
  };
  server.on("/api/pairing-response", HTTP_POST, [respond] { respond(false); });
  server.on("/api/pairing-cancel", HTTP_POST, [respond] { respond(true); });
}
