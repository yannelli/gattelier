#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
.tools/arduino-cli upload --config-file arduino-cli.yaml \
  --fqbn 'esp32:esp32:esp32c6:CDCOnBoot=cdc,FlashSize=4M,PartitionScheme=huge_app' \
  --port "${1:-/dev/cu.usbmodem1101}" --input-dir "$PWD/build" firmware/nanoscope
