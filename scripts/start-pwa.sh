#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bridge_port="${NANOSCOPE_PWA_PORT:-8766}"
https_port="${NANOSCOPE_HTTPS_PORT:-8443}"
board_url="${NANOSCOPE_BOARD_URL:-http://nanoscope.local}"
allowed_origin="${NANOSCOPE_ALLOWED_ORIGIN:-}"
dns_name=$(tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d.get("Self", {}); name=s.get("DNSName", "").rstrip("."); assert d.get("BackendState")=="Running" and name and d.get("CertDomains"), "Tailscale HTTPS is not ready"; print(name)')
public_origin="https://${dns_name}:${https_port}"
serve=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --serve) serve=true; shift ;;
    --allow-origin)
      if [ "$#" -lt 2 ]; then
        echo 'Usage: scripts/start-pwa.sh [--serve] [--allow-origin https://app.example]' >&2
        exit 2
      fi
      allowed_origin="$2"; shift 2 ;;
    *)
      echo 'Usage: scripts/start-pwa.sh [--serve] [--allow-origin https://app.example]' >&2
      exit 2 ;;
  esac
done
if [ "$serve" = true ]; then
  tailscale serve --bg --https="$https_port" "http://127.0.0.1:$bridge_port"
fi
echo "Gattelier app: $public_origin"
if [ -n "$allowed_origin" ]; then
  exec python3 scripts/https_bridge.py --board "$board_url" --port "$bridge_port" --public-origin "$public_origin" --allow-origin "$allowed_origin"
fi
exec python3 scripts/https_bridge.py --board "$board_url" --port "$bridge_port" --public-origin "$public_origin"
