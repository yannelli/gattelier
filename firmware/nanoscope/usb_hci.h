#pragma once
#include <Arduino.h>
#include <cJSON.h>
class WebServer;
void initUsbMode();
bool usbHciMode();
bool startUsbHci();
void updateUsbHci();
bool queueUsbMode(bool hci, String& error);
void addUsbState(cJSON* target);
void registerUsbRoutes(WebServer& server);
