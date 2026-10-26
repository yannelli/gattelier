#include <assert.h>
#include "../artifacts/usb-draft/h4_frame.h"
int main() {
  H4Frame frame;
  assert(!frame.feed(0xff));
  assert(frame.errors == 1);
  assert(!frame.feed(1)); assert(!frame.feed(3)); assert(!frame.feed(12));
  assert(frame.feed(0)); assert(frame.length == 4);
  uint8_t acl[] = {2, 1, 0, 3, 0, 4, 5, 6};
  for (unsigned i = 0; i < sizeof(acl); ++i) assert(frame.feed(acl[i]) == (i == sizeof(acl) - 1));
  assert(frame.length == sizeof(acl));
  uint8_t oversized[] = {2, 0, 0, 1, 4};
  for (auto byte : oversized) assert(!frame.feed(byte));
  for (int i = 0; i < 1025; ++i) assert(!frame.feed(1));
  assert(!frame.pending()); assert(frame.errors == 2);
  assert(!frame.feed(1)); assert(frame.pending()); frame.reset(); assert(!frame.pending());
  assert(!frame.feed(1)); assert(!frame.feed(3)); assert(!frame.feed(12)); assert(frame.feed(0));
}
