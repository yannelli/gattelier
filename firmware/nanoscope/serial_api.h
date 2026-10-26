#pragma once
#include <cJSON.h>

class BoardServer;
void handleSerialApi(BoardServer& server);
bool serialApiActive();
void addSerialApiState(cJSON* object);
