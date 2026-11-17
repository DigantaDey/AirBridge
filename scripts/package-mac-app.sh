#!/usr/bin/env bash
# Build the prebuilt, ad-hoc signed AirBridge.app (release asset
# AirBridge-macOS-<arch>.zip). Runs on macOS (CI). Users no longer need
# Xcode / swiftc: install.sh and the in-app updater download this bundle.
#
#   scripts/package-mac-app.sh <arm64|x64> <path-to-AirBridge-darwin-binary> <out-dir> [bundle-id]
#
# Layout:
#   AirBridge.app/Contents/Info.plist              (version = package.json)
#   AirBridge.app/Contents/MacOS/AirBridge         (Swift shell: window, menu bar, supervisor, notifications)
#   AirBridge.app/Contents/Resources/airbridge-server   (the single-file service)
#   AirBridge.app/Contents/Resources/AirBridge.icns
#
# Signed ad hoc (no Apple Developer account, no notarization). Files fetched
# with curl / by the updater carry no quarantine flag, so Gatekeeper does not
# block launch; browsers do set it — install.sh is the supported path.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:?arch (arm64|x64)}"
SERVER="${2:?path to AirBridge-darwin-<arch> binary}"
OUT="${3:?output directory}"
BUNDLE_ID="${4:-com.airbridge.launcher}"
VERSION="$(node -p 'require("./package.json").version')"

case "$ARCH" in
  arm64) TARGET="arm64-apple-macos12.0" ;;
  x64)   TARGET="x86_64-apple-macos12.0" ;;
  *) echo "unknown arch: $ARCH" >&2; exit 2 ;;
esac

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/AirBridge.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>AirBridge</string>
  <key>CFBundleDisplayName</key><string>AirBridge</string>
  <key>CFBundleExecutable</key><string>AirBridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AirBridge.icns</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>AirBridge — open source, end-to-end encrypted</string>
  <key>NSLocalNetworkUsageDescription</key><string>AirBridge connects directly to your phone on the local network to transfer files and clipboard content.</string>
  <key>NSBluetoothAlwaysUsageDescription</key><string>Your paired phone can hand over its hotspot over Bluetooth when it and this Mac share no network. Only the paired phone can use it.</string>
  <key>NSBonjourServices</key><array><string>_airbridge._tcp</string><string>_airbridge-rv._tcp</string></array>
</dict></plist>
PLIST

echo "▸ compiling the Swift shell for $TARGET"
swiftc -O -target "$TARGET" scripts/mac_app.swift -o "$APP/Contents/MacOS/AirBridge" \
  -framework AppKit -framework WebKit -framework UserNotifications -framework CoreBluetooth

cp "$SERVER" "$APP/Contents/Resources/airbridge-server"
chmod 755 "$APP/Contents/Resources/airbridge-server" "$APP/Contents/MacOS/AirBridge"
[ -f macos/AirBridge.icns ] && cp macos/AirBridge.icns "$APP/Contents/Resources/AirBridge.icns"

# The embedded service must be the same version as the bundle (the updater
# and the supervisor both rely on it). Only checkable for the host arch.
if [ "$(uname -m)" = "$([ "$ARCH" = x64 ] && echo x86_64 || echo arm64)" ]; then
  got="$("$APP/Contents/Resources/airbridge-server" --version | awk '{print $NF}')"
  [ "$got" = "$VERSION" ] || { echo "::error title=version mismatch::service reports $got, bundle is $VERSION"; exit 1; }
fi

echo "▸ ad-hoc signing"
# Inner code first, then the bundle (seals Resources; any later edit breaks the seal).
codesign --force --sign - "$APP/Contents/Resources/airbridge-server"
codesign --force --sign - "$APP/Contents/MacOS/AirBridge"
codesign --force --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

ZIP="$OUT/AirBridge-macOS-${ARCH}.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
# Keep an unzipped copy next to the zip for local tests.
rm -rf "$OUT/AirBridge-macOS-${ARCH}.app"
ditto "$APP" "$OUT/AirBridge-macOS-${ARCH}.app"
echo "▸ $ZIP ($(du -h "$ZIP" | awk '{print $1}'))"
