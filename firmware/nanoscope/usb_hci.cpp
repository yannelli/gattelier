#include "usb_hci.h"
#include "h4_frame.h"
#include "activity_led.h"
#include <Preferences.h>
#include <esp_bt.h>
#include <esp_hci_transport.h>
#include <esp_hci_internal.h>
#include <esp_log.h>
#include <esp32-hal-bt.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/ringbuf.h>
#include <atomic>
#include <algorithm>
#include <new>

struct UsbPacket { uint16_t size = 0; uint8_t bytes[H4Frame::Capacity] = {}; };
static Preferences preferences;
static bool hciMode = false, storageReady = false, running = false;
static uint32_t restartAt = 0, lastByteAt = 0, pendingAt = 0;
static String failure;
static QueueHandle_t inbound = nullptr;
// Variable-length items: a busy scan produces many ~45-byte reports, which fixed 1 KB slots dropped.
static RingbufHandle_t outbound = nullptr;
static H4Frame* parser = nullptr;
static uint8_t* tx = nullptr;
static size_t txSize = 0, txOffset = 0;
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
  auto mbuf = type == HCI_ACL_IND ? reinterpret_cast<os_mbuf*>(data) : nullptr;
  const size_t size = type == HCI_EVT_IND ? size_t(data[1]) + 3 : mbuf ? size_t(OS_MBUF_PKTLEN(mbuf)) + 1 : 0;
  uint8_t* slot = nullptr;
  const bool queued = size && size <= H4Frame::Capacity && xRingbufferSendAcquire(outbound, reinterpret_cast<void**>(&slot), size, 0) == pdTRUE;
  bool forwarded = false;
  if (queued) {
    slot[0] = uint8_t(type);
    if (mbuf) forwarded = os_mbuf_copydata(mbuf, 0, size - 1, slot + 1) == 0;
    else { memcpy(slot + 1, data, size - 1); forwarded = true; }
    // An acquired slot cannot be abandoned, so a failed copy is marked with H4 type 0 and skipped on output.
    if (!forwarded) slot[0] = 0;
    xRingbufferSendComplete(outbound, slot);
  }
  if (type == HCI_EVT_IND) r_ble_hci_trans_buf_free(data);
  else if (mbuf) os_mbuf_free_chain(mbuf);
  if (forwarded) { signalActivityLed(); ++received; }
  else ++dropped;
  return 0;
}

bool startUsbHci() {
  if (!hciMode) return false;
  btStarted();
  // Allocated here so workbench mode does not carry the 1 KB frame buffer.
  parser = new (std::nothrow) H4Frame();
  inbound = xQueueCreate(8, sizeof(UsbPacket));
  outbound = xRingbufferCreate(16 * 1024, RINGBUF_TYPE_NOSPLIT);
  if (!parser || !inbound || !outbound) { failure = "USB HCI queue allocation failed"; return false; }
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
  signalActivityLed();
  return true;
}

void updateUsbHci() {
  uint32_t now = millis();
  if (restartAt && int32_t(now - restartAt) >= 0) ESP.restart();
  if (!running) return;
  if (parser->pending() && uint32_t(now - lastByteAt) > 1000) { parser->reset(); ++rejected; }
  UsbPacket packet;
  for (unsigned count = 0; count < 2048 && Serial.available() && uxQueueSpacesAvailable(inbound); ++count) {
    signalActivityLed();
    lastByteAt = now;
    if (parser->feed(uint8_t(Serial.read()))) {
      packet.size = parser->length;
      memcpy(packet.bytes, parser->data, packet.size);
      if (xQueueSend(inbound, &packet, 0) != pdTRUE) ++dropped;
    }
  }
  // The head packet stays queued until the controller takes it or it has waited a second.
  while (xQueuePeek(inbound, &packet, 0) == pdTRUE) {
    if (!pendingAt) pendingAt = now;
    const bool forwarded = sendToController(packet);
    if (!forwarded && uint32_t(now - pendingAt) <= 1000) break;
    if (!forwarded) ++dropped;
    xQueueReceive(inbound, &packet, 0);
    pendingAt = 0;
  }
  if (!Serial) return;
  for (;;) {
    if (!tx) {
      tx = static_cast<uint8_t*>(xRingbufferReceive(outbound, &txSize, 0));
      txOffset = 0;
      if (!tx) break;
      if (!tx[0]) { vRingbufferReturnItem(outbound, tx); tx = nullptr; continue; }
    }
    const size_t room = size_t(std::max(0, Serial.availableForWrite()));
    const size_t written = room ? Serial.write(tx + txOffset, std::min(txSize - txOffset, room)) : 0;
    if (!written) break;
    txOffset += written;
    signalActivityLed();
    if (txOffset == txSize) { vRingbufferReturnItem(outbound, tx); tx = nullptr; }
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
  cJSON_AddNumberToObject(item, "rejectedBytes", rejected.load() + (parser ? parser->errors : 0));
  cJSON_AddNumberToObject(item, "maxAclBytes", H4Frame::Capacity - 5);
  cJSON_AddBoolToObject(item, "nativeUsbBluetoothClass", false);
}
