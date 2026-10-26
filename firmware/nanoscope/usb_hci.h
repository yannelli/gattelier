#pragma once
#include <Arduino.h>
#include <cJSON.h>
class BoardServer;
void initUsbMode();
bool usbHciMode();
bool startUsbHci();
void updateUsbHci();
bool queueUsbMode(bool hci, String& error);
void addUsbState(cJSON* target);
void registerUsbRoutes(BoardServer& server);
