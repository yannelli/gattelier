#include "http_access.h"
#include <Preferences.h>
#include <cJSON.h>

static String appOrigin;

bool allowedHttpOrigin(BoardServer& server) {
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

void registerHttpAccess(BoardServer& server) {
  Preferences preferences;
  preferences.begin("web-access", true);
  appOrigin = preferences.getString("origin", "https://gattelier.ryanyannelli.com");
  if (appOrigin == "-") appOrigin = "";
  preferences.end();
  server.access([](BoardServer& request) {
    if (!request.uri().startsWith("/api/")) return false;
    request.sendHeader("Cache-Control", "no-store");
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
    char* body = cJSON_PrintUnformatted(json);
    server.send(200, "application/json", body ? body : "{}");
    cJSON_free(body); cJSON_Delete(json);
  };
  server.on("/api/access", HTTP_GET, respond);
  server.on("/api/access", HTTP_POST, [&server, respond]() {
    const String origin = server.header("Origin");
    if (!origin.isEmpty() && origin != "http://" + server.hostHeader()) {
      server.send(403, "application/json", "{\"error\":\"Open the board's local page to change hosted app access.\"}"); return;
    }
    if (!server.header("Content-Type").startsWith("application/json") || server.arg("plain").length() > 512) {
      server.send(400, "application/json", "{\"error\":\"Send a JSON origin setting.\"}"); return;
    }
    const String body = server.arg("plain");
    auto json = cJSON_Parse(body.c_str());
    auto value = cJSON_GetObjectItemCaseSensitive(json, "origin");
    String next = cJSON_IsString(value) ? value->valuestring : "";
    const bool valid = cJSON_IsString(value) && body.indexOf("\\u0000") < 0 && validOrigin(next);
    cJSON_Delete(json);
    if (!valid) { server.send(400, "application/json", "{\"error\":\"Use an HTTPS origin without a path, or leave blank to disable hosted access.\"}"); return; }
    Preferences settings;
    if (!settings.begin("web-access", false)) { server.send(503, "application/json", "{\"error\":\"Could not open access settings.\"}"); return; }
    const String stored = next.isEmpty() ? "-" : next;
    const bool saved = settings.putString("origin", stored) == stored.length(); settings.end();
    if (!saved) { server.send(503, "application/json", "{\"error\":\"Could not save access settings.\"}"); return; }
    appOrigin = next; respond();
  });
}
