#include "board_network.h"
#include "usb_hci.h"
#include "collection.h"
#include "network_button.h"
#include "activity_led.h"
#include "state.h"
#include "serial_api.h"
#include "secrets.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <esp_mac.h>
#include <ctype.h>
#include <algorithm>

#ifndef HOTSPOT_PASSWORD
#define HOTSPOT_PASSWORD "nanoscope"
#endif
static_assert(sizeof(HOTSPOT_PASSWORD) - 1 >= 8 && sizeof(HOTSPOT_PASSWORD) - 1 <= 63, "HOTSPOT_PASSWORD must contain 8 to 63 bytes");

static Preferences preferences;
static NetworkButton button;
// The board has no display, so a fresh board uses a documented hotspot password until the user changes it.
static String stationSSID = WIFI_SSID, stationPassword = WIFI_PASSWORD, apSSID, apPassword = HOTSPOT_PASSWORD;
static String requestedMode = "station", actualMode = "station", pendingMode, networkError, resumeMode;
static bool storageReady = false, apActive = false, previousConnected = false, mdnsActive = false;
static bool wifiSuspended = false;
static uint32_t applyAt = 0, connectingSince = 0, lastRetry = 0, lastMdns = 0;
static const IPAddress apIP(192, 168, 4, 1), netmask(255, 255, 255, 0);

static bool validPassword(const String& value, bool allowOpen) {
  if (allowOpen && value.isEmpty()) return true;
  if (value.length() >= 8 && value.length() <= 63) return true;
  if (value.length() != 64) return false;
  for (size_t i = 0; i < value.length(); ++i) if (!isxdigit(static_cast<unsigned char>(value[i]))) return false;
  return true;
}

static bool saveConfig(const String& mode, const String& ssid, const String& password,
                       const String& hotspotSSID, const String& hotspotPassword) {
  if (!storageReady) return false;
  auto json = cJSON_CreateObject();
  cJSON_AddStringToObject(json, "mode", mode.c_str());
  cJSON_AddStringToObject(json, "ssid", ssid.c_str());
  cJSON_AddStringToObject(json, "password", password.c_str());
  cJSON_AddStringToObject(json, "apSSID", hotspotSSID.c_str());
  cJSON_AddStringToObject(json, "apPassword", hotspotPassword.c_str());
  char* encoded = cJSON_PrintUnformatted(json);
  bool saved = encoded && preferences.putString("config", encoded) == strlen(encoded);
  cJSON_free(encoded); cJSON_Delete(json);
  return saved;
}

static void announce() {
  MDNS.end();
  mdnsActive = MDNS.begin("nanoscope");
  lastMdns = millis();
  if (mdnsActive) MDNS.addService("http", "tcp", 80);
}

static void hotspot(bool recovery) {
  MDNS.end(); mdnsActive = false; previousConnected = false;
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false, 0);
  actualMode = "hotspot";
  apActive = WiFi.mode(WIFI_AP) && WiFi.softAPConfig(apIP, apIP, netmask) &&
    WiFi.softAP(apSSID.c_str(), apPassword.c_str(), 1, 0, 4, false, WIFI_AUTH_WPA2_PSK);
  if (!apActive) { networkError = "Hotspot could not start. Press the button to retry station mode."; return; }
  if (!recovery) networkError = "";
  announce();
  if (!usbHciMode() && !serialApiActive()) Serial.printf("Gattelier hotspot: %s http://%s/ password: %s\n", apSSID.c_str(), apIP.toString().c_str(), apPassword.c_str());
}

static void station() {
  MDNS.end(); mdnsActive = false; previousConnected = false; networkError = "";
  WiFi.softAPdisconnect(false); apActive = false; actualMode = "station";
  connectingSince = lastRetry = millis();
  // The core applies the hostname to the STA netif inside WiFi.mode(), so it must be set first.
  WiFi.setHostname("nanoscope");
  if (!WiFi.mode(WIFI_STA)) { networkError = "Station interface could not start."; hotspot(true); return; }
  WiFi.setAutoReconnect(true);
  WiFi.begin(stationSSID.c_str(), stationPassword.isEmpty() ? nullptr : stationPassword.c_str());
}

bool serialWifiSuspended() { return wifiSuspended; }

bool setSerialWifiSuspended(bool suspended, String& error) {
  if (suspended == wifiSuspended) return true;
  if (suspended) {
    resumeMode = actualMode;
    setHttpEnabled(false);
    MDNS.end(); mdnsActive = false; previousConnected = false;
    WiFi.setAutoReconnect(false);
    if (!WiFi.mode(WIFI_OFF)) {
      error = "Wi-Fi could not pause. USB remains available with Wi-Fi enabled.";
      if (resumeMode == "hotspot") hotspot(false); else station();
      setHttpEnabled(true);
      return false;
    }
    apActive = false; wifiSuspended = true;
    return true;
  }
  wifiSuspended = false;
  String mode = pendingMode.isEmpty() ? resumeMode : pendingMode;
  pendingMode = "";
  if (mode == "hotspot") hotspot(false); else station();
  setHttpEnabled(true);
  return true;
}

bool queueNetworkChange(const NetworkChange& change, String& error) {
  if (!change.mode.isEmpty() && change.mode != "station" && change.mode != "hotspot") { error = "Mode must be station or hotspot."; return false; }
  if (change.hasSSID && (change.ssid.isEmpty() || change.ssid.length() > 32)) { error = "Wi-Fi SSID must contain 1 to 32 UTF-8 bytes."; return false; }
  if (change.hasPassword && !validPassword(change.password, true)) { error = "Wi-Fi password must be empty, 8 to 63 bytes, or 64 hexadecimal digits."; return false; }
  if (change.hasSSID && change.ssid != stationSSID && !change.hasPassword && !change.keepPassword) { error = "Provide a password for the changed SSID, or set keepPassword to true."; return false; }
  if (change.hasAPSSID && (change.apSSID.isEmpty() || change.apSSID.length() > 32)) { error = "Hotspot SSID must contain 1 to 32 UTF-8 bytes."; return false; }
  if (change.hasAPPassword && !validPassword(change.apPassword, false)) { error = "Hotspot password must contain 8 to 63 bytes, or 64 hexadecimal digits."; return false; }
  bool stationChanged = change.hasSSID || change.hasPassword, apChanged = change.hasAPSSID || change.hasAPPassword;
  if (change.mode.isEmpty() && !stationChanged && !apChanged) { error = "Provide a network mode or credentials to save."; return false; }
  String mode = change.mode.isEmpty() ? (stationChanged ? "station" : requestedMode) : change.mode;
  String ssid = change.hasSSID ? change.ssid : stationSSID, password = change.hasPassword ? change.password : stationPassword;
  String hotspotSSID = change.hasAPSSID ? change.apSSID : apSSID, hotspotPassword = change.hasAPPassword ? change.apPassword : apPassword;
  if (!saveConfig(mode, ssid, password, hotspotSSID, hotspotPassword)) { error = "Network settings could not be saved to device storage."; return false; }
  requestedMode = mode; stationSSID = ssid; stationPassword = password; apSSID = hotspotSSID; apPassword = hotspotPassword;
  if (!change.mode.isEmpty() || stationChanged || (apChanged && actualMode == "hotspot")) {
    pendingMode = !change.mode.isEmpty() || stationChanged ? mode : actualMode;
    applyAt = millis() + 750;
  }
  return true;
}

String networkHotspotPassword() { return apPassword; }
void deferNetworkApply() { if (!pendingMode.isEmpty()) applyAt = millis() + 750; }

void addNetworkState(cJSON* wifi) {
  bool connected = !wifiSuspended && actualMode == "station" && WiFi.status() == WL_CONNECTED;
  String ssid = apActive ? WiFi.softAPSSID() : connected ? WiFi.SSID() : stationSSID;
  String ip = apActive ? apIP.toString() : connected ? WiFi.localIP().toString() : "";
  const char* status = wifiSuspended ? "usb-paused" : apActive ? "hotspot" : connected ? "station-connected" : networkError.isEmpty() ? "station-connecting" : "error";
  const char* led = wifiSuspended ? "cyan" : apActive ? "amber" : connected ? "blue" : networkError.isEmpty() ? "blue-blink" : "red";
  cJSON_AddBoolToObject(wifi, "suspendedForUsb", wifiSuspended);
  cJSON_AddBoolToObject(wifi, "connected", connected || apActive);
  cJSON_AddBoolToObject(wifi, "stationConnected", connected); cJSON_AddBoolToObject(wifi, "apActive", apActive);
  cJSON_AddStringToObject(wifi, "mode", wifiSuspended ? "usb" : actualMode.c_str()); cJSON_AddStringToObject(wifi, "requestedMode", requestedMode.c_str());
  cJSON_AddStringToObject(wifi, "status", status); cJSON_AddStringToObject(wifi, "ssid", ssid.c_str());
  cJSON_AddStringToObject(wifi, "networkSSID", ssid.c_str()); cJSON_AddStringToObject(wifi, "ip", ip.c_str());
  cJSON_AddStringToObject(wifi, "configuredSSID", stationSSID.c_str()); cJSON_AddStringToObject(wifi, "apSSID", apSSID.c_str());
  cJSON_AddStringToObject(wifi, "apIP", apIP.toString().c_str()); cJSON_AddStringToObject(wifi, "led", led);
  cJSON_AddStringToObject(wifi, "error", wifiSuspended ? "" : networkError.c_str()); cJSON_AddNumberToObject(wifi, "buttonPin", 9);
  cJSON_AddBoolToObject(wifi, "passwordSet", !stationPassword.isEmpty()); cJSON_AddBoolToObject(wifi, "stationPasswordSet", !stationPassword.isEmpty());
  cJSON_AddBoolToObject(wifi, "apPasswordSet", !apPassword.isEmpty()); cJSON_AddBoolToObject(wifi, "apPasswordDefault", apPassword == HOTSPOT_PASSWORD); cJSON_AddBoolToObject(wifi, "pending", !pendingMode.isEmpty());
  cJSON_AddNumberToObject(wifi, "applyAfterMs", pendingMode.isEmpty() ? 0 : std::max(int32_t(0), int32_t(applyAt - millis())));
}

void startNetwork() {
  startActivityLed();
  pinMode(9, INPUT_PULLUP); pinMode(19, OUTPUT); digitalWrite(19, HIGH);
  button.begin(digitalRead(9) == LOW, millis()); rgbLedWrite(20, 0, 0, 24);
  uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char generatedSSID[32]; snprintf(generatedSSID, sizeof(generatedSSID), "NanoScope-%02X%02X%02X", mac[3], mac[4], mac[5]);
  apSSID = generatedSSID;
  storageReady = preferences.begin("nanoscope-net", false);
  String stored = storageReady ? preferences.getString("config", "") : "";
  auto json = cJSON_Parse(stored.c_str());
  auto read = [&](const char* key, String& target) {
    auto value = cJSON_GetObjectItemCaseSensitive(json, key);
    if (cJSON_IsString(value)) target = value->valuestring;
  };
  if (cJSON_IsObject(json)) {
    String ssid, password, hotspotSSID, hotspotPassword, mode;
    read("ssid", ssid); read("password", password); read("apSSID", hotspotSSID); read("apPassword", hotspotPassword); read("mode", mode);
    if (ssid.length() && ssid.length() <= 32 && validPassword(password, true)) { stationSSID = ssid; stationPassword = password; }
    if (hotspotSSID.length() && hotspotSSID.length() <= 32) apSSID = hotspotSSID;
    if (validPassword(hotspotPassword, false)) apPassword = hotspotPassword;
    if (mode == "station" || mode == "hotspot") requestedMode = mode;
  }
  cJSON_Delete(json);
  if (!saveConfig(requestedMode, stationSSID, stationPassword, apSSID, apPassword) && !usbHciMode()) Serial.println("Network settings storage is unavailable");
  WiFi.persistent(false);
  if (requestedMode == "hotspot") hotspot(false); else station();
}

void handleNetworkConsole(const String& line) {
    if (serialApiActive()) return;
    if (line == "network status") {
      auto json = cJSON_CreateObject(); addNetworkState(json);
      char* encoded = cJSON_PrintUnformatted(json); if (encoded) { Serial.print("NETWORK "); Serial.println(encoded); }
      cJSON_free(encoded); cJSON_Delete(json);
    } else if (line == "network station" || line == "network hotspot") {
      NetworkChange change; change.mode = line.substring(8); String error;
      Serial.println(queueNetworkChange(change, error) ? "Network mode change queued" : error);
    }
}

void updateNetwork() {
  updateActivityLed();
  uint32_t now = millis();
  auto buttonEvent = button.updateEvent(digitalRead(9) == LOW, now);
  if (buttonEvent == NetworkButtonEvent::TriplePress) { String error; queueUsbMode(!usbHciMode(), error); }
  if (buttonEvent == NetworkButtonEvent::LongPress && !usbHciMode()) collectionToggle();
  if (buttonEvent == NetworkButtonEvent::ShortPress) {
    String error;
    if (wifiSuspended) setSerialWifiSuspended(false, error);
    else {
      NetworkChange change; change.mode = actualMode == "hotspot" ? "station" : "hotspot";
      if (!queueNetworkChange(change, error) && !usbHciMode() && !serialApiActive()) Serial.println(error);
    }
  }
  if (!wifiSuspended && !pendingMode.isEmpty() && int32_t(now - applyAt) >= 0) {
    String mode = pendingMode; pendingMode = "";
    if (mode == "hotspot") hotspot(false); else station();
  }
  now = millis();
  bool connected = !wifiSuspended && actualMode == "station" && WiFi.status() == WL_CONNECTED;
  if (connected && !previousConnected) {
    networkError = ""; announce();
    if (!usbHciMode() && !serialApiActive()) Serial.printf("Gattelier ready: http://%s/ (http://nanoscope.local/)\n", WiFi.localIP().toString().c_str());
  }
  if (!wifiSuspended && actualMode == "station" && !connected) {
    if (previousConnected) { connectingSince = lastRetry = now; MDNS.end(); mdnsActive = false; }
    if (uint32_t(now - connectingSince) >= 30000) {
      networkError = "Wi-Fi connection failed after 30 seconds. Hotspot recovery is active."; hotspot(true);
    } else if (uint32_t(now - lastRetry) >= 10000) { lastRetry = now; WiFi.reconnect(); }
  }
  previousConnected = connected;
  if ((connected || apActive) && !mdnsActive && uint32_t(now - lastMdns) >= 10000) announce();
  uint32_t color = wifiSuspended ? 0x000808 : apActive ? 0x201000 : connected ? 0x000020 : !networkError.isEmpty() ? 0x200000 : now % 1000 < 500 ? 0x000020 : 0;
  if (usbHciMode() && now % 1500 < 250) color = 0x180020;
  if (!usbHciMode()) color = collectionLedColor(color, now);
  static uint32_t previousColor = 0xffffffff;
  if (color != previousColor) { rgbLedWrite(20, color >> 16, color >> 8, color); previousColor = color; }
}
