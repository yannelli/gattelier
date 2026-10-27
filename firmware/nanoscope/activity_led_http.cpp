#include "activity_led.h"
#include "http_access.h"
#include "board_server.h"

static cJSON* ledState() {
  auto json = cJSON_CreateObject();
  cJSON_AddNumberToObject(json, "brightness", activityLedBrightness());
  cJSON_AddNumberToObject(json, "pin", ActivityPin);
  cJSON_AddBoolToObject(json, "ready", activityLedReady());
  return json;
}

void registerActivityLedRoutes(BoardServer& server) {
  server.on("/api/activity-led", HTTP_GET, [&server] { sendJson(server, 200, ledState()); });
  server.on("/api/activity-led", HTTP_POST, [&server] {
    auto json = readJsonObject(server, 128); if (!json) return;
    auto value = cJSON_GetObjectItemCaseSensitive(json, "brightness");
    auto test = cJSON_GetObjectItemCaseSensitive(json, "test");
    const bool invalidBrightness = value && !jsonInteger(value, 0, 100);
    if (invalidBrightness || (test && !cJSON_IsTrue(test)) || (!value && !test)) {
      cJSON_Delete(json);
      sendJsonError(server, 400, "Provide brightness as an integer from 0 to 100, test:true, or both.");
      return;
    }
    String error;
    const bool saved = !value || setActivityLedBrightness(uint8_t(value->valuedouble), error);
    const bool tested = saved && (!test || testActivityLed(error));
    cJSON_Delete(json);
    if (!tested) { sendJsonError(server, 500, error); return; }
    sendJson(server, 200, ledState());
  });
}
