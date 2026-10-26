#include <assert.h>
#include "../firmware/nanoscope/activity_led_timing.h"

int main() {
  ActivityLedTiming idle;
  assert(!idle.update(0, false));
  assert(!idle.update(100000, false));
  assert(!idle.update(UINT32_MAX, false));
  assert(!idle.update(0, false));

  ActivityLedTiming single;
  assert(single.update(100, true));
  assert(single.update(144, false));
  assert(!single.update(145, false));
  assert(!single.update(300, false));
  assert(!single.update(100000, false));
  assert(single.update(100001, true));
  assert(!single.update(100046, false));

  ActivityLedTiming flood;
  unsigned starts = 0;
  bool previous = false;
  for (uint32_t now = 0; now < 1000; ++now) {
    const bool lit = flood.update(now, true);
    assert(lit == (now % 200 < 45));
    if (lit && !previous) ++starts;
    previous = lit;
  }
  assert(starts == 5);
  assert(flood.update(1000, false));
  assert(!flood.update(1045, false));
  for (uint32_t now = 1046; now < 5000; ++now) assert(!flood.update(now, false));

  ActivityLedTiming coalesced;
  assert(coalesced.update(0, true));
  assert(coalesced.update(20, true));
  assert(!coalesced.update(45, true));
  assert(!coalesced.update(200, false));
  assert(coalesced.update(201, true));
  assert(!coalesced.update(246, false));
  assert(!coalesced.update(250, true));
  assert(!coalesced.update(400, false));
  assert(coalesced.update(401, false));
  assert(!coalesced.update(446, false));
  assert(!coalesced.update(1000, false));

  ActivityLedTiming rollover;
  assert(rollover.update(UINT32_MAX - 20, true));
  assert(rollover.update(23, false));
  assert(!rollover.update(24, false));
  assert(!rollover.update(25, true));
  assert(!rollover.update(178, false));
  assert(rollover.update(179, false));
  assert(!rollover.update(224, false));
  assert(!rollover.update(10000, false));

  ActivityLedTiming delayed;
  assert(delayed.update(0, true));
  assert(!delayed.update(1000, true));
  assert(!delayed.update(1001, true));
  assert(!delayed.update(1154, true));
  assert(delayed.update(1155, true));

  ActivityLedTiming testPulse;
  testPulse.test(100);
  assert(testPulse.update(100, false));
  assert(testPulse.update(399, false));
  assert(!testPulse.update(400, false));
  assert(!testPulse.update(555, false));
  assert(!testPulse.update(10000, false));
  testPulse.test(UINT32_MAX - 100);
  assert(testPulse.update(198, true));
  assert(!testPulse.update(199, true));
  assert(!testPulse.update(353, true));
  assert(testPulse.update(354, true));
  testPulse.test(355);
  assert(testPulse.update(654, false));
  assert(!testPulse.update(655, false));
}
