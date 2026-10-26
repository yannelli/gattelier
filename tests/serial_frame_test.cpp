#include <assert.h>
#include <cstring>
#include <string>
#include "../firmware/nanoscope/serial_api_frame.h"

static bool feed(SerialApiLine& parser, const std::string& value, uint32_t now = 100) {
  bool complete = false;
  for (char byte : value) complete = parser.feed(byte, now);
  return complete;
}

int main() {
  SerialApiLine parser;
  assert(!feed(parser, "@G1 {\"v\":1}"));
  assert(feed(parser, "\n"));
  assert(!strcmp(parser.line(), "@G1 {\"v\":1}"));
  assert(feed(parser, "network status\r\n"));
  assert(!strcmp(parser.line(), "network status"));
  assert(!feed(parser, "\n"));

  std::string maximum = "@G1 " + std::string(SerialApiLine::MaxJsonBytes, 'x');
  assert(feed(parser, maximum + "\n"));
  assert(strlen(parser.line()) == maximum.size());
  assert(!feed(parser, maximum + "x"));
  assert(!feed(parser, "@G1 {\"id\":5}\n"));
  assert(feed(parser, "@G1 {}\n"));
  assert(!strcmp(parser.line(), "@G1 {}"));

  assert(!feed(parser, "@G1 {", 200));
  parser.expire(1199);
  assert(feed(parser, "}\n", 1199));
  assert(!feed(parser, "@G1 {", 2000));
  parser.expire(3000);
  assert(!feed(parser, "}\n", 3000));
  assert(feed(parser, "@G1 {}\n", 3000));

  assert(!feed(parser, "@G1 {", 4000));
  assert(!parser.feed('\0', 4000));
  assert(!feed(parser, "}\n", 4000));
  assert(feed(parser, "@G1 {}\n", 4000));
  assert(!feed(parser, "partial", 5000));
  parser.reset();
  assert(feed(parser, "network status\n", 5000));
  assert(!strcmp(parser.line(), "network status"));

  SerialApiLease lease;
  assert(!lease.active());
  assert(!lease.expired(90000));
  lease.renew(10);
  assert(lease.active());
  assert(!lease.expired(90009));
  assert(lease.expired(90010));
  lease.renew(90010);
  assert(!lease.expired(90011));
  lease.close();
  assert(!lease.active());
  assert(!lease.expired(999999));
  lease.renew(UINT32_MAX - 100);
  assert(!lease.expired(89898));
  assert(lease.expired(89899));

  SerialApiConnection connection;
  assert(!connection.lost(true, 0));
  assert(!connection.lost(false, 1));
  assert(!connection.lost(false, 900));
  assert(!connection.lost(true, 901));
  assert(!connection.lost(false, 902));
  assert(!connection.lost(false, 1901));
  assert(connection.lost(false, 1902));
  assert(!connection.lost(true, UINT32_MAX - 100));
  assert(!connection.lost(false, UINT32_MAX - 100));
  assert(!connection.lost(false, 898));
  assert(connection.lost(false, 899));
}
