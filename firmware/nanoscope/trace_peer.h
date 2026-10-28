#pragma once
#include <stdint.h>
#include <string.h>
#include <strings.h>

struct TraceProvenance {
  uint32_t connectionAttempt = 0;
  uint8_t addressType = 0;
  bool hasAddressType = false, hasConnectionAttempt = false;

  TraceProvenance() = default;
  explicit TraceProvenance(uint8_t type) : addressType(type), hasAddressType(true) {}
  TraceProvenance(uint8_t type, uint32_t attempt)
    : connectionAttempt(attempt), addressType(type), hasAddressType(true), hasConnectionAttempt(true) {}
};

struct TracePeer {
  char address[18] = {};
  TraceProvenance provenance;

  TracePeer() = default;
  TracePeer(const char* address, uint8_t type, uint32_t attempt) : provenance(type, attempt) {
    strncpy(this->address, address, sizeof(this->address) - 1);
  }
  bool matches(const char* address, uint8_t type, uint32_t attempt) const {
    return provenance.hasAddressType && provenance.hasConnectionAttempt &&
      provenance.addressType == type && provenance.connectionAttempt == attempt &&
      strcasecmp(this->address, address) == 0;
  }
};
