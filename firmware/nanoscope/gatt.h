#pragma once
#include "state.h"
#include "trace_peer.h"
#include <NimBLEDevice.h>

void discoverGatt(NimBLEClient* client, const TracePeer& peer, bool recorderOnly = false, bool identify = false);
int readAttribute(NimBLEClient* client, uint16_t handle, std::string& value);
void updateValue(uint16_t handle, const uint8_t* data, size_t length, const String& error = "", const TracePeer* peer = nullptr);
void executeGatt(NimBLEClient* client, const Command& command, const TracePeer& peer);
bool validateGatt(const Command& command, String& error);
