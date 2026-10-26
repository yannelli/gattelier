#pragma once
#include "state.h"
#include <NimBLEDevice.h>

void discoverGatt(NimBLEClient* client, bool recorderOnly = false);
void executeGatt(NimBLEClient* client, const Command& command);
bool validateGatt(const Command& command, String& error);
