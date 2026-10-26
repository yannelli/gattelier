#pragma once
#include <Arduino.h>
#include <cJSON.h>

class BoardServer;
struct NetworkChange {
  String mode, ssid, password, apSSID, apPassword;
  bool hasSSID = false, hasPassword = false, keepPassword = false;
  bool hasAPSSID = false, hasAPPassword = false;
};

void startNetwork();
void updateNetwork();
void addNetworkState(cJSON* wifi);
void registerNetworkRoutes(BoardServer& server);
bool setSerialWifiSuspended(bool suspended, String& error);
bool serialWifiSuspended();
void handleNetworkConsole(const String& line);
bool queueNetworkChange(const NetworkChange& change, String& error);
void deferNetworkApply();
String networkHotspotPassword();
