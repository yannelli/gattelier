#include "http_access.h"
#include "collection.h"
#include "board_server.h"

void registerCollectionRoutes(BoardServer& server) {
  server.on("/api/collection", HTTP_GET, [&server] { sendJson(server, 200, collectionState()); });
  server.on("/api/collection", HTTP_POST, [&server] {
    auto json = readJsonObject(server, 512); if (!json) return; String error;
    bool success = configureCollection(json, error); cJSON_Delete(json);
    if (!success) { sendJsonError(server, 400, error); return; }
    sendJson(server, 200, collectionState());
  });
  server.on("/api/collection/storage/init", HTTP_POST, [&server] {
    auto json = readJsonObject(server, 512); if (!json) return;
    bool confirmed = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "confirm")); cJSON_Delete(json);
    if (!confirmed) { sendJsonError(server, 400, "Confirm initialization of the onboard SPIFFS partition."); return; }
    String error;
    if (!initializeCollectionStorage(error)) { sendJsonError(server, 409, error); return; }
    sendJson(server, 200, collectionState());
  });
  server.on("/api/collection/clear", HTTP_POST, [&server] {
    auto json = readJsonObject(server, 512); if (!json) return;
    bool confirmed = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "confirm")); cJSON_Delete(json);
    if (!confirmed) { sendJsonError(server, 400, "Confirm deletion of the saved collection log."); return; }
    String error;
    if (!clearCollectionStorage(error)) { sendJsonError(server, 409, error); return; }
    sendJson(server, 200, collectionState());
  });
  server.on("/api/collection/export", HTTP_GET, [&server] { downloadCollection(server); });
}
