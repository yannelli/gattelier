#pragma once
#include <Arduino.h>

class BoardServer;
constexpr uint8_t ActivityPin = 7;

void startActivityLed();
void signalActivityLed();
void updateActivityLed();
uint8_t activityLedBrightness();
bool activityLedReady();
bool setActivityLedBrightness(uint8_t brightness, String& error);
bool testActivityLed(String& error);
void registerActivityLedRoutes(BoardServer& server);
