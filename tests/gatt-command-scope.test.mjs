import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('GATT submit validates optional peer scope and queues only the current connection', () => {
  const read = name => readFileSync(new URL(`../firmware/nanoscope/${name}`, import.meta.url), 'utf8');
  const extract = (source, first, last) => {
    const start = source.indexOf(first), end = last ? source.indexOf(last, start) : source.length;
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const state = read('state.h'), http = read('http.cpp');
  const include = name => JSON.stringify(fileURLToPath(new URL(`../firmware/nanoscope/${name}`, import.meta.url)));
  const directory = mkdtempSync(join(tmpdir(), 'gatt-command-scope-'));
  try {
    writeFileSync(join(directory, 'test.cpp'), `
#include <cassert>
#include <cstdint>
#include <climits>
#include <string>
#include <vector>
#include <map>
#include <algorithm>
#include <cctype>
#include <cmath>
#include ${include('trace_peer.h')}
#include ${include('gatt_properties.h')}
#include ${include('connection_cancellation.h')}
class String : public std::string {
 public:
  using std::string::string;
  String() = default;
  String(std::string value) : std::string(value) {}
  String(uint32_t value) : std::string(std::to_string(value)) {}
  String(uint8_t value) : std::string(std::to_string(value)) {}
  bool isEmpty() const { return empty(); }
  void toLowerCase() { std::transform(begin(), end(), begin(), [](unsigned char c) { return std::tolower(c); }); }
};
${extract(state, 'struct ServiceDataInfo', 'extern AppState state;')}
${extract(state, 'enum class Action', '\nvoid startBle();')}
AppState state;
int lockDepth = 0, sends = 0;
struct StateLock {
  StateLock() { assert(lockDepth++ == 0); }
  ~StateLock() { assert(--lockDepth == 0); }
};
Command queued{Action::Read};
constexpr int commands = 1, pdTRUE = 1;
int xQueueSend(int, const Command* command, int) {
  assert(lockDepth == 1 && state.busy); ++sends; queued = *command; return pdTRUE;
}
bool usbHciMode() { return false; }
bool collectionEnabled() { return false; }
bool pairingActive() { return false; }
ConnectionCancellation connectionCancellation;
std::atomic<bool> connectionTimedOut{false}, deferredCancellation{false};
std::atomic<uint32_t> startedAttempt{0};
${extract(read('gatt_actions.cpp'), 'static CharacteristicInfo* findEntry(', 'static String printableBytes(')}
${extract(read('ble.cpp'), 'bool queueCommand(', '\nvoid startBle()')}
struct cJSON {
  int type = 0;
  double valuedouble = 0;
  int valueint = 0;
  const char* valuestring = nullptr;
  std::map<std::string, cJSON> fields;
};
cJSON text(const char* value) { cJSON node; node.type = 1; node.valuestring = value; return node; }
cJSON number(double value) {
  cJSON node; node.type = 2; node.valuedouble = value;
  node.valueint = std::isfinite(value) ? int(std::clamp(value, double(INT_MIN), double(INT_MAX))) : 0;
  return node;
}
cJSON boolean(bool value) { cJSON node; node.type = value ? 3 : 4; return node; }
bool cJSON_IsString(const cJSON* node) { return node && node->type == 1; }
bool cJSON_IsNumber(const cJSON* node) { return node && node->type == 2; }
bool cJSON_IsBool(const cJSON* node) { return node && (node->type == 3 || node->type == 4); }
bool cJSON_IsTrue(const cJSON* node) { return node && node->type == 3; }
cJSON* cJSON_GetObjectItemCaseSensitive(cJSON* node, const char* key) {
  const auto item = node->fields.find(key); return item == node->fields.end() ? nullptr : &item->second;
}
void cJSON_Delete(cJSON* node) { delete node; }
${extract(read('http_access.h'), 'inline bool jsonInteger(')}
cJSON request;
struct BoardServer {
  int status = 0;
  String body;
  void send(int code, const char*, const String& content) { status = code; body = content; }
} server;
cJSON* readJsonObject(BoardServer&, size_t limit) { assert(limit == 1400); return new cJSON(request); }
void sendError(int code, const String& message) { server.send(code, "application/json", message); }
${extract(http, 'static bool validAddress(', '\nstatic void sendAsset(')}
${extract(http, 'static void submit(', '\nstatic void cancelConnectRequest(')}
void prepare(Action action) {
  state = AppState{}; state.connected = true; state.address = "AA:BB:CC:DD:EE:FF";
  state.addressType = 0; state.connectionAttempt = 7; state.error = "unchanged";
  CharacteristicInfo entry;
  entry.handle = 7; entry.properties = GattRead | GattWrite | GattWriteNoResponse | GattNotify | GattIndicate;
  entry.descriptors.push_back({"descriptor", "", 8, false});
  state.services.push_back({"service", {entry}});
  request = cJSON{}; request.fields["handle"] = number(7);
  if (action == Action::Write) { request.fields["hex"] = text("ab"); request.fields["response"] = boolean(true); }
  if (action == Action::Subscribe) request.fields["mode"] = text("notify");
  sends = 0; server.status = 0; server.body = "";
}
void scope(const char* address = "AA:BB:CC:DD:EE:FF", uint8_t type = 0, uint32_t attempt = 7) {
  request.fields["address"] = text(address); request.fields["addressType"] = number(type);
  request.fields["connectionAttempt"] = number(attempt);
}
void reject(Action action, int status) {
  submit(action, "handle");
  assert(server.status == status && sends == 0 && !state.busy && lockDepth == 0);
  assert(state.error == "unchanged" && state.operation == "idle");
}
int main() {
  for (const auto action : {Action::Read, Action::Write, Action::Subscribe}) {
    for (int mask = 1; mask < 7; ++mask) {
      prepare(action);
      if (mask & 1) request.fields["address"] = text("AA:BB:CC:DD:EE:FF");
      if (mask & 2) request.fields["addressType"] = number(0);
      if (mask & 4) request.fields["connectionAttempt"] = number(7);
      reject(action, 400);
    }
    for (const auto& value : {cJSON{}, number(7), boolean(true), text(""), text("AA:BB:CC:DD:EE"),
                              text("AA:BB:CC:DD:EE:FF:00"), text("AA-BB-CC-DD-EE-FF"), text("GG:BB:CC:DD:EE:FF")}) {
      prepare(action); scope(); request.fields["address"] = value; reject(action, 400);
    }
    for (const auto& value : {cJSON{}, text("0"), boolean(false), number(-1), number(4), number(0.5)}) {
      prepare(action); scope(); request.fields["addressType"] = value; reject(action, 400);
    }
    for (const auto& value : {cJSON{}, text("7"), boolean(true), number(-1), number(0), number(1.5), number(4294967296.0)}) {
      prepare(action); scope(); request.fields["connectionAttempt"] = value; reject(action, 400);
    }
    for (const uint8_t type : {0, 1, 2, 3}) {
      for (const uint32_t attempt : {uint32_t(1), uint32_t(7), UINT32_MAX}) {
        prepare(action); state.addressType = type; state.connectionAttempt = attempt;
        scope("AA:bb:CC:dd:EE:ff", type, attempt); submit(action, "handle");
        assert(server.status == 202 && sends == 1 && state.busy && lockDepth == 0);
        assert(queued.expectedPeer.matches(state.address.c_str(), type, attempt));
        assert(std::string(queued.expectedPeer.address) == "aa:bb:cc:dd:ee:ff");
        assert(queued.connectionAttempt == 0 && queued.argument == 7);
        if (action == Action::Write) assert(queued.length == 1 && queued.data[0] == 0xab && queued.mode == 1);
        if (action == Action::Subscribe) assert(queued.mode == 1);
      }
    }
    for (const uint8_t type : {0, 1}) {
      prepare(action); state.addressType = type; scope("11:22:33:44:55:66", type); reject(action, 409);
      prepare(action); state.addressType = type; scope("AA:BB:CC:DD:EE:FF", uint8_t(type ^ 1)); reject(action, 409);
      prepare(action); state.addressType = type; scope("AA:BB:CC:DD:EE:FF", type, 8); reject(action, 409);
      assert(server.body == "Bluetooth connection changed. Inspect again before retrying.");
    }
    prepare(action); submit(action, "handle");
    assert(server.status == 202 && sends == 1 && !queued.expectedPeer.provenance.hasConnectionAttempt);
    assert(!queued.expectedPeer.provenance.hasAddressType);
    prepare(action); scope(); state.connected = false; reject(action, 409);
    assert(server.body == "No device is connected.");
  }
  prepare(Action::Read); scope(); request.fields["handle"] = number(8); submit(Action::Read, "handle");
  assert(server.status == 202 && sends == 1 && queued.argument == 8);
  prepare(Action::Write); scope(); const std::string hex(1024, 'a'); request.fields["hex"] = text(hex.c_str());
  submit(Action::Write, "handle");
  assert(server.status == 202 && sends == 1 && queued.length == 512 && queued.data[511] == 0xaa);
  assert(queued.expectedPeer.matches(state.address.c_str(), 0, 7));
  prepare(Action::Connect); state.connected = false; request.fields.clear(); scope("AA:BB:CC:DD:EE:FF", 1);
  request.fields["connectionAttempt"] = cJSON{}; request.fields["scope"] = text("plaud"); request.fields["identify"] = boolean(true);
  submit(Action::Connect, "id");
  assert(server.status == 202 && sends == 1 && queued.length == 3 && queued.mode == 1);
  assert(!queued.expectedPeer.provenance.hasConnectionAttempt && queued.connectionAttempt != 0);
  assert(std::string(reinterpret_cast<const char*>(queued.data)) == "aa:bb:cc:dd:ee:ff");
}
`);
    const compile = spawnSync('c++', ['-std=c++17', join(directory, 'test.cpp'), '-o', join(directory, 'test')], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
    const run = spawnSync(join(directory, 'test'), [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
