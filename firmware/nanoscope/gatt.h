#pragma once
#include "state.h"
#include <NimBLEDevice.h>

void discoverGatt(NimBLEClient* client, bool recorderOnly = false, bool identify = false);
int readAttribute(NimBLEClient* client, uint16_t handle, std::string& value);
void updateValue(uint16_t handle, const uint8_t* data, size_t length, const String& error = "");
void executeGatt(NimBLEClient* client, const Command& command);
bool validateGatt(const Command& command, String& error);
