#include "http_access.h"
#include "usb_hci.h"
#include "board_server.h"

void registerUsbRoutes(BoardServer& server) {
  auto respond = [&server](int status, const String& error = "") {
    auto json = cJSON_CreateObject();
    if (error.isEmpty()) addUsbState(json); else cJSON_AddStringToObject(json, "error", error.c_str());
    char* text = cJSON_PrintUnformatted(json);
    server.sendHeader("Cache-Control", "no-store");
    server.send(status, "application/json", text ? text : "{}");
    cJSON_free(text); cJSON_Delete(json);
  };
  server.on("/api/usb-mode", HTTP_GET, [respond] { respond(200); });
  server.on("/api/usb-mode", HTTP_POST, [&server, respond] {
    if (!allowedHttpOrigin(server) || !server.header("Content-Type").startsWith("application/json")) {
      respond(403, "Open Gattelier directly and send JSON."); return;
    }
    if (server.arg("plain").length() > 128) { respond(413, "Request is too large."); return; }
    auto json = cJSON_Parse(server.arg("plain").c_str());
    auto mode = cJSON_GetObjectItemCaseSensitive(json, "mode");
    bool valid = cJSON_IsString(mode) && (!strcmp(mode->valuestring, "hci") || !strcmp(mode->valuestring, "workbench"));
    bool requested = valid && !strcmp(mode->valuestring, "hci");
    cJSON_Delete(json);
    if (!valid) { respond(400, "Choose hci or workbench mode."); return; }
    String error;
    if (!queueUsbMode(requested, error)) respond(503, error); else respond(202);
  });
}
