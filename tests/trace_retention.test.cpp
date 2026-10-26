#include "../firmware/nanoscope/trace_retention.h"
#include <cassert>

int main() {
  TraceRetention<256, 48 * 1024> burst;
  for (int i = 0; i < 230; ++i) { assert(burst.room(185)); burst.append(185); }
  assert(burst.first == 1 && burst.last == 230);
  for (int i = 0; i < 100; ++i) {
    while (!burst.empty() && !burst.room(1120)) burst.discard();
    burst.append(1120);
    assert(burst.used <= 48 * 1024);
    assert(burst.last - burst.first + 1 <= 256);
  }
  TraceRetention<3, 10> small;
  small.append(3); small.append(3); small.append(3);
  assert(!small.room(1)); small.discard(); assert(small.room(4));
  small.append(4); assert(small.used == 10 && small.first == 2);
  while (!small.empty()) small.discard();
  assert(small.used == 0 && small.first == 5 && small.room(10));
}
