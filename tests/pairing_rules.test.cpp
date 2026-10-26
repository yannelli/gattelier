#include "../firmware/nanoscope/pairing_rules.h"
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <initializer_list>

int main() {
  uint32_t pin = 0;
  assert(parsePairingPasskey("000000", pin) && pin == 0);
  assert(parsePairingPasskey("000123", pin) && pin == 123);
  assert(parsePairingPasskey("999999", pin) && pin == 999999);
  for (const char* invalid : {"", "1234", "1234567", "12345x", "-12345", "123 45"}) assert(!parsePairingPasskey(invalid, pin));
  assert(!parsePairingPasskey(nullptr, pin));
  const char* address = "aa:bb:cc:dd:ee:ff";
  const char* challenge = "1234567890abcdef12345678";
  assert(pairingChallengeMatches(true, 1, 1, address, address, challenge, challenge));
  assert(!pairingChallengeMatches(false, 1, 1, address, address, challenge, challenge));
  assert(!pairingChallengeMatches(true, 1, 2, address, address, challenge, challenge));
  assert(!pairingChallengeMatches(true, 1, 1, address, "11:22:33:44:55:66", challenge, challenge));
  assert(!pairingChallengeMatches(true, 1, 1, address, address, challenge, "stale"));
  assert(!pairingChallengeMatches(true, 1, 1, address, address, "", ""));
  assert(pairingTimeRemaining(1000, 1000) == 30000);
  assert(pairingTimeRemaining(1000, 30999) == 1);
  assert(pairingTimeRemaining(1000, 31000) == 0);
  assert(pairingTimeRemaining(UINT32_MAX - 100, 99) == 29800);
  puts("PASS: six-digit pairing passkeys, stale connection/challenge rejection, timeout and uptime wrap");
}
