#include "ble_security.h"
#include "pairing_rules.h"
#include "state.h"
#include <NimBLEDevice.h>
#include <esp_random.h>

static NimBLEClient* peer;
static struct {
  String status = "idle", address, challengeId, display, error;
  bool active = false, encrypted = false, authenticated = false, bonded = false;
  uint16_t handle = BLE_HS_CONN_HANDLE_NONE;
  uint8_t keySize = 0;
  uint32_t started = 0;
} security;
static uint32_t challengeCounter = 0;

static String newChallenge() {
  char text[25];
  snprintf(text, sizeof(text), "%08lx%08lx%08lx", static_cast<unsigned long>(esp_random()),
    static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(++challengeCounter));
  return String(text);
}

static void clearPrompt(const String& status, const String& error = "") {
  security.active = false; security.status = status; security.error = error;
  security.challengeId = ""; security.display = "";
}

static void updateFlags(NimBLEConnInfo& info) {
  security.encrypted = info.isEncrypted(); security.authenticated = info.isAuthenticated();
  security.bonded = info.isBonded(); security.keySize = info.getSecKeySize();
}

static bool prompt(NimBLEConnInfo& info, const char* kind, uint32_t pin = 0) {
  StateLock lock;
  if (info.getConnHandle() != security.handle) return false;
  security.active = true; security.started = millis(); security.status = kind;
  security.error = ""; security.challengeId = newChallenge(); security.display = "";
  if (String(kind) != "passkey-input") {
    char text[7]; snprintf(text, sizeof(text), "%06lu", static_cast<unsigned long>(pin)); security.display = text;
  }
  return true;
}

static int securityGapEvent(ble_gap_event* event, void*) {
  if (event->type != BLE_GAP_EVENT_ENC_CHANGE || event->enc_change.status == 0) return 0;
  StateLock lock;
  if (event->enc_change.conn_handle == security.handle && security.active) {
    clearPrompt("failed", "Pairing failed (BLE code " + String(event->enc_change.status) + ").");
  }
  return 0;
}

void startSecuritySupport(NimBLEClient* client) {
  peer = client;
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_KEYBOARD_DISPLAY);
  NimBLEDevice::setSecurityAuth(true, true, true);
  if (!NimBLEDevice::setCustomGapHandler(securityGapEvent)) abort();
}

void securityConnected(NimBLEConnInfo& info) {
  StateLock lock;
  security.handle = info.getConnHandle(); security.address = info.getAddress().toString().c_str();
  updateFlags(info); clearPrompt(security.encrypted ? "secured" : "idle");
}

void securityDisconnected() {
  StateLock lock;
  security.handle = BLE_HS_CONN_HANDLE_NONE;
  security.encrypted = false; security.authenticated = false; security.bonded = false; security.keySize = 0;
  if (security.active) clearPrompt("failed", "Device disconnected during pairing.");
  else if (security.status != "failed" && security.status != "cancelled") clearPrompt("idle");
}

void securityPasskeyInput(NimBLEConnInfo& info) { prompt(info, "passkey-input"); }
void securityNumericComparison(NimBLEConnInfo& info, uint32_t pin) { prompt(info, "numeric-comparison", pin); }
uint32_t securityPasskeyDisplay(NimBLEConnInfo& info) {
  uint32_t pin = esp_random() % 1000000;
  prompt(info, "passkey-display", pin);
  return pin;
}

void securityAuthenticationComplete(NimBLEConnInfo& info) {
  StateLock lock;
  if (info.getConnHandle() != security.handle) return;
  updateFlags(info);
  clearPrompt(security.encrypted ? "secured" : "failed", security.encrypted ? "" : "The device did not enable encryption.");
}

void beginPairing() {
  {
    StateLock lock;
    if (!peer->isConnected()) { clearPrompt("failed", "The device disconnected before pairing started."); return; }
    auto info = peer->getConnInfo();
    if (info.getConnHandle() != security.handle) { clearPrompt("failed", "The BLE connection changed before pairing started."); return; }
    updateFlags(info);
    if (security.encrypted) { clearPrompt("secured"); return; }
    security.active = true; security.status = "pairing"; security.error = "";
    security.challengeId = newChallenge(); security.display = ""; security.started = millis();
  }
  if (!peer->secureConnection(true)) {
    StateLock lock;
    clearPrompt("failed", "Could not start pairing (BLE code " + String(peer->getLastError()) + ").");
  }
}

bool pairingActive() { return security.active; }

bool respondPairing(const String& address, const String& challengeId, const String& passkey, bool hasAccept, bool accept, String& error) {
  String kind; uint16_t handle;
  {
    StateLock lock;
    handle = peer->getConnHandle();
    if (!pairingChallengeMatches(security.active, security.handle, handle, security.address.c_str(), address.c_str(), security.challengeId.c_str(), challengeId.c_str()) || !pairingTimeRemaining(security.started, millis())) {
      error = "This pairing request expired or belongs to a different connection."; return false;
    }
    kind = security.status;
    if ((kind == "passkey-input" && hasAccept) || (kind == "numeric-comparison" && !hasAccept) || (kind != "passkey-input" && kind != "numeric-comparison")) {
      error = "The response does not match the current pairing request."; return false;
    }
    security.challengeId = newChallenge(); security.display = ""; security.status = "pairing";
  }
  auto info = peer->getConnInfo();
  if (!peer->isConnected() || info.getConnHandle() != handle) { error = "The device disconnected before the response was submitted."; return false; }
  uint32_t pin = 0;
  bool success = kind == "passkey-input" ? parsePairingPasskey(passkey.c_str(), pin) && NimBLEDevice::injectPassKey(info, pin)
    : NimBLEDevice::injectConfirmPasskey(info, accept);
  pin = 0;
  if (!success || (hasAccept && !accept)) {
    StateLock lock;
    clearPrompt(hasAccept && !accept ? "cancelled" : "failed", hasAccept && !accept ? "Pairing code rejected." : "The device rejected the pairing response.");
  }
  if (!success) error = "The device rejected the pairing response.";
  return success;
}

bool cancelPairing(const String& address, const String& challengeId, String& error) {
  {
    StateLock lock;
    if (!pairingChallengeMatches(security.active, security.handle, peer->getConnHandle(), security.address.c_str(), address.c_str(), security.challengeId.c_str(), challengeId.c_str())) {
      error = "This pairing request expired or belongs to a different connection."; return false;
    }
    clearPrompt("cancelled", "Pairing cancelled. The BLE connection was closed.");
  }
  if (!peer->disconnect()) { error = "Pairing cancelled; the device did not accept disconnection yet."; return false; }
  return true;
}

void updateSecurity() {
  bool expired = false;
  {
    StateLock lock;
    if (security.active && !pairingTimeRemaining(security.started, millis())) {
      clearPrompt("failed", "Pairing timed out. Reconnect and start pairing again."); expired = true;
    }
  }
  if (expired && peer->isConnected()) peer->disconnect();
}

void addSecurityState(cJSON* root) {
  StateLock lock;
  auto json = cJSON_AddObjectToObject(root, "security");
  cJSON_AddStringToObject(json, "status", security.status.c_str());
  cJSON_AddStringToObject(json, "address", security.address.c_str());
  cJSON_AddStringToObject(json, "challengeId", security.challengeId.c_str());
  cJSON_AddStringToObject(json, "error", security.error.c_str());
  cJSON_AddBoolToObject(json, "active", security.active);
  cJSON_AddBoolToObject(json, "encrypted", security.encrypted);
  cJSON_AddBoolToObject(json, "authenticated", security.authenticated);
  cJSON_AddBoolToObject(json, "bonded", security.bonded);
  cJSON_AddNumberToObject(json, "keySize", security.keySize);
  cJSON_AddNumberToObject(json, "remainingMs", security.active ? pairingTimeRemaining(security.started, millis()) : 0);
  if (security.display.length()) cJSON_AddStringToObject(json, "passkey", security.display.c_str());
  else cJSON_AddNullToObject(json, "passkey");
}
