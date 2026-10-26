import json
import re
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NORDIC = "d379cc06c9c3681bc1c1cd4d61c246a0b0f80b0e"
POLAR = "93084a06ca1e008704719590a665cd3544753063"
NORDIC_REPO = "NordicSemiconductor/bluetooth-numbers-database"
POLAR_REPO = "polarofficial/polar-ble-sdk"
POLAR_PATH = "sources/Android/android-communications/library/src/main/java/com/polar/androidcommunications/api/ble/model/gatt/client/pmd/BlePMDClient.kt"
CUSTOM_UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")
REJECTED = {
    "8e400001-f315-4f60-9fb8-838830daea50": {
        ("Experimental Buttonless DFU Service", "service"),
        ("Experimental Buttonless DFU", "characteristic"),
    }
}


def fetch(repo, revision, path):
    url = f"https://raw.githubusercontent.com/{repo}/{revision}/{path}"
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def source_url(repo, revision, path):
    return f"https://github.com/{repo}/blob/{revision}/{path}"


def line_source(text, uuid, url):
    match = re.search(re.escape(uuid), text, re.IGNORECASE)
    if not match:
        raise ValueError(f"UUID absent from declared source: {uuid}")
    return f"{url}#L{text[:match.start()].count(chr(10)) + 1}"


def generate():
    groups, sources = defaultdict(list), []
    for kind in ("service", "characteristic", "descriptor"):
        path = f"v1/{kind}_uuids.json"
        text = fetch(NORDIC_REPO, NORDIC, path).decode("utf-8")
        url = source_url(NORDIC_REPO, NORDIC, path)
        sources.append({"title": f"Nordic Bluetooth database: {kind} UUIDs", "url": url})
        for row in json.loads(text):
            uuid = row["uuid"].lower()
            if not CUSTOM_UUID.fullmatch(uuid) or uuid.endswith("-0000-1000-8000-00805f9b34fb"):
                continue
            groups[uuid].append({"uuid": uuid, "name": row["name"], "kind": kind, "source": line_source(text, uuid, url)})
    for uuid, expected in REJECTED.items():
        actual = {(entry["name"], entry["kind"]) for entry in groups.pop(uuid, [])}
        if actual != expected:
            raise ValueError(f"Rejected upstream conflict changed: {uuid}")
    polar_text = fetch(POLAR_REPO, POLAR, POLAR_PATH).decode("utf-8")
    polar_url = source_url(POLAR_REPO, POLAR, POLAR_PATH)
    sources.append({"title": "Polar official SDK: PMD service and characteristics", "url": polar_url})
    for symbol, name, kind in [
        ("PMD_SERVICE", "Polar Measurement Data Service", "service"),
        ("PMD_CP", "Polar PMD Control Point", "characteristic"),
        ("PMD_DATA", "Polar PMD Data", "characteristic"),
    ]:
        match = re.search(rf'val {symbol}: UUID = UUID.fromString\("([0-9A-F-]+)"\)', polar_text)
        if not match:
            raise ValueError(f"Polar UUID definition missing: {symbol}")
        uuid = match[1].lower()
        groups[uuid].append({"uuid": uuid, "name": name, "kind": kind, "source": line_source(polar_text, uuid, polar_url)})
    entries = []
    for uuid, candidates in sorted(groups.items()):
        if len({(entry["name"], entry["kind"]) for entry in candidates}) != 1:
            raise ValueError(f"Conflicting duplicate UUID: {uuid}")
        entries.append(candidates[0])
    notices = {}
    for repo, revision, path, target, title in [
        (NORDIC_REPO, NORDIC, "LICENSE", "vendor-uuids-LICENSE.txt", "Nordic Semiconductor ASA, copyright 2019-2020: full license"),
        (POLAR_REPO, POLAR, "Polar_SDK_License.txt", "vendor-uuids-Polar-LICENSE.txt", "Polar SDK source license"),
    ]:
        notices[target] = fetch(repo, revision, path)
        sources.append({"title": title, "url": source_url(repo, revision, path)})
    header = {"schema": 1, "id": "vendor-uuids", "title": "Vendor UUID names", "kind": "uuid", "revision": NORDIC + "+" + POLAR[:8], "sources": sources}
    output = json.dumps(header, ensure_ascii=True, indent=2)[:-2] + ',\n  "entries": [\n'
    output += ",\n".join("    " + json.dumps(entry, ensure_ascii=True, separators=(",", ":")) for entry in entries)
    output += "\n  ]\n}\n"
    if len(output.splitlines()) > 300:
        raise ValueError("Generated catalog exceeds 300 lines")
    target = ROOT / "catalogs"
    target.mkdir(exist_ok=True)
    (target / "vendor-uuids.json").write_text(output, encoding="utf-8")
    for name, content in notices.items():
        (target / name).write_bytes(content)
    print(json.dumps({"entries": len(entries), "kinds": dict(Counter(entry["kind"] for entry in entries)), "rejectedUUIDs": list(REJECTED)}))


if __name__ == "__main__":
    generate()
