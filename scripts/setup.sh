#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .tools
if [ ! -x .tools/arduino-cli ]; then
  curl -fsSL https://github.com/arduino/arduino-cli/releases/download/v1.5.1/arduino-cli_1.5.1_macOS_ARM64.tar.gz -o .tools/arduino-cli.tar.gz
  tar -xzf .tools/arduino-cli.tar.gz -C .tools arduino-cli
fi
.tools/arduino-cli core update-index --config-file arduino-cli.yaml
.tools/arduino-cli core install esp32:esp32@3.3.2 --config-file arduino-cli.yaml
.tools/arduino-cli lib install 'NimBLE-Arduino@2.5.1' --config-file arduino-cli.yaml
