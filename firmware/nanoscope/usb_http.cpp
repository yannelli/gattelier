#include "http_access.h"
#include "usb_hci.h"
#include "board_server.h"

static void sendUsbState(BoardServer& server, int status) {
  auto json = cJSON_CreateObject(); addUsbState(json); sendJson(server, status, json);
}

void registerUsbRoutes(BoardServer& server) {
  server.on("/api/usb-mode", HTTP_GET, [&server] { sendUsbState(server, 200); });
  server.on("/api/usb-mode", HTTP_POST, [&server] {
    auto json = readJsonObject(server, 128); if (!json) return;
    auto mode = cJSON_GetObjectItemCaseSensitive(json, "mode");
    bool valid = cJSON_IsString(mode) && (!strcmp(mode->valuestring, "hci") || !strcmp(mode->valuestring, "workbench"));
    bool requested = valid && !strcmp(mode->valuestring, "hci");
    cJSON_Delete(json);
    if (!valid) { sendJsonError(server, 400, "Choose hci or workbench mode."); return; }
    String error;
    if (!queueUsbMode(requested, error)) sendJsonError(server, 503, error); else sendUsbState(server, 202);
  });
}
