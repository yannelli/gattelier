#pragma once
#include <stdint.h>

enum GattProperty : uint8_t {
  GattRead = 1, GattWrite = 2, GattWriteNoResponse = 4, GattNotify = 8,
  GattIndicate = 16, GattBroadcast = 32, GattSignedWrite = 64, GattExtended = 128
};

struct GattPropertyName { GattProperty flag; const char* name; };
constexpr GattPropertyName GattProperties[] = {
  {GattRead, "read"}, {GattWrite, "write"}, {GattWriteNoResponse, "write-no-response"},
  {GattNotify, "notify"}, {GattIndicate, "indicate"}, {GattBroadcast, "broadcast"},
  {GattSignedWrite, "signed-write"}, {GattExtended, "extended-properties"}
};

// Indexed by Command::mode for Action::Subscribe.
constexpr const char* SubscriptionModes[] = {"off", "notify", "indicate"};
