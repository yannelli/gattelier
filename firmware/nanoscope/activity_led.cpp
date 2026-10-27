#include "activity_led.h"
#include "activity_led_timing.h"
#include <Arduino.h>
#include <Preferences.h>
#include <atomic>

static std::atomic<bool> activityPending{false};
static ActivityLedTiming timing;
static Preferences preferences;
static uint8_t brightness = 3, previousDuty = 0;
static bool storageReady = false, pwmReady = false;

void startActivityLed() {
  digitalWrite(ActivityPin, LOW);
  pinMode(ActivityPin, OUTPUT);
  pwmReady = ledcAttach(ActivityPin, 5000, 8);
  if (pwmReady) ledcWrite(ActivityPin, 0);
  storageReady = preferences.begin("nanoscope-led", false);
  const uint8_t stored = storageReady ? preferences.getUChar("brightness", 3) : 3;
  brightness = stored <= 100 ? stored : 3;
}

uint8_t activityLedBrightness() { return brightness; }
bool activityLedReady() { return pwmReady; }

bool setActivityLedBrightness(uint8_t value, String& error) {
  if (value > 100) { error = "LED brightness must be 0 to 100 percent."; return false; }
  if (!pwmReady) { error = "The activity LED PWM output is unavailable."; return false; }
  if (!storageReady || preferences.putUChar("brightness", value) != 1) {
    error = "LED brightness could not be saved.";
    return false;
  }
  brightness = value;
  updateActivityLed();
  return true;
}

bool testActivityLed(String& error) {
  if (!pwmReady) { error = "The activity LED PWM output is unavailable."; return false; }
  timing.test(millis());
  updateActivityLed();
  return true;
}

void signalActivityLed() {
  activityPending.store(true, std::memory_order_relaxed);
}

void updateActivityLed() {
  const bool lit = timing.update(millis(), activityPending.exchange(false, std::memory_order_relaxed));
  const uint8_t duty = lit ? (uint16_t(brightness) * 255 + 50) / 100 : 0;
  if (pwmReady && duty != previousDuty) {
    ledcWrite(ActivityPin, duty);
    previousDuty = duty;
  }
}
