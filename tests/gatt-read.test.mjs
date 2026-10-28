import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('characteristic reads report ATT results and bound long values without automatic pairing', () => {
  const source = readFileSync(new URL('../firmware/nanoscope/gatt_actions.cpp', import.meta.url), 'utf8');
  const start = source.indexOf('static String readError('), end = source.indexOf('static void writeCharacteristic(');
  const callbackStart = source.indexOf('static int onAttributeRead('), callbackEnd = source.indexOf('\nint readAttribute(');
  assert.ok(start >= 0 && end > start && callbackStart >= 0 && callbackEnd > callbackStart);
  const directory = mkdtempSync(join(tmpdir(), 'gatt-read-'));
  try {
    writeFileSync(join(directory, 'test.cpp'), `
#include <cassert>
#include <cstdint>
#include <string>
class String : public std::string {
 public:
  using std::string::string;
  String(std::string value) : std::string(value) {}
  String(int value) : std::string(std::to_string(value)) {}
};
#define BLE_HS_ATT_ERR(code) (0x100 + (code))
#define BLE_ATT_ATTR_MAX_LEN 512
#define BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN 0x0d
#define BLE_ATT_ERR_ATTR_NOT_LONG 0x0b
#define BLE_ATT_ERR_INVALID_OFFSET 0x07
#define BLE_HS_EDONE 14
#define SLIST_NEXT(item, field) ((item)->field)
struct os_mbuf { const uint8_t* om_data; size_t om_len; os_mbuf* om_next; };
struct ble_gatt_error { int status; };
struct ble_gatt_attr { os_mbuf* om; };
struct NimBLETaskData { void* m_pBuf; };
int releases = 0, releasedCode = -1;
struct NimBLEUtils {
  static void taskRelease(NimBLETaskData& task, int code) {
    assert(++releases == 1); releasedCode = code; delete &task;
  }
};
struct StateLock {};
struct { String error; } state;
struct NimBLEClient {};
struct NimBLERemoteCharacteristic {
  NimBLEClient client;
  NimBLEClient* getClient() { return &client; }
  uint16_t getHandle() { return 7; }
};
int result = 0, reads = 0;
bool success = false;
size_t tracedBytes = 0;
String reported;
int readAttribute(NimBLEClient*, uint16_t handle, std::string& value) {
  assert(handle == 7); ++reads; value = result ? "partial" : ""; return result;
}
void updateValue(uint16_t handle, const uint8_t*, size_t, const String& error) { assert(handle == 7); reported = error; }
void recordTrace(const char*, const String&, const String&, uint16_t, const uint8_t*, size_t size, const String&, bool ok) { success = ok; tracedBytes = size; }
${source.slice(start, end)}
${source.slice(callbackStart, callbackEnd)}
int main() {
  NimBLERemoteCharacteristic characteristic;
  readCharacteristic(&characteristic, "address", "uuid");
  assert(reads == 1 && success && reported.empty());
  for (const auto code : { 0x105, 0x108, 0x10c, 0x10f, 534 }) {
    result = code; readCharacteristic(&characteristic, "address", "uuid");
    assert(!success && tracedBytes == 0 && reported == state.error);
    assert(reported.find("BLE code " + std::to_string(code)) != std::string::npos);
    assert(reported.find("BLE code 0") == std::string::npos);
    if (code == 0x105) assert(reported.find("authentication") != std::string::npos);
    if (code == 0x10f) assert(reported.find("encryption") != std::string::npos);
  }
  const uint8_t bytes[513] = {};
  const ble_gatt_error ok{0}, done{BLE_HS_EDONE};
  for (const auto chunkSize : {512, 513}) {
    std::string value;
    auto* task = new NimBLETaskData{&value};
    os_mbuf chunk{bytes, static_cast<size_t>(chunkSize), nullptr};
    ble_gatt_attr attr{&chunk}; releases = 0;
    const int rc = onAttributeRead(0, &ok, &attr, task);
    if (chunkSize == 512) {
      assert(rc == 0 && value.size() == 512 && releases == 0);
      onAttributeRead(0, &done, nullptr, task);
      assert(releases == 1 && releasedCode == 0);
    } else {
      assert(rc == BLE_HS_ATT_ERR(BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN));
      assert(value.empty() && releases == 1 && releasedCode == rc);
    }
  }
  for (const auto secondSize : {212, 213}) {
    std::string value;
    auto* task = new NimBLETaskData{&value};
    os_mbuf second{bytes, static_cast<size_t>(secondSize), nullptr}, first{bytes, 300, &second};
    ble_gatt_attr attr{&first}; releases = 0;
    const int rc = onAttributeRead(0, &ok, &attr, task);
    if (secondSize == 212) {
      assert(rc == 0 && value.size() == 512 && releases == 0);
      os_mbuf extra{bytes, 1, nullptr}; attr.om = &extra;
      const int overflow = onAttributeRead(0, &ok, &attr, task);
      assert(overflow == BLE_HS_ATT_ERR(BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN));
      assert(value.size() == 512 && releases == 1 && releasedCode == overflow);
    } else {
      assert(rc == BLE_HS_ATT_ERR(BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN));
      assert(value.size() == 300 && releases == 1 && releasedCode == rc);
    }
  }
}
`);
    const compile = spawnSync('c++', ['-std=c++17', join(directory, 'test.cpp'), '-o', join(directory, 'test')], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
    const run = spawnSync(join(directory, 'test'), [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
