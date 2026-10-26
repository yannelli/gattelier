#include <assert.h>
#include "../firmware/nanoscope/connection_cancellation.h"

int main() {
  ConnectionCancellation cancellation;
  assert(!cancellation.request(0));
  assert(!cancellation.request(1));
  const uint32_t queued = cancellation.begin();
  assert(!cancellation.requested(queued));
  assert(cancellation.request(queued));
  assert(cancellation.requested(queued));
  assert(cancellation.request(queued));
  cancellation.finish(queued);
  assert(!cancellation.request(queued));
  assert(cancellation.active() == 0);
  const uint32_t next = cancellation.begin();
  assert(next != queued);
  assert(!cancellation.request(queued));
  assert(!cancellation.requested(next));
  cancellation.finish(queued);
  assert(cancellation.active() == next);
  assert(cancellation.request(next));
  cancellation.finish(next);
  assert(cancellation.active() == 0);
  ConnectionCancellation reboot;
  reboot.seed(5000);
  const uint32_t restarted = reboot.begin();
  assert(restarted == 5001);
  assert(!reboot.request(queued));
  reboot.finish(restarted);
  reboot.seed(UINT32_MAX);
  assert(reboot.begin() == 1);
}
