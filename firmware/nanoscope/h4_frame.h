#pragma once
#include <stdint.h>
#include <stddef.h>

class H4Frame {
  uint16_t used = 0, expected = 0, discard = 0;
 public:
  static constexpr size_t Capacity = 1029;
  uint8_t data[Capacity] = {};
  uint16_t length = 0;
  uint32_t errors = 0;
  bool pending() const { return used || discard; }
  void reset() { used = expected = discard = length = 0; }
  bool feed(uint8_t byte) {
    if (discard) { --discard; return false; }
    if (!used && byte != 1 && byte != 2) { ++errors; return false; }
    data[used++] = byte;
    uint16_t header = data[0] == 1 ? 4 : 5;
    if (used == header) {
      uint16_t payload = data[0] == 1 ? data[3] : uint16_t(data[3]) | uint16_t(data[4]) << 8;
      if (payload > Capacity - header) { used = expected = 0; discard = payload; ++errors; return false; }
      expected = header + payload;
    }
    if (expected && used == expected) { length = used; used = expected = 0; return true; }
    return false;
  }
};
