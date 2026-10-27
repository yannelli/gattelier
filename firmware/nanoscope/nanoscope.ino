#include <Arduino.h>
#include "board_network.h"
#include "state.h"
#include "trace.h"
#include "ble_security.h"
#include "usb_hci.h"
#include "collection.h"

void setup() {
  if (Serial.setRxBufferSize(4224) != 4224) abort();
  // The 256-byte default throttles USB exports and HCI event forwarding.
  if (Serial.setTxBufferSize(4096) != 4096) abort();
  Serial.begin(115200);
  initUsbMode();
  stateMutex = xSemaphoreCreateMutex();
  if (!stateMutex) abort();
  startTrace();
  startCollection(!usbHciMode());
  if (!usbHciMode()) Serial.println("\nNanoScope booting");
  startNetwork();
  if (usbHciMode()) { state.scanEnabled = false; state.operation = "usb-hci"; startUsbHci(); }
  else startBle();
  startHttp();
}

void loop() {
  if (!usbHciMode()) handleSerialHttp();
  handleHttp();
  updateNetwork();
  updateUsbHci();
  if (!usbHciMode()) updateSecurity();
  if (!usbHciMode()) updateCollection();
  delay(2);
}
