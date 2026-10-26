#pragma once
#include "scan_retention.h"
#include <stdio.h>

constexpr size_t ScanJsonCapacity = 1536;

inline bool rawAdvertisementJson(const ScanAdvertisement& record, char* output, size_t capacity) {
  char name[(sizeof(record.name) - 1) * 6 + 1], payload[ScanPayloadCapacity * 2 + 1], power[8];
  size_t at = 0;
  const char* digits = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(record.name) - 1 && record.name[i]; ++i) {
    const uint8_t value = uint8_t(record.name[i]);
    if (value == '"' || value == '\\') { name[at++] = '\\'; name[at++] = char(value); }
    else if (value < 32) {
      memcpy(name + at, "\\u00", 4); at += 4;
      name[at++] = digits[value >> 4]; name[at++] = digits[value & 15];
    } else name[at++] = char(value);
  }
  name[at] = 0;
  for (size_t i = 0; i < record.length(); ++i) { payload[i * 2] = digits[record.payload[i] >> 4]; payload[i * 2 + 1] = digits[record.payload[i] & 15]; }
  payload[record.length() * 2] = 0;
  if (record.hasTxPower) snprintf(power, sizeof(power), "%d", int(record.txPower));
  else memcpy(power, "null", 5);
  const int length = snprintf(output, capacity,
    "{\"seq\":%llu,\"id\":%lu,\"ms\":%lu,\"address\":\"%.17s\",\"name\":\"%s\",\"addressType\":%u,\"rssi\":%d,\"connectable\":%s,\"advType\":%u,\"txPower\":%s,\"payloadTruncated\":%s,\"payloadBytes\":%u,\"payloadHex\":\"%s\"}",
    static_cast<unsigned long long>(record.seq), static_cast<unsigned long>(record.id), static_cast<unsigned long>(record.ms),
    record.address, name, unsigned(record.addressType), int(record.rssi), record.connectable ? "true" : "false", unsigned(record.advType),
    power, record.truncated() ? "true" : "false", unsigned(record.payloadBytes), payload);
  return length >= 0 && size_t(length) < capacity;
}
