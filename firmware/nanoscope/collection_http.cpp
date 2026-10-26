#include "http_access.h"
#include "collection.h"
#include <WebServer.h>

static void respond(WebServer& server, int status, cJSON* json) {
  char* body = cJSON_PrintUnformatted(json);
  server.sendHeader("Cache-Control", "no-store"); server.sendHeader("X-Content-Type-Options", "nosniff");
  server.send(status, "application/json", body ? body : "{}"); cJSON_free(body); cJSON_Delete(json);
}

static void reject(WebServer& server, int status, const String& error) {
  auto json = cJSON_CreateObject(); cJSON_AddStringToObject(json, "error", error.c_str()); respond(server, status, json);
}

static bool originAllowed(WebServer& server) {
  if (!allowedHttpOrigin(server)) { reject(server, 403, "Open this board's own page to use collection."); return false; }
  return true;
}

static cJSON* request(WebServer& server) {
  if (!originAllowed(server)) return nullptr;
  if (!server.header("Content-Type").startsWith("application/json")) { reject(server, 415, "Expected application/json."); return nullptr; }
  String body = server.arg("plain");
  if (body.length() > 512) { reject(server, 413, "Collection request is too large."); return nullptr; }
  if (body.indexOf("\\u0000") >= 0) { reject(server, 400, "Collection strings cannot contain a null character."); return nullptr; }
  auto json = cJSON_Parse(body.c_str());
  if (!cJSON_IsObject(json)) { cJSON_Delete(json); reject(server, 400, "Expected a JSON object."); return nullptr; }
  return json;
}

void registerCollectionRoutes(WebServer& server) {
  server.on("/api/collection", HTTP_GET, [&server] { if (originAllowed(server)) respond(server, 200, collectionState()); });
  server.on("/api/collection", HTTP_POST, [&server] {
    auto json = request(server); if (!json) return; String error;
    bool success = configureCollection(json, error); cJSON_Delete(json);
    if (!success) { reject(server, 400, error); return; }
    respond(server, 200, collectionState());
  });
  server.on("/api/collection/storage/init", HTTP_POST, [&server] {
    auto json = request(server); if (!json) return;
    bool confirmed = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "confirm")); cJSON_Delete(json);
    if (!confirmed) { reject(server, 400, "Confirm initialization of the onboard SPIFFS partition."); return; }
    String error;
    if (!initializeCollectionStorage(error)) { reject(server, 409, error); return; }
    respond(server, 200, collectionState());
  });
  server.on("/api/collection/clear", HTTP_POST, [&server] {
    auto json = request(server); if (!json) return;
    bool confirmed = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "confirm")); cJSON_Delete(json);
    if (!confirmed) { reject(server, 400, "Confirm deletion of the saved collection log."); return; }
    String error;
    if (!clearCollectionStorage(error)) { reject(server, 409, error); return; }
    respond(server, 200, collectionState());
  });
  server.on("/api/collection/export", HTTP_GET, [&server] { if (originAllowed(server)) downloadCollection(server); });
}
