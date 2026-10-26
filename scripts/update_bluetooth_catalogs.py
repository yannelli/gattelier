import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REVISION = "e7f76d7c5e2edced4872a352ff4a300610ac8212"
BASE = "https://bitbucket.org/bluetooth-SIG/public"
UUID_TABLES = {
    "uuids/service_uuids.yaml": ("service", 76),
    "uuids/characteristic_uuids.yaml": ("characteristic", 512),
    "uuids/descriptors.yaml": ("descriptor", 24),
    "uuids/units.yaml": ("unit", 127),
    "uuids/declarations.yaml": ("declaration", 4),
    "uuids/member_uuids.yaml": ("member-service", 724),
    "uuids/sdo_uuids.yaml": ("sdo-service", 17),
}
APPEARANCE = "core/appearance_values.yaml"
AD_TYPES = "core/ad_types.yaml"
REQUIRED = (*UUID_TABLES, APPEARANCE, AD_TYPES)


def source_url(revision, path, raw=False):
    return f"{BASE}/{'raw' if raw else 'src'}/{revision}/assigned_numbers/{path}"


def scalar(value):
    value = value.strip()
    if value.startswith('"'):
        value = json.loads(value)
    elif value.startswith("'"):
        if not value.endswith("'") or len(value) < 2:
            raise ValueError("Unterminated quoted YAML text")
        value = value[1:-1].replace("''", "'")
    elif not value or value[0] in "|>&*!{[" or " #" in value:
        raise ValueError("Unsupported YAML scalar")
    if not isinstance(value, str) or not value.strip() or re.search(r"[\x00-\x1f\x7f]", value):
        raise ValueError("Invalid assigned-number text")
    return value


def tokens(source, root):
    result = []
    for number, line in enumerate(source.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"( *)(- )?([a-z_]+): *(.*)", line)
        if not match:
            raise ValueError(f"Unsupported YAML line {number}")
        indent, dash, key, value = match.groups()
        result.append((len(indent), bool(dash), key, value))
    if not result or result[0] != (0, False, root, ""):
        raise ValueError(f"Missing {root} YAML root")
    return result[1:]


def records(source, root, identifier, extra=()):
    result, current, level = [], None, None
    for indent, dash, key, value in tokens(source, root):
        if dash:
            if key != identifier or current is not None and "name" not in current:
                raise ValueError("Missing or unexpected assigned-number identifier")
            if level is not None and indent != level:
                raise ValueError("Inconsistent YAML list indentation")
            current, level = {key: scalar(value)}, indent
            result.append(current)
        else:
            if current is None or indent <= level or key not in ("name", *extra) or key in current:
                raise ValueError("Unexpected or repeated assigned-number field")
            current[key] = scalar(value)
    if not result or "name" not in result[-1]:
        raise ValueError("Assigned-number record has no name")
    return result


def canonical_uuid(value):
    match = re.fullmatch(r"(?:0x)?([0-9a-f]{4})", value, re.IGNORECASE)
    if match:
        return match[1].lower()
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value, re.IGNORECASE):
        raise ValueError(f"Unsupported UUID {value}")
    value = value.lower()
    return value[4:8] if re.fullmatch(r"0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb", value) else value


def integer(value, maximum):
    if not re.fullmatch(r"(?:0x[0-9a-fA-F]+|[0-9]+)", value):
        raise ValueError(f"Invalid assigned number {value}")
    number = int(value, 16 if value.startswith("0x") else 10)
    if number > maximum:
        raise ValueError(f"Assigned number exceeds {maximum}")
    return number


def uuid_entries(source, kind, url):
    result, seen = [], set()
    for record in records(source, "uuids", "uuid", ("id",)):
        identifier = canonical_uuid(record["uuid"])
        if identifier in seen:
            raise ValueError(f"Repeated UUID {identifier} in {url}")
        seen.add(identifier)
        result.append({"uuid": identifier, "name": record["name"], "kind": kind, "source": url})
    return result


def appearance_entries(source, url):
    categories, category, pending = [], None, None
    for indent, dash, key, value in tokens(source, "appearance_values"):
        if dash and key == "category" and indent == 1:
            if pending is not None:
                raise ValueError("Appearance number has no name")
            category = {"code": integer(value, 1023), "subcategories": []}
            categories.append(category)
            pending = category
        elif dash and key == "value" and indent == 4 and category is not None and "name" in category:
            if pending is not None:
                raise ValueError("Appearance subcategory has no name")
            pending = {"code": integer(value, 63)}
            category["subcategories"].append(pending)
        elif not dash and key == "name" and pending is not None and indent == (3 if pending is category else 6):
            pending["name"] = scalar(value)
            pending = None
        elif not dash and key == "subcategory" and value == "" and indent == 3 and category is not None and "name" in category:
            continue
        else:
            raise ValueError("Unsupported appearance YAML structure")
    if not categories or pending is not None:
        raise ValueError("Incomplete appearance catalog")
    result, seen = [], set()
    for category in categories:
        for sub in [{"code": 0, "name": category["name"]}, *category["subcategories"]]:
            code = category["code"] * 64 + sub["code"]
            if code in seen:
                raise ValueError(f"Repeated appearance code {code}")
            seen.add(code)
            result.append({"code": code, "name": sub["name"], "category": category["name"],
                           "categoryCode": category["code"], "subcategory": sub["code"], "source": url})
    return sorted(result, key=lambda entry: entry["code"])


def ad_entries(source, url):
    result, seen = [], set()
    for record in records(source, "ad_types", "value", ("reference",)):
        code = integer(record["value"], 255)
        key = code, record["name"]
        if key in seen:
            raise ValueError(f"Repeated AD assignment {key}")
        seen.add(key)
        result.append({"code": code, "name": record["name"], "source": url})
    return sorted(result, key=lambda entry: (entry["code"], entry["name"]))


def build_catalogs(sources, revision=REVISION):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Use the complete lowercase source commit hash")
    if set(sources) != set(REQUIRED):
        raise ValueError("All nine Assigned Numbers source files are required")
    entries, seen = [], {}
    for path, (kind, minimum) in UUID_TABLES.items():
        parsed = uuid_entries(sources[path], kind, source_url(revision, path))
        if len(parsed) < minimum:
            raise ValueError(f"Incomplete {path}: {len(parsed)} entries, expected at least {minimum}")
        for entry in parsed:
            if entry["uuid"] in seen:
                raise ValueError(f"UUID conflict for {entry['uuid']}: {seen[entry['uuid']]} versus {entry}")
            seen[entry["uuid"]] = entry
        entries.extend(parsed)
    appearances = appearance_entries(sources[APPEARANCE], source_url(revision, APPEARANCE))
    ads = ad_entries(sources[AD_TYPES], source_url(revision, AD_TYPES))
    if len(appearances) < 342 or len(ads) < 51:
        raise ValueError("Incomplete appearance or advertising-data catalog")
    def catalog(identifier, title, kind, paths, values):
        return {"schema": 1, "id": identifier, "title": title, "kind": kind, "revision": f"sig.{revision}",
                "sources": [{"title": f"Bluetooth SIG {path}", "url": source_url(revision, path)} for path in paths], "entries": values}
    return [catalog("bluetooth-uuids", "Bluetooth SIG UUID assignments", "uuid", UUID_TABLES,
                    sorted(entries, key=lambda entry: (entry["uuid"], entry["kind"]))),
            catalog("bluetooth-appearance", "Bluetooth SIG appearance values", "appearance", [APPEARANCE], appearances),
            catalog("bluetooth-ad-types", "Bluetooth SIG advertising data types", "ad-type", [AD_TYPES], ads)]


def load_sources(source_dir, revision):
    def load(path):
        if source_dir is not None:
            data = (source_dir / path).read_bytes()
        else:
            with urllib.request.urlopen(source_url(revision, path, raw=True), timeout=30) as response:
                data = response.read(2_000_001)
        if not data or len(data) > 2_000_000:
            raise ValueError(f"Invalid source length: {path}")
        return path, data.decode("utf-8-sig")
    with ThreadPoolExecutor(max_workers=5) as executor:
        return dict(executor.map(load, REQUIRED))


def update(source_dir=None, output_dir=ROOT / "catalogs", revision=REVISION):
    catalogs = build_catalogs(load_sources(source_dir, revision), revision)
    output_dir.mkdir(parents=True, exist_ok=True)
    pending = []
    try:
        for catalog in catalogs:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output_dir, delete=False) as target:
                pending.append((Path(target.name), output_dir / f"{catalog['id']}.json"))
                json.dump(catalog, target, ensure_ascii=False, separators=(",", ":"))
                target.write("\n")
        for staged, destination in pending:
            os.replace(staged, destination)
    finally:
        for staged, _ in pending:
            staged.unlink(missing_ok=True)
    return {catalog["id"]: len(catalog["entries"]) for catalog in catalogs}


def main():
    parser = argparse.ArgumentParser(description="Generate hosted Bluetooth catalogs from pinned SIG Assigned Numbers YAML.")
    parser.add_argument("--source-dir", type=Path, help="Local assigned_numbers directory containing uuids/ and core/ fixtures")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "catalogs")
    parser.add_argument("--revision", default=REVISION, help="Complete lowercase SIG repository commit hash")
    args = parser.parse_args()
    try:
        print(json.dumps({"revision": args.revision, "counts": update(args.source_dir, args.output_dir, args.revision)}))
    except (ValueError, OSError) as error:
        parser.exit(1, f"Catalog update failed: {error}\n")


if __name__ == "__main__":
    main()
