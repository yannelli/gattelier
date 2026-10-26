import csv
import gzip
import io
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "MA-L": "https://standards-oui.ieee.org/oui/oui.csv",
    "MA-M": "https://standards-oui.ieee.org/oui28/mam.csv",
    "MA-S": "https://standards-oui.ieee.org/oui36/oui36.csv",
    "Bluetooth SIG": "https://bitbucket.org/bluetooth-SIG/public/raw/main/assigned_numbers/company_identifiers/company_identifiers.yaml",
}


def download(url):
    return subprocess.check_output(["curl", "-fsSL", "--max-time", "60", url]).decode("utf-8-sig")


def company_names(source):
    entries = {}
    identifier = None
    for line in source.splitlines():
        match = re.fullmatch(r"\s*- value: (0x[0-9a-fA-F]+)\s*", line)
        if match:
            identifier = str(int(match[1], 16))
        elif line.strip().startswith("name:"):
            raw = line.strip()[5:].strip()
            if raw.startswith("'") and raw.endswith("'"):
                name = raw[1:-1].replace("''", "'")
            elif raw.startswith('"') and raw.endswith('"'):
                name = json.loads(raw)
            else:
                raise ValueError("Unsupported company-name YAML format")
            if identifier is None:
                raise ValueError("Company name without identifier")
            entries[identifier] = name
            identifier = None
    if len(entries) < 3000:
        raise ValueError("Incomplete Bluetooth SIG database")
    return entries


def main():
    oui = {}
    for registry in ("MA-L", "MA-M", "MA-S"):
        rows = csv.DictReader(io.StringIO(download(SOURCES[registry])))
        for row in rows:
            prefix = row["Assignment"].upper()
            if not re.fullmatch(r"[0-9A-F]{6}|[0-9A-F]{7}|[0-9A-F]{9}", prefix):
                raise ValueError(f"Invalid IEEE assignment: {prefix}")
            oui[prefix] = row["Organization Name"]
    if len(oui) < 40000:
        raise ValueError("Incomplete IEEE database")
    companies = company_names(download(SOURCES["Bluetooth SIG"]))
    data = {"updated": datetime.now(timezone.utc).date().isoformat(), "sources": SOURCES, "oui": oui, "company": companies}
    payload = json.dumps(data, ensure_ascii=True, separators=(",", ":")).encode()
    (ROOT / "web/vendors.json").write_bytes(payload + b"\n")
    print(f"{len(oui)} IEEE prefixes; {len(companies)} BLE company IDs; {len(gzip.compress(payload))} bytes compressed")


if __name__ == "__main__":
    main()
