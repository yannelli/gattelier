#pragma once
#include <stdint.h>

enum class NetworkButtonEvent { None, ShortPress, LongPress, TriplePress };

class NetworkButton {
  bool raw = false, stable = false, armed = false, longSent = false;
  uint32_t changedAt = 0, pressedAt = 0, releasedAt = 0;
  uint8_t clicks = 0;
 public:
  void begin(bool pressed, uint32_t now) {
    raw = stable = pressed;
    armed = !pressed; longSent = false; clicks = 0;
    changedAt = pressedAt = releasedAt = now;
  }
  bool update(bool pressed, uint32_t now) {
    if (pressed != raw) { raw = pressed; changedAt = now; }
    if (raw == stable || uint32_t(now - changedAt) < 30) return false;
    stable = raw;
    if (stable) { pressedAt = now; longSent = false; return false; }
    if (!armed) { armed = true; return false; }
    return uint32_t(now - pressedAt) <= 1500;
  }
  NetworkButtonEvent updateEvent(bool pressed, uint32_t now) {
    const bool shortPress = update(pressed, now);
    if (stable && raw && armed && !longSent && uint32_t(now - pressedAt) >= 3000) {
      longSent = true; clicks = 0; return NetworkButtonEvent::LongPress;
    }
    if (shortPress) {
      releasedAt = now;
      if (++clicks == 3) { clicks = 0; return NetworkButtonEvent::TriplePress; }
    }
    if (!stable && !raw && clicks && uint32_t(now - releasedAt) >= 400) {
      clicks = 0; return NetworkButtonEvent::ShortPress;
    }
    return NetworkButtonEvent::None;
  }
};
