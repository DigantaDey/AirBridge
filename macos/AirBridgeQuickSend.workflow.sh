#!/usr/bin/env bash
# macOS Finder Quick Action / Raycast / Alfred Script for AirBridge
# Usage: Select any file(s) in macOS Finder -> Right Click -> Quick Actions -> Beam to Android

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <file1> [file2 ...]" >&2
  exit 1
fi

for f in "$@"; do
  if [ ! -e "$f" ]; then
    echo "AirBridge Quick Send: file not found: $f" >&2
    exit 1
  fi
done

if [ -x "${HOME}/Applications/AirBridge.app/Contents/Resources/airbridge-server" ]; then
  AIRBRIDGE_CMD=("${HOME}/Applications/AirBridge.app/Contents/Resources/airbridge-server")
elif [ -x "${HOME}/.local/bin/AirBridge" ]; then
  AIRBRIDGE_CMD=("${HOME}/.local/bin/AirBridge")
elif command -v node >/dev/null 2>&1 && [ -f "${SCRIPT_DIR}/bin/airbridge.mjs" ]; then
  AIRBRIDGE_CMD=(node "${SCRIPT_DIR}/bin/airbridge.mjs")
else
  osascript -e 'display notification "Install AirBridge or Node.js 20+ first." with title "AirBridge Quick Send"' >/dev/null 2>&1 || exit 1
  echo "AirBridge Quick Send: neither AirBridge binary nor node + bin/airbridge.mjs found." >&2
  exit 1
fi

if [ -t 1 ]; then
  exec "${AIRBRIDGE_CMD[@]}" send "$@"
else
  osascript -e 'display notification "Starting local share link — open AirBridge on your paired Android device." with title "AirBridge Quick Send"' >/dev/null 2>&1 || true
  exec "${AIRBRIDGE_CMD[@]}" send "$@"
fi
