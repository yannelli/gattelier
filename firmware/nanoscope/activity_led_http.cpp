#include "activity_led.h"
#include "http_access.h"
#include <WebServer.h>
#include <cJSON.h>
#include <math.h>

static void respond(WebServer& server, int status, cJSON* json) {
  char* body = cJSON_PrintUnformatted(json);
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.send(status, "application/json", body ? body : "{}");
  cJSON_free(body);
  cJSON_Delete(json);
}

static void reject(WebServer& server, int status, const char* error) {
  auto json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "error", error);
  respond(server, status, json);
}

static bool originAllowed(WebServer& server) {
  if (allowedHttpOrigin(server)) return true;
  reject(server, 403, "Open this board's own page to change the activity LED.");
  return false;
}

static cJSON* ledState() {
  auto json = cJSON_CreateObject();
  cJSON_AddNumberToObject(json, "brightness", activityLedBrightness());
  cJSON_AddNumberToObject(json, "pin", 7);
  cJSON_AddBoolToObject(json, "ready", activityLedReady());
  return json;
}

void registerActivityLedRoutes(WebServer& server) {
  server.on("/api/activity-led", HTTP_GET, [&server] {
    if (originAllowed(server)) respond(server, 200, ledState());
  });
  server.on("/api/activity-led", HTTP_POST, [&server] {
    if (!originAllowed(server)) return;
    const String type = server.header("Content-Type");
    const int separator = type.indexOf(';');
    String mediaType = separator < 0 ? type : type.substring(0, separator);
    mediaType.trim();
    if (!mediaType.equalsIgnoreCase("application/json")) { reject(server, 415, "Expected application/json."); return; }
    const String body = server.arg("plain");
    if (body.length() > 128) { reject(server, 413, "Activity LED request is too large."); return; }
    auto json = cJSON_Parse(body.c_str());
    if (!cJSON_IsObject(json)) { cJSON_Delete(json); reject(server, 400, "Expected a JSON object."); return; }
    auto value = cJSON_GetObjectItemCaseSensitive(json, "brightness");
    auto test = cJSON_GetObjectItemCaseSensitive(json, "test");
    const bool invalidBrightness = value && (!cJSON_IsNumber(value) || !isfinite(value->valuedouble) || value->valuedouble < 0 || value->valuedouble > 100 || floor(value->valuedouble) != value->valuedouble);
    if (invalidBrightness || (test && !cJSON_IsTrue(test)) || (!value && !test)) {
      cJSON_Delete(json);
      reject(server, 400, "Provide brightness as an integer from 0 to 100, test:true, or both.");
      return;
    }
    String error;
    const bool saved = !value || setActivityLedBrightness(uint8_t(value->valuedouble), error);
    const bool tested = saved && (!test || testActivityLed(error));
    cJSON_Delete(json);
    if (!tested) { reject(server, 500, error.c_str()); return; }
    respond(server, 200, ledState());
  });
}
