#pragma once
#include <Arduino.h>
#include <cJSON.h>

class NimBLEClient;
class NimBLEConnInfo;
class BoardServer;
void startSecuritySupport(NimBLEClient* client);
void securityConnected(NimBLEConnInfo& info);
void securityDisconnected();
void securityPasskeyInput(NimBLEConnInfo& info);
void securityNumericComparison(NimBLEConnInfo& info, uint32_t pin);
uint32_t securityPasskeyDisplay(NimBLEConnInfo& info);
void securityAuthenticationComplete(NimBLEConnInfo& info);
void beginPairing();
bool pairingActive();
bool respondPairing(const String& address, const String& challengeId, const String& passkey, bool hasAccept, bool accept, String& error);
bool cancelPairing(const String& address, const String& challengeId, String& error);
void updateSecurity();
void addSecurityState(cJSON* root);
void registerSecurityRoutes(BoardServer& server);
