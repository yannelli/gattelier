#pragma once
#include <array>
#include <cstddef>
#include <cstdint>

class SerialApiLine {
public:
  static constexpr size_t MaxJsonBytes = 4096;
  bool feed(char value, uint32_t now) {
    expire(now);
    lastByte_ = now;
    if (value == '\n') {
      bool complete = !discarding_ && length_;
      if (length_ && bytes_[length_ - 1] == '\r') --length_;
      bytes_[length_] = 0;
      length_ = 0; discarding_ = false;
      return complete;
    }
    if (discarding_) return false;
    if (!value || length_ == bytes_.size() - 1) { length_ = 0; discarding_ = true; return false; }
    bytes_[length_++] = value;
    return false;
  }
  void expire(uint32_t now) {
    if (length_ && uint32_t(now - lastByte_) >= 1000) { length_ = 0; discarding_ = true; }
  }
  void reset() { length_ = 0; discarding_ = false; }
  const char* line() const { return bytes_.data(); }
private:
  std::array<char, MaxJsonBytes + 5> bytes_{};
  size_t length_ = 0;
  uint32_t lastByte_ = 0;
  bool discarding_ = false;
};

class SerialApiLease {
public:
  static constexpr uint32_t Duration = 90000;
  void renew(uint32_t now) { active_ = true; renewedAt_ = now; }
  void close() { active_ = false; }
  bool active() const { return active_; }
  bool expired(uint32_t now) const { return active_ && uint32_t(now - renewedAt_) >= Duration; }
private:
  bool active_ = false;
  uint32_t renewedAt_ = 0;
};

class SerialApiConnection {
public:
  bool lost(bool connected, uint32_t now) {
    if (connected) { missing_ = false; return false; }
    if (!missing_) { missing_ = true; missingSince_ = now; }
    return uint32_t(now - missingSince_) >= 1000;
  }
private:
  bool missing_ = false;
  uint32_t missingSince_ = 0;
};
