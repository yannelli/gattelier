#pragma once
#include <array>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <new>
#include <utility>

constexpr size_t ScanCacheCapacity = 24;
constexpr size_t ScanCacheLimitBytes = 16 * 1024;
constexpr size_t ScanJournalCapacity = 96;
constexpr size_t ScanPayloadCapacity = 128;
constexpr size_t ScanJournalLimitBytes = 25 * 1024;

struct ScanAdvertisement {
  uint64_t seq = 0;
  uint32_t id = 0, ms = 0;
  char address[18] = {}, name[81] = {};
  uint8_t payload[ScanPayloadCapacity] = {};
  uint16_t payloadBytes = 0;
  int8_t rssi = 0, txPower = 0;
  uint8_t addressType = 0, advType = 0;
  bool connectable = false, hasTxPower = false;
  size_t length() const { return payloadBytes < ScanPayloadCapacity ? payloadBytes : ScanPayloadCapacity; }
  bool truncated() const { return payloadBytes > ScanPayloadCapacity; }
};

template <size_t Capacity> class ScanJournal {
 public:
  void append(ScanAdvertisement value) {
    value.seq = ++sequence_;
    if (value.truncated()) ++truncated_;
    records_[(value.seq - 1) % Capacity] = value;
  }
  uint64_t next() const { return sequence_; }
  uint64_t oldest() const { return sequence_ >= Capacity ? sequence_ - Capacity + 1 : 1; }
  uint64_t overwritten() const { return sequence_ > Capacity ? sequence_ - Capacity : 0; }
  uint64_t truncated() const { return truncated_; }
  uint64_t dropped(uint64_t after) const { return after < oldest() - 1 ? oldest() - 1 - after : 0; }
  bool read(uint64_t seq, ScanAdvertisement& result) const {
    if (!seq || seq < oldest() || seq > sequence_) return false;
    result = records_[(seq - 1) % Capacity];
    return result.seq == seq;
  }

 private:
  std::array<ScanAdvertisement, Capacity> records_{};
  uint64_t sequence_ = 0, truncated_ = 0;
};

static_assert(sizeof(ScanJournal<ScanJournalCapacity>) <= ScanJournalLimitBytes, "Advertisement journal exceeds its byte budget");

inline bool scanCacheFits(size_t count, size_t retainedBytes, size_t incomingBytes) {
  return count < ScanCacheCapacity && retainedBytes <= ScanCacheLimitBytes && incomingBytes <= ScanCacheLimitBytes - retainedBytes;
}

template <class Container> void eraseScanCacheEntry(Container& entries, size_t index) {
  using Entry = typename Container::value_type;
  for (size_t at = index; at + 1 < entries.size(); ++at) {
    entries[at].~Entry();
    new (&entries[at]) Entry(std::move(entries[at + 1]));
  }
  entries.pop_back();
}
