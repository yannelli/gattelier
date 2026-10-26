#include "usb_hci.h"
#include "h4_frame.h"
#include <Preferences.h>
#include <esp_bt.h>
#include <esp_hci_transport.h>
#include <esp_hci_internal.h>
#include <esp_log.h>
#include <esp32-hal-bt.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <atomic>
#include <algorithm>

struct UsbPacket { uint16_t size = 0; uint8_t bytes[H4Frame::Capacity] = {}; };
static Preferences preferences;
static bool hciMode = false, storageReady = false, running = false;
static uint32_t restartAt = 0, lastByteAt = 0, pendingAt = 0;
static String failure;
static QueueHandle_t inbound = nullptr, outbound = nullptr;
static H4Frame parser;
static UsbPacket tx, rx;
static uint16_t txOffset = 0;
static std::atomic<uint32_t> received{0}, sent{0}, dropped{0}, rejected{0};

bool usbHciMode() { return hciMode; }

void initUsbMode() {
  storageReady = preferences.begin("nanoscope-usb", false);
  hciMode = storageReady && preferences.getBool("hci", false);
  if (hciMode) { esp_log_level_set("*", ESP_LOG_NONE); Serial.setDebugOutput(false); }
}

bool queueUsbMode(bool requested, String& error) {
  if (requested == hciMode && !restartAt) return true;
  if (!storageReady || preferences.putBool("hci", requested) != 1) {
    error = "USB mode could not be saved."; return false;
  }
  restartAt = millis() + 600;
  return true;
}

static int controllerPacket(hci_trans_pkt_ind_t type, uint8_t* data, uint16_t) {
  UsbPacket packet;
  packet.bytes[0] = uint8_t(type);
  if (type == HCI_EVT_IND) {
    packet.size = uint16_t(data[1]) + 3;
    memcpy(packet.bytes + 1, data, packet.size - 1);
    r_ble_hci_trans_buf_free(data);
  } else if (type == HCI_ACL_IND) {
    auto mbuf = reinterpret_cast<os_mbuf*>(data);
    size_t length = OS_MBUF_PKTLEN(mbuf);
    if (length <= H4Frame::Capacity - 1 && os_mbuf_copydata(mbuf, 0, length, packet.bytes + 1) == 0) packet.size = length + 1;
    os_mbuf_free_chain(mbuf);
  }
  if (!packet.size || xQueueSend(outbound, &packet, 0) != pdTRUE) ++dropped;
  else ++received;
  return 0;
}

bool startUsbHci() {
  if (!hciMode) return false;
  btStarted();
  inbound = xQueueCreate(8, sizeof(UsbPacket));
  outbound = xQueueCreate(16, sizeof(UsbPacket));
  if (!inbound || !outbound) { failure = "USB HCI queue allocation failed"; return false; }
  esp_bt_controller_config_t config = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
  esp_err_t result = esp_bt_controller_init(&config);
  if (result == ESP_OK && hci_transport_host_callback_register(controllerPacket)) result = ESP_FAIL;
  if (result == ESP_OK) result = esp_bt_controller_enable(ESP_BT_MODE_BLE);
  if (result != ESP_OK) { failure = String("Controller initialization: ") + esp_err_to_name(result); return false; }
  running = true;
  return true;
}

static bool sendToController(const UsbPacket& packet) {
  if (packet.bytes[0] == 1) {
    uint8_t* command = r_ble_hci_trans_buf_alloc(ESP_HCI_INTERNAL_BUF_CMD);
    if (!command) return false;
    memcpy(command, packet.bytes + 1, packet.size - 1);
    hci_transport_host_cmd_tx(command, packet.size - 1);
  } else {
    auto mbuf = os_msys_get_pkthdr(packet.size - 1, ESP_HCI_INTERNAL_ACL_MBUF_LEADINGSPCAE);
    if (!mbuf) return false;
    if (os_mbuf_append(mbuf, packet.bytes + 1, packet.size - 1)) { os_mbuf_free_chain(mbuf); return false; }
    hci_transport_host_acl_tx(reinterpret_cast<uint8_t*>(mbuf), packet.size - 1);
  }
  ++sent;
  return true;
}

void updateUsbHci() {
  uint32_t now = millis();
  if (restartAt && int32_t(now - restartAt) >= 0) ESP.restart();
  if (!running) return;
  if (parser.pending() && uint32_t(now - lastByteAt) > 1000) { parser.reset(); ++rejected; }
  for (unsigned count = 0; count < 256 && Serial.available() && uxQueueSpacesAvailable(inbound); ++count) {
    lastByteAt = now;
    if (parser.feed(uint8_t(Serial.read()))) {
      UsbPacket packet; packet.size = parser.length;
      memcpy(packet.bytes, parser.data, packet.size);
      if (xQueueSend(inbound, &packet, 0) != pdTRUE) ++dropped;
    }
  }
  if (!rx.size && xQueueReceive(inbound, &rx, 0) == pdTRUE) pendingAt = now;
  if (rx.size) {
    if (sendToController(rx)) rx.size = 0;
    else if (uint32_t(now - pendingAt) > 1000) { rx.size = 0; ++dropped; }
  }
  if (!Serial) return;
  if (!tx.size && xQueueReceive(outbound, &tx, 0) == pdTRUE) txOffset = 0;
  if (tx.size) {
    size_t count = std::min(size_t(tx.size - txOffset), size_t(std::max(0, Serial.availableForWrite())));
    if (count) txOffset += Serial.write(tx.bytes + txOffset, count);
    if (txOffset == tx.size) tx.size = txOffset = 0;
  }
}

void addUsbState(cJSON* item) {
  cJSON_AddStringToObject(item, "mode", hciMode ? "hci" : "workbench");
  cJSON_AddStringToObject(item, "transport", "H4 over USB CDC serial");
  cJSON_AddBoolToObject(item, "ready", running);
  cJSON_AddBoolToObject(item, "restarting", restartAt != 0);
  cJSON_AddBoolToObject(item, "storageReady", storageReady);
  cJSON_AddStringToObject(item, "error", failure.c_str());
  cJSON_AddNumberToObject(item, "controllerPackets", received.load());
  cJSON_AddNumberToObject(item, "hostPackets", sent.load());
  cJSON_AddNumberToObject(item, "droppedPackets", dropped.load());
  cJSON_AddNumberToObject(item, "rejectedBytes", rejected.load() + parser.errors);
  cJSON_AddNumberToObject(item, "maxAclBytes", H4Frame::Capacity - 5);
  cJSON_AddBoolToObject(item, "nativeUsbBluetoothClass", false);
}
