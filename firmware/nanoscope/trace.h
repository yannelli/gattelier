#pragma once
#include <Arduino.h>

struct TraceEvent {
  uint32_t seq = 0, ms = 0;
  String kind, address, uuid, hex, message;
  uint16_t handle = 0;
  size_t length = 0;
  bool success = true, truncated = false, redacted = false;
};

void startTrace();
void recordTrace(const String& kind, const String& address, const String& uuid,
                 uint16_t handle, const uint8_t* data, size_t length,
                 const String& message = "", bool success = true);
class BoardServer;
void sendTrace(BoardServer& server, uint32_t after);
