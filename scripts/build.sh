#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -f firmware/nanoscope/secrets.h || {
  echo 'Copy firmware/nanoscope/secrets.example.h to secrets.h and set Wi-Fi credentials.' >&2
  exit 1
}
npm run build:web
python=.tools/python/bin/python3
[ -x "$python" ] || python=python3
"$python" scripts/embed_web.py
.tools/arduino-cli compile --config-file arduino-cli.yaml \
  --fqbn 'esp32:esp32:esp32c6:CDCOnBoot=cdc,FlashSize=4M,PartitionScheme=huge_app' \
  --warnings all --build-path "$PWD/build" firmware/nanoscope
