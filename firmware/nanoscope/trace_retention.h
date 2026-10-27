#pragma once
#include <array>
#include <cstddef>
#include <cstdint>

template<size_t Capacity, size_t Budget>
class TraceRetention {
  // A cost never exceeds the budget once trimmed to it, so 16 bits per slot is enough.
  static_assert(Budget <= UINT16_MAX, "Trace budget must fit 16-bit costs");
 public:
  uint32_t first = 1, last = 0;
  size_t used = 0;
  bool room(size_t cost) const { return last - first + 1 < Capacity && used + cost <= Budget; }
  bool empty() const { return first > last; }
  void discard() { if (!empty()) { used -= costs[(first - 1) % Capacity]; ++first; } }
  void append(size_t cost) { cost = cost < Budget ? cost : Budget; ++last; costs[(last - 1) % Capacity] = uint16_t(cost); used += cost; }
 private:
  std::array<uint16_t, Capacity> costs{};
};
