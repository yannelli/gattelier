#pragma once
#include <atomic>
#include <stdint.h>

class ConnectionCancellation {
 public:
  void seed(uint32_t value) { sequence_ = value; }
  uint32_t begin() {
    if (++sequence_ == 0) ++sequence_;
    cancelled_.store(0);
    active_.store(sequence_);
    return sequence_;
  }
  bool request(uint32_t attempt) {
    if (!attempt || active_.load() != attempt) return false;
    cancelled_.store(attempt);
    return true;
  }
  bool requested(uint32_t attempt) const { return attempt && cancelled_.load() == attempt; }
  uint32_t active() const { return active_.load(); }
  void finish(uint32_t attempt) { if (active_.load() == attempt) active_.store(0); }

 private:
  uint32_t sequence_ = 0;
  std::atomic<uint32_t> active_{0}, cancelled_{0};
};
