#pragma once
#include <array>
#include <cstddef>
#include <cstdint>

template<size_t Capacity, size_t Budget>
class TraceRetention {
 public:
  uint32_t first = 1, last = 0;
  size_t used = 0;
  bool room(size_t cost) const { return last - first + 1 < Capacity && used + cost <= Budget; }
  bool empty() const { return first > last; }
  void discard() { if (!empty()) { used -= costs[(first - 1) % Capacity]; ++first; } }
  void append(size_t cost) { ++last; costs[(last - 1) % Capacity] = cost; used += cost; }
 private:
  std::array<size_t, Capacity> costs{};
};
