#pragma once
#include <stdint.h>

class ActivityLedTiming {
 public:
  static constexpr uint32_t PulseMs = 45;
  static constexpr uint32_t GapMs = 155;
  static constexpr uint32_t TestMs = 300;

  void test(uint32_t now) {
    testing_ = true;
    lit_ = true;
    pending_ = false;
    changedAt_ = now;
  }

  bool update(uint32_t now, bool activity) {
    if (testing_) {
      if (uint32_t(now - changedAt_) < TestMs) return true;
      testing_ = false;
      lit_ = false;
      cooling_ = true;
      pending_ = activity;
      changedAt_ = now;
      return false;
    }
    if (lit_) {
      if (uint32_t(now - changedAt_) >= PulseMs) {
        lit_ = false;
        cooling_ = true;
        changedAt_ = now;
      }
      return lit_;
    }
    pending_ = pending_ || activity;
    if (pending_ && (!cooling_ || uint32_t(now - changedAt_) >= GapMs)) {
      pending_ = false;
      lit_ = true;
      changedAt_ = now;
    }
    return lit_;
  }

 private:
  uint32_t changedAt_ = 0;
  bool lit_ = false, cooling_ = false, pending_ = false, testing_ = false;
};
