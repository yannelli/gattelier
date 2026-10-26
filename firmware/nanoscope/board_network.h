#pragma once
#include <Arduino.h>
#include <cJSON.h>

class WebServer;
struct NetworkChange {
  String mode, ssid, password, apSSID, apPassword;
  bool hasSSID = false, hasPassword = false, keepPassword = false;
  bool hasAPSSID = false, hasAPPassword = false;
};

void startNetwork();
void updateNetwork();
void addNetworkState(cJSON* wifi);
void registerNetworkRoutes(WebServer& server);
bool queueNetworkChange(const NetworkChange& change, String& error);
void deferNetworkApply();
String networkHotspotPassword();
