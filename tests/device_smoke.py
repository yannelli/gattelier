import argparse
import gzip
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("url")
parser.add_argument("--connect-name")
args = parser.parse_args()
base = args.url.rstrip("/")
root = Path(__file__).resolve().parents[1]


def request(path, body=None, expected=200, headers=None):
    data = None if body is None else json.dumps(body).encode()
    request_headers = {"Content-Type": "application/json"} if body is not None else {}
    request_headers.update(headers or {})
    req = urllib.request.Request(base + path, data=data, headers=request_headers)
    try:
        response = urllib.request.urlopen(req, timeout=12)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        payload = response.read()
        assert response.status == expected, (path, response.status, payload)
        if response.headers.get("Content-Encoding") == "gzip":
            payload = gzip.decompress(payload)
        return json.loads(payload) if path.startswith("/api/") else payload


def idle(timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = request("/api/state")
        if not state["ble"]["busy"]:
            return state
        time.sleep(0.5)
    raise AssertionError("BLE operation did not finish")


for filename in ("index.html", "app.bundle.css", "app.bundle.js", "vendors.json"):
    asset = root / "web" / filename
    path = "/" if asset.name == "index.html" else "/" + asset.name
    assert request(path) == asset.read_bytes(), asset.name
print("PASS: embedded assets match source")
state = idle()
assert state["wifi"]["connected"]
assert not state["ble"]["connected"], "Disconnect the current device before running this test"
request("/api/connect", {"id": "bad"}, 400)
request("/api/connect", {"id": 4294967295}, 409)
request("/api/read", {"handle": 1}, 409)
request("/api/write", {"handle": 1, "hex": "00", "response": True}, 409)
request("/api/write", {"handle": 1, "hex": "0z", "response": True}, 400)
request("/api/subscribe", {"handle": 1, "mode": "notify"}, 409)
request("/api/subscribe", {"handle": 1, "mode": "invalid"}, 400)
request("/api/events?after=invalid", expected=400)
capture = request("/api/events?after=0")
assert capture["bootId"] and isinstance(capture["events"], list)
request("/api/scan", {}, 403, {"Origin": "http://example.invalid"})
request("/api/scan", {}, 415, {"Content-Type": "text/plain"})
request("/api/stop-scan", {}, 202)
state = idle()
assert not state["ble"]["scanning"] and not state["ble"]["scanEnabled"]
old_ids = {device["id"] for device in state["devices"] if state["uptime"] - device["lastSeen"] < 60}
request("/api/scan", {}, 202)
state = idle()
assert state["ble"]["scanning"] and state["ble"]["scanEnabled"]
assert old_ids.issubset({device["id"] for device in state["devices"]})
seen = {device["id"]: device["lastSeen"] for device in state["devices"]}
time.sleep(8)
start = time.monotonic()
state = request("/api/state")
assert state["ble"]["scanning"] and not state["ble"]["busy"]
assert time.monotonic() - start < 3, "HTTP blocked during scanning"
assert any(device["lastSeen"] > seen.get(device["id"], device["lastSeen"]) for device in state["devices"]), "Advertisements did not update during continuous scanning"
assert len({device["id"] for device in state["devices"]}) == len(state["devices"])
print(f'PASS: continuous scan, stop/start, live updates and API guards; {len(state["devices"])} devices, {state["freeHeap"]} bytes free')
target = max(state["devices"], key=lambda device: device["rssi"])
request("/api/capture", {"address": target["address"]})
captured = False
try:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not captured:
        time.sleep(1)
        capture = request("/api/events?after=0")
        captured = any(event["kind"] == "advertisement" and event["address"] == target["address"] and event["hex"] for event in capture["events"])
finally:
    request("/api/capture", {"address": ""})
assert captured, "Selected device did not advertise during the capture window"
print("PASS: selected-device raw advertisement capture")
for device in state["devices"]:
    print(json.dumps({key: device[key] for key in ("id", "name", "address", "connectable", "rssi")}))
if args.connect_name:
    matches = [device for device in state["devices"] if device["name"] == args.connect_name and device["connectable"]]
    assert len(matches) == 1, "Expected exactly one connectable device with the supplied name"
    request("/api/connect", {"id": matches[0]["id"]}, 202)
    state = idle(60)
    assert state["ble"]["connected"], state["ble"]["error"]
    assert not state["ble"]["scanning"]
    assert state["services"], state["ble"]["error"]
    request("/api/scan", {}, 409)
    readable = [char for service in state["services"] for char in service["characteristics"] if "read" in char["properties"]]
    assert readable, "No readable characteristic for the read check"
    handle = readable[0]["handle"]
    request("/api/read", {"handle": handle}, 202)
    state = idle(60)
    value = next(char for service in state["services"] for char in service["characteristics"] if char["handle"] == handle)
    assert not value["readError"], value["readError"]
    assert value["valueHex"] is not None
    print(f'PASS: connect, discover {len(state["services"])} services, read handle {handle}')
    request("/api/disconnect", {}, 202)
    state = idle()
    assert not state["ble"]["connected"]
    assert state["ble"]["scanning"], "Continuous scan did not resume after disconnect"
    assert state["services"] == []
    print("PASS: disconnect clears connection state")
