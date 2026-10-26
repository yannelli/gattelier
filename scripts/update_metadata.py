import argparse
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://bitbucket.org/bluetooth-SIG/public/raw/main/assigned_numbers/uuids/"
TABLES = {"service_uuids": 60, "characteristic_uuids": 400, "descriptors": 15, "units": 100, "declarations": 4}


def assigned_names(source):
    entries = {}
    identifier = None
    for line in source.splitlines():
        match = re.fullmatch(r"\s*- uuid: (0x[0-9A-Fa-f]{4})\s*", line)
        if match:
            if identifier is not None:
                raise ValueError("UUID without a name")
            identifier = f"{int(match[1], 16):04x}"
        elif line.strip().startswith("name:"):
            name = line.strip()[5:].strip()
            if name.startswith('"'):
                name = json.loads(name)
            elif name.startswith("'") and name.endswith("'"):
                name = name[1:-1].replace("''", "'")
            elif not name or name in ("|", ">") or " #" in name:
                raise ValueError("Unsupported UUID-name YAML format")
            if identifier is None or identifier in entries:
                raise ValueError("Missing or repeated UUID")
            entries[identifier] = name
            identifier = None
    if identifier is not None:
        raise ValueError("UUID without a name")
    return entries


def main():
    parser = argparse.ArgumentParser(description="Update factual UUID/name mappings from Bluetooth SIG assigned numbers.")
    parser.add_argument("--source-dir", type=Path, help="Read previously downloaded SIG YAML tables")
    args = parser.parse_args()
    target = ROOT / "web/metadata-v1.json"
    catalog = json.loads(target.read_text())
    entries = {entry["uuid"]: entry for entry in catalog["entries"]}
    counts = {}
    for table, minimum in TABLES.items():
        url = f"{BASE}{table}.yaml"
        if args.source_dir:
            source = (args.source_dir / f"{table}.yaml").read_text()
        else:
            with urllib.request.urlopen(url, timeout=30) as response:
                source = response.read().decode("utf-8-sig")
        names = assigned_names(source)
        if len(names) < minimum:
            raise ValueError(f"Incomplete {table} catalog")
        counts[table] = len(names)
        for uuid, name in names.items():
            entry = entries.setdefault(uuid, {"uuid": uuid})
            entry.update(name=name, source=url)
    catalog["revision"] = datetime.now(timezone.utc).strftime("%Y-%m-%d.sig")
    catalog["entries"] = [entries[key] for key in sorted(entries)]
    target.write_text('{\n  "schema": 1,\n  "revision": ' + json.dumps(catalog["revision"]) + ',\n  "entries": [\n'
                      + ',\n'.join('    ' + json.dumps(entry, ensure_ascii=True) for entry in catalog["entries"]) + '\n  ]\n}\n')
    print(json.dumps({"tables": counts, "entries": len(entries)}))


if __name__ == "__main__":
    main()
