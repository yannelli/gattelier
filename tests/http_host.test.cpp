#include "../firmware/nanoscope/http_host.h"
#include <cassert>
#include <cstdio>

int main() {
  for (const char* host : {"nanoscope.local", "NanoScope.Local.", "nanoscope.local:80", "nanoscope", "nanoscope.lan", "nanoscope.home.arpa",
                           "192.168.4.1", "10.0.0.7:8080", "[fe80::1]", "[fe80::1]:80", "board.internal", "localhost"}) {
    if (!boardHostAllowed(host)) { std::printf("rejected %s\n", host); return 1; }
  }
  for (const char* host : {"", "evil.example", "nanoscope.evil.example", "1.2.3.4.nip.io", "0x7f.0.0.1", "192.168.4", "256.1.1.1",
                           "nanoscope.local:", "nanoscope.local:123456", "nanoscope.local:8o", ".local", "evil.com.", "a b.local", "[]"}) {
    if (boardHostAllowed(host)) { std::printf("accepted %s\n", host); return 1; }
  }
  assert(!boardHostAllowed(nullptr));
  std::puts("PASS: board Host allowlist rejects public names used for DNS rebinding");
}
