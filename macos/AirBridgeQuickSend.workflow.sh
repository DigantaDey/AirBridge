#!/usr/bin/env bash
# macOS Finder Quick Action / Raycast / Alfred Script for AirBridge
# Usage: Select any file(s) in macOS Finder -> Right Click -> Quick Actions -> Beam to Android

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <file1> [file2 ...]"
  exit 1
fi

osascript -e 'display notification "Scan the terminal QR or check your paired Android device." with title "AirBridge Quick Send"' 2>/dev/null || true

exec node "${SCRIPT_DIR}/bin/airbridge.mjs" send "$@"
