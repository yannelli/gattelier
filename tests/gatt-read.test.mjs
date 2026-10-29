import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('GATT operations enforce peer scope and reads report bounded ATT results without automatic pairing', () => {
  const source = readFileSync(new URL('../firmware/nanoscope/gatt_actions.cpp', import.meta.url), 'utf8');
  const stateSource = readFileSync(new URL('../firmware/nanoscope/state.h', import.meta.url), 'utf8');
  const start = source.indexOf('static CharacteristicInfo* findEntry(');
  const readStart = source.indexOf('\nint readAttribute('), readEnd = source.indexOf('\nstatic void readDescriptor(');
  assert.ok(start >= 0 && readStart > start && readEnd > readStart);
  const directory = mkdtempSync(join(tmpdir(), 'gatt-read-'));
  try {
    writeFileSync(join(directory, 'test.cpp'), `
#include <cassert>
#include <cstdint>
#include <string>
#include <vector>
#include <algorithm>
#include ${JSON.stringify(fileURLToPath(new URL('../firmware/nanoscope/trace_peer.h', import.meta.url)))}
#include ${JSON.stringify(fileURLToPath(new URL('../firmware/nanoscope/gatt_properties.h', import.meta.url)))}
class String : public std::string {
 public:
  using std::string::string;
  String() = default;
  String(std::string value) : std::string(value) {}
  String(int value) : std::string(std::to_string(value)) {}
  bool isEmpty() const { return empty(); }
};
${stateSource.slice(stateSource.indexOf('struct ServiceDataInfo'), stateSource.indexOf('extern AppState state;'))}
${stateSource.slice(stateSource.indexOf('enum class Action'), stateSource.indexOf('\nvoid startBle();'))}
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
AppState state;
int result = 0, reads = 0, writes = 0, subscribes = 0, unsubscribes = 0, lookups = 0, descriptorLookups = 0;
struct NimBLEUUID {
  explicit NimBLEUUID(uint16_t = 0) {}
  std::string toString() const { return "uuid"; }
};
struct NimBLERemoteCharacteristic;
struct NimBLEClient {
  NimBLERemoteCharacteristic* characteristic = nullptr;
  bool isConnected() const { return true; }
  NimBLERemoteCharacteristic* getCharacteristic(uint32_t handle) { ++lookups; return handle == 7 ? characteristic : nullptr; }
  uint16_t getMTU() const { return 247; }
  int getLastError() const { return 0; }
};
struct NimBLERemoteCharacteristic {
  NimBLEClient* client;
  NimBLEClient* getClient() { return client; }
  uint16_t getHandle() { return 7; }
  NimBLEUUID getUUID() const { return NimBLEUUID(); }
  bool canRead() const { return true; }
  bool canWrite() const { return true; }
  bool canWriteNoResponse() const { return true; }
  bool canNotify() const { return true; }
  bool canIndicate() const { return true; }
  void* getDescriptor(NimBLEUUID) { ++descriptorLookups; return this; }
  bool writeValue(const uint8_t*, size_t, bool) { ++writes; return true; }
  template<typename Callback> bool subscribe(bool, Callback, bool) { ++subscribes; return true; }
  bool unsubscribe(bool) { ++unsubscribes; return true; }
};
bool success = false;
size_t tracedBytes = 0;
TracePeer tracedPeer;
int readAttribute(NimBLEClient*, uint16_t handle, std::string& value) {
  assert(handle == 7 || handle == 8); ++reads; value = result ? "partial" : ""; return result;
}
void updateValue(uint16_t, const uint8_t*, size_t, const String& error = "", const TracePeer* peer = nullptr);
String hexBytes(const uint8_t*, size_t) { return ""; }
void resetCalls() {
  reads = writes = subscribes = unsubscribes = lookups = descriptorLookups = 0;
  state.error = ""; success = false; tracedPeer = TracePeer{};
}
void recordTrace(const char*, const String& address, const String&, uint16_t, const uint8_t*, size_t size, const String&, bool ok, const TraceProvenance& provenance) {
  success = ok; tracedBytes = size; tracedPeer = TracePeer(address.c_str(), provenance.addressType, provenance.connectionAttempt);
  tracedPeer.provenance = provenance;
}
${source.slice(start, readStart)}
${source.slice(readEnd)}
int main() {
  NimBLEClient client;
  NimBLERemoteCharacteristic characteristic{&client}; client.characteristic = &characteristic;
  const TracePeer peer("AA:BB:CC:DD:EE:FF", 0, 7);
  state.connected = true; state.address = peer.address; state.connectionAttempt = 7;
  CharacteristicInfo entry;
  entry.handle = 7; entry.properties = GattRead | GattWrite | GattWriteNoResponse | GattNotify | GattIndicate;
  entry.descriptors.push_back({"descriptor", "", 8, false});
  state.services.push_back({"service", {entry}});
  auto& reported = state.services.front().characteristics.front().readError;
  readCharacteristic(&characteristic, peer, "uuid");
  assert(reads == 1 && success && reported.empty());
  assert(tracedPeer.matches(peer.address, 0, 7));
  for (const auto code : { 0x105, 0x108, 0x10c, 0x10f, 534 }) {
    result = code; readCharacteristic(&characteristic, peer, "uuid");
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
  result = 0;
  for (const uint8_t type : {0, 1}) {
    const TracePeer workerPeer(peer.address, type, 7);
    state.addressType = type;
    for (const auto action : {Action::Read, Action::Write, Action::Subscribe}) {
      for (const auto& expected : {TracePeer("11:22:33:44:55:66", type, 7), TracePeer(peer.address, uint8_t(type ^ 1), 7),
                                  TracePeer(peer.address, type, 8), TracePeer(peer.address, type, 0)}) {
        Command command{action, 7}; command.expectedPeer = expected; command.mode = 1;
        resetCalls(); executeGatt(&client, command, workerPeer);
        assert(reads == 0 && writes == 0 && subscribes == 0 && unsubscribes == 0);
        assert(lookups == 0 && descriptorLookups == 0 && !success && tracedBytes == 0);
        assert(state.error == "Bluetooth connection changed. Inspect again before retrying.");
        assert(tracedPeer.matches(expected.address, expected.provenance.addressType, expected.provenance.connectionAttempt));
        if (action == Action::Read) {
          command.argument = 8; resetCalls(); executeGatt(&client, command, workerPeer);
          assert(reads == 0 && lookups == 0 && !success);
        } else if (action == Action::Subscribe) {
          command.mode = 0; resetCalls(); executeGatt(&client, command, workerPeer);
          assert(subscribes == 0 && unsubscribes == 0 && lookups == 0 && !success);
        }
      }
      for (const bool scoped : {false, true}) {
        Command command{action, 7}; command.mode = 1;
        if (scoped) command.expectedPeer = TracePeer("aa:bb:cc:dd:ee:ff", type, 7);
        resetCalls(); executeGatt(&client, command, workerPeer);
        assert(reads == (action == Action::Read) && writes == (action == Action::Write));
        assert(subscribes == (action == Action::Subscribe) && unsubscribes == 0 && lookups == 1 && success);
        assert(tracedPeer.matches(workerPeer.address, type, 7));
        if (action == Action::Read) {
          command.argument = 8; resetCalls(); executeGatt(&client, command, workerPeer);
          assert(reads == 1 && lookups == 0 && success);
        } else if (action == Action::Subscribe) {
          command.mode = 0; resetCalls(); executeGatt(&client, command, workerPeer);
          assert(subscribes == 0 && unsubscribes == 1 && success);
        }
      }
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
