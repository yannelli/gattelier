#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <ctype.h>

struct CollectionConfig {
  bool enabled = false, active = false;
  uint16_t intervalMs = 160, windowMs = 80;
  uint32_t periodMs = 0, burstMs = 10000;
  char address[18] = {};
};

struct CollectionScanPlan {
  bool enabled = false, active = true;
  uint16_t intervalMs = 100, windowMs = 45;
  uint32_t revision = 0;
};

constexpr size_t CollectionLogLimit = 512 * 1024;
constexpr size_t CollectionQueueLimit = 8;
constexpr size_t CollectionRecordLimit = 2048;

inline const char* validateCollection(const CollectionConfig& value) {
  if (value.intervalMs < 10 || value.intervalMs > 10240) return "Scan interval must be 10 to 10240 ms.";
  if (value.windowMs < 5 || value.windowMs > value.intervalMs) return "Scan window must be 5 ms through the interval.";
  if (value.burstMs < 1000 || value.burstMs > 600000) return "Burst duration must be 1 to 600 seconds.";
  if (value.periodMs && (value.periodMs < 1000 || value.periodMs > 3600000 || value.burstMs > value.periodMs)) return "Burst period must be 1 to 3600 seconds and at least the duration.";
  if (value.address[0]) {
    if (strnlen(value.address, sizeof(value.address)) != 17) return "Enter a full Bluetooth address or leave it blank.";
    for (size_t i = 0; i < 17; ++i) {
      if (i % 3 == 2 ? value.address[i] != ':' : !isxdigit(static_cast<unsigned char>(value.address[i]))) return "Enter a full Bluetooth address or leave it blank.";
    }
  }
  return nullptr;
}

inline bool collectionBurstDue(const CollectionConfig& config, uint32_t now, uint32_t epoch) {
  return config.enabled && (!config.periodMs || uint32_t(now - epoch) % config.periodMs < config.burstMs);
}

inline bool collectionFits(size_t used, size_t bytes) {
  return bytes <= CollectionRecordLimit && used <= CollectionLogLimit && bytes + 1 <= CollectionLogLimit - used;
}

inline uint32_t collectionColor(bool enabled, bool fault, uint32_t base, uint32_t now) {
  if (!enabled) return base;
  const uint32_t phase = now % 1800;
  return phase < 100 || (phase >= 200 && phase < 300) ? fault ? 0x200000 : 0x002018 : base;
}
