#include "http_access.h"
#include "http_host.h"
#include <Preferences.h>

static String appOrigin;

static bool allowedHttpOrigin(BoardServer& server) {
  if (!server.viaSerial() && !boardHostAllowed(server.hostHeader().c_str())) return false;
  const String origin = server.header("Origin");
  return origin.isEmpty() || origin == "http://" + server.hostHeader() || (!appOrigin.isEmpty() && origin == appOrigin);
}

static bool validOrigin(const String& origin) {
  if (origin.isEmpty()) return true;
  if (origin.length() > 220 || !origin.startsWith("https://")) return false;
  const String host = origin.substring(8);
  if (host.isEmpty() || host.startsWith(".") || host.endsWith(".")) return false;
  for (size_t i = 0; i < host.length(); ++i) if (!isalnum(host[i]) && host[i] != '.' && host[i] != '-' && host[i] != ':') return false;
  const int colon = host.indexOf(':');
  if (colon >= 0) {
    if (colon == 0 || colon != host.lastIndexOf(':')) return false;
    const String port = host.substring(colon + 1);
    if (port.isEmpty() || port.length() > 5) return false;
    for (size_t i = 0; i < port.length(); ++i) if (!isDigit(port[i])) return false;
    if (port.toInt() < 1 || port.toInt() > 65535) return false;
  }
  return true;
}

void sendJson(BoardServer& server, int status, cJSON* json) {
  char* body = cJSON_PrintUnformatted(json);
  server.sendHeader("X-Content-Type-Options", "nosniff");
  server.send(status, "application/json", body ? body : "{}");
  cJSON_free(body); cJSON_Delete(json);
}

void sendJsonError(BoardServer& server, int status, const String& message) {
  auto json = cJSON_CreateObject(); cJSON_AddStringToObject(json, "error", message.c_str()); sendJson(server, status, json);
}

cJSON* readJsonObject(BoardServer& server, size_t limit) {
  if (!server.header("Content-Type").startsWith("application/json")) { sendJsonError(server, 415, "Expected application/json."); return nullptr; }
  const String body = server.arg("plain");
  if (body.length() > limit) { sendJsonError(server, 413, "Request is too large."); return nullptr; }
  if (body.indexOf("\\u0000") >= 0) { sendJsonError(server, 400, "Strings cannot contain a null character."); return nullptr; }
  auto json = cJSON_Parse(body.c_str());
  if (!cJSON_IsObject(json)) { cJSON_Delete(json); sendJsonError(server, 400, "Expected a JSON object."); return nullptr; }
  return json;
}

void registerHttpAccess(BoardServer& server) {
  Preferences preferences;
  preferences.begin("web-access", true);
  appOrigin = preferences.getString("origin", "https://gattelier.ryanyannelli.com");
  if (appOrigin == "-") appOrigin = "";
  preferences.end();
  server.access([](BoardServer& request) {
    if (!request.uri().startsWith("/api/")) return false;
    request.sendHeader("Cache-Control", "no-store");
    if (!request.viaSerial() && !boardHostAllowed(request.hostHeader().c_str())) {
      request.send(403, "application/json", "{\"error\":\"Open the board by its IP address or a local name such as nanoscope.local.\"}");
      return true;
    }
    if (!allowedHttpOrigin(request)) {
      request.send(403, "application/json", "{\"error\":\"This app origin is not allowed. Configure hosted app access on the board's local page.\"}");
      return true;
    }
    const String origin = request.header("Origin");
    if (!origin.isEmpty()) {
      request.sendHeader("Access-Control-Allow-Origin", origin);
      request.sendHeader("Vary", "Origin");
    }
    if (request.method() != HTTP_OPTIONS) return false;
    const String method = request.header("Access-Control-Request-Method");
    String headers = request.header("Access-Control-Request-Headers"); headers.toLowerCase(); headers.trim();
    if (origin.isEmpty() || (method != "GET" && method != "POST") || (!headers.isEmpty() && headers != "content-type")) {
      request.send(403, "application/json", "{\"error\":\"Unsupported API preflight.\"}"); return true;
    }
    request.sendHeader("Access-Control-Allow-Methods", "GET, POST");
    request.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    request.sendHeader("Access-Control-Max-Age", "600");
    request.send(204); return true;
  });
  auto respond = [&server]() {
    auto json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "origin", appOrigin.c_str());
    sendJson(server, 200, json);
  };
  server.on("/api/access", HTTP_GET, respond);
  server.on("/api/access", HTTP_POST, [&server, respond]() {
    const String origin = server.header("Origin");
    if (!origin.isEmpty() && origin != "http://" + server.hostHeader()) {
      sendJsonError(server, 403, "Open the board's local page to change hosted app access."); return;
    }
    auto json = readJsonObject(server, 512); if (!json) return;
    auto value = cJSON_GetObjectItemCaseSensitive(json, "origin");
    String next = cJSON_IsString(value) ? value->valuestring : "";
    const bool valid = cJSON_IsString(value) && validOrigin(next);
    cJSON_Delete(json);
    if (!valid) { sendJsonError(server, 400, "Use an HTTPS origin without a path, or leave blank to disable hosted access."); return; }
    Preferences settings;
    if (!settings.begin("web-access", false)) { sendJsonError(server, 503, "Could not open access settings."); return; }
    const String stored = next.isEmpty() ? "-" : next;
    const bool saved = settings.putString("origin", stored) == stored.length(); settings.end();
    if (!saved) { sendJsonError(server, 503, "Could not save access settings."); return; }
    appOrigin = next; respond();
  });
}
