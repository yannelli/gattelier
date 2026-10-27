#pragma once
#include "board_server.h"
#include <cJSON.h>
#include <math.h>

// The access middleware already enforces the host, origin and no-store rules for every /api/ route.
void registerHttpAccess(BoardServer& server);
void sendJson(BoardServer& server, int status, cJSON* json);
void sendJsonError(BoardServer& server, int status, const String& message);
cJSON* readJsonObject(BoardServer& server, size_t limit);

inline bool jsonInteger(const cJSON* value, double low, double high) {
  return cJSON_IsNumber(value) && value->valuedouble >= low && value->valuedouble <= high && floor(value->valuedouble) == value->valuedouble;
}
