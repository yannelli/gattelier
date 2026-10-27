import gzip
import hashlib
from pathlib import Path

try:  # zopfli writes standard gzip about 5% smaller; scripts/setup.sh installs it into .tools/python.
    from zopfli.gzip import compress as zopfli_gzip
except ImportError:
    zopfli_gzip = None

ROOT = Path(__file__).resolve().parents[1]
assets = [("index_html", "index.html"), ("app_bundle_js", "app.bundle.js"),
          ("app_bundle_css", "app.bundle.css"), ("vendors_json", "vendors.json"), ("metadata_json", "metadata-v1.json"),
          ("manifest_json", "manifest.webmanifest"), ("service_worker_js", "sw.js"),
          *[(f"icon_{size}_png", f"icons/nanoscope-{size}.png") for size in (180, 192, 512)]]
types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png"}
build_id = hashlib.sha256(b"".join((ROOT / "web" / filename).read_bytes() for _, filename in assets)).hexdigest()[:16]
lines = ["#pragma once", "#include <Arduino.h>"]
for symbol, filename in assets:
    content = (ROOT / "web" / filename).read_bytes()
    if filename == "sw.js":
        content = content.replace(b"__NANO_BUILD__", build_id.encode())
    payload = zopfli_gzip(content) if zopfli_gzip else gzip.compress(content, mtime=0)
    lines.append(f"static const uint8_t {symbol.replace('-', '_')}[] PROGMEM = {{")
    chunk_size = 4096 if filename.endswith(".json") else 2048
    for offset in range(0, len(payload), chunk_size):
        lines.append(",".join(f"0x{byte:02x}" for byte in payload[offset:offset + chunk_size]) + ",")
    lines.append("};")
    print(f"{filename}: {len(payload)} bytes compressed{'' if zopfli_gzip else ' (gzip; run scripts/setup.sh for zopfli)'}")
lines.append("struct WebAsset { const char* path; const char* type; const uint8_t* data; size_t size; };")
lines.append("static const WebAsset webAssets[] = {")
for symbol, filename in assets:
    path = "/" if filename == "index.html" else f"/{filename}"
    lines.append(f'  {{"{path}", "{types[Path(filename).suffix]}", {symbol}, sizeof({symbol})}},')
lines.append("};")
(ROOT / "firmware/nanoscope/web_assets.h").write_text("\n".join(lines) + "\n")
