#pragma once
#include <Arduino.h>
#include "trace_peer.h"

struct TraceEvent {
  uint32_t seq = 0, ms = 0;
  const char* kind = "";  // Always a string literal, so no copy is kept.
  char address[18] = {};
  String uuid, hex, message;
  uint16_t handle = 0, length = 0;
  bool success = true, truncated = false, redacted = false;
  TraceProvenance provenance;
};

void startTrace();
void recordTrace(const char* kind, const String& address, const String& uuid,
                 uint16_t handle, const uint8_t* data, size_t length,
                 const String& message = "", bool success = true,
                 const TraceProvenance& provenance = {});
class BoardServer;
void sendTrace(BoardServer& server, uint32_t after);
