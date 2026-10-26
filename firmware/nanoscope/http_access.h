#pragma once
#include <WebServer.h>

bool allowedHttpOrigin(WebServer& server);
void registerHttpAccess(WebServer& server);
