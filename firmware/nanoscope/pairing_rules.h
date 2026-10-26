#pragma once
#include <cstdint>
#include <cstring>

inline bool parsePairingPasskey(const char* text, uint32_t& value) {
  if (!text || std::strlen(text) != 6) return false;
  value = 0;
  for (size_t i = 0; i < 6; ++i) {
    if (text[i] < '0' || text[i] > '9') return false;
    value = value * 10 + uint32_t(text[i] - '0');
  }
  return true;
}

inline bool pairingChallengeMatches(bool active, uint16_t expectedHandle, uint16_t currentHandle,
    const char* expectedAddress, const char* address, const char* expectedId, const char* challengeId) {
  return active && expectedHandle == currentHandle && address && challengeId && *challengeId &&
    std::strcmp(expectedAddress, address) == 0 && std::strcmp(expectedId, challengeId) == 0;
}

inline uint32_t pairingTimeRemaining(uint32_t started, uint32_t now, uint32_t timeout = 30000) {
  const uint32_t elapsed = now - started;
  return elapsed >= timeout ? 0 : timeout - elapsed;
}
