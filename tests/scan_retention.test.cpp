#include <assert.h>
#include <limits.h>
#include <vector>
#include "../firmware/nanoscope/scan_retention.h"

struct RetainingEntry {
  size_t capacity;
  explicit RetainingEntry(size_t value) : capacity(value) {}
  RetainingEntry(RetainingEntry&& other) : capacity(other.capacity) { other.capacity = 0; }
  RetainingEntry& operator=(RetainingEntry&& other) {
    if (capacity < other.capacity) capacity = other.capacity;
    other.capacity = 0;
    return *this;
  }
};

int main() {
  ScanJournal<3> journal;
  ScanAdvertisement record, copied;
  assert(journal.next() == 0);
  assert(journal.oldest() == 1);
  assert(journal.dropped(0) == 0);
  assert(!journal.read(0, copied));
  assert(!journal.read(1, copied));
  strcpy(record.address, "02:00:00:00:00:01");
  for (uint32_t id = 1; id <= 10000; ++id) {
    record.id = id; record.ms = id * 100; record.payload[0] = uint8_t(id);
    journal.append(record);
    assert(journal.next() == id);
    assert(journal.read(id, copied));
    assert(copied.id == id && copied.ms == id * 100 && copied.payload[0] == uint8_t(id));
    assert(strcmp(copied.address, record.address) == 0);
    if (id > 3) assert(!journal.read(id - 3, copied));
  }
  assert(journal.oldest() == 9998);
  assert(journal.overwritten() == 9997);
  assert(journal.dropped(0) == 9997);
  assert(journal.dropped(9996) == 1);
  assert(journal.dropped(9997) == 0);
  assert(journal.dropped(10000) == 0);
  assert(!journal.read(10001, copied));
  assert(journal.read(9998, copied));
  journal.append(record); assert(!journal.read(9998, copied));

  record.payloadBytes = ScanPayloadCapacity;
  assert(record.length() == ScanPayloadCapacity && !record.truncated());
  record.payloadBytes = ScanPayloadCapacity + 1;
  assert(record.length() == ScanPayloadCapacity && record.truncated());
  journal.append(record); assert(journal.truncated() == 1);
  record.payloadBytes = UINT16_MAX;
  journal.append(record); assert(journal.truncated() == 2);
  assert(journal.read(journal.next(), copied));
  assert(copied.length() == ScanPayloadCapacity && copied.payloadBytes == UINT16_MAX);

  assert(scanCacheFits(0, 0, ScanCacheLimitBytes));
  assert(!scanCacheFits(0, 0, ScanCacheLimitBytes + 1));
  assert(scanCacheFits(23, ScanCacheLimitBytes - 1, 1));
  assert(!scanCacheFits(24, 0, 1));
  assert(!scanCacheFits(23, ScanCacheLimitBytes, 1));
  assert(!scanCacheFits(0, SIZE_MAX, 1));
  assert(!scanCacheFits(0, 1, SIZE_MAX));
  static_assert(sizeof(ScanJournal<ScanJournalCapacity>) <= ScanJournalLimitBytes);

  std::vector<RetainingEntry> shifted;
  shifted.reserve(3); shifted.emplace_back(4096); shifted.emplace_back(8); shifted.emplace_back(16);
  eraseScanCacheEntry(shifted, 0);
  assert(shifted.size() == 2 && shifted[0].capacity == 8 && shifted[1].capacity == 16);
  eraseScanCacheEntry(shifted, 1); assert(shifted.size() == 1 && shifted[0].capacity == 8);
  eraseScanCacheEntry(shifted, 0); assert(shifted.empty());
}
