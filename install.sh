#!/usr/bin/env bash
# AirBridge installer for macOS + Linux — no sudo, no accounts, no fees.
#
#   curl -fsSL https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.sh | bash
#
# Flags:
#   --autostart   also register a per-user login item (daemon, no admin)
#   --no-start    skip launching AirBridge after install (default: launch)
set -euo pipefail

REPO="${AIRBRIDGE_REPO:-DigantaDey/AirBridge}"
INSTALL_DIR="${AIRBRIDGE_INSTALL_DIR:-$HOME/.local/bin}"
AUTOSTART=0
LAUNCH=1
for arg in "$@"; do
  case "$arg" in
    --autostart) AUTOSTART=1 ;;
    --no-start)  LAUNCH=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) platform="darwin" ;;
  Linux)  platform="linux" ;;
  *) echo "install: unsupported OS '$os' (macOS and Linux only)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64)  a="x64" ;;
  arm64|aarch64) a="arm64" ;;
  *) echo "install: unsupported architecture '$arch'" >&2; exit 1 ;;
esac

asset="AirBridge-${platform}-${a}"
# musl fallback: static build also runs on any glibc distro.
url="https://github.com/${REPO}/releases/latest/download/${asset}"
musl_url="https://github.com/${REPO}/releases/latest/download/${asset}-musl"

mkdir -p "$INSTALL_DIR"
bin="$INSTALL_DIR/AirBridge"

echo "▸ downloading ${asset}"
if ! curl -fL --proto '=https' --tlsv1.2 -o "$bin.tmp" "$url"; then
  echo "▸ glibc build unavailable — trying static (musl) build"
  curl -fL --proto '=https' --tlsv1.2 -o "$bin.tmp" "$musl_url"
fi
chmod +x "$bin.tmp"
mv "$bin.tmp" "$bin"

# macOS: release binaries are ad-hoc signed on macOS CI; this re-sign covers
# locally built copies. Files fetched by curl carry no quarantine attribute,
# so Gatekeeper does not gate launch — no notarization, no $99/yr account.
if [ "$os" = "Darwin" ]; then
  codesign --force -s - "$bin" 2>/dev/null || true
fi

echo "▸ installed: $bin"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "  add to PATH:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

if [ "$AUTOSTART" = "1" ]; then
  if [ "$os" = "Linux" ]; then
    mkdir -p "$HOME/.config/autostart"
    cat > "$HOME/.config/autostart/airbridge.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=AirBridge
Exec=$bin --no-browser
X-GNOME-Autostart-enabled=true
DESKTOP
    echo "▸ autostart registered (~/.config/autostart/airbridge.desktop)"
  else
    plist="$HOME/Library/LaunchAgents/com.airbridge.daemon.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.airbridge.daemon</string>
  <key>ProgramArguments</key>
  <array><string>$bin</string><string>--no-browser</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$HOME/.airbridge/daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/.airbridge/daemon.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/com.airbridge.daemon" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null \
      || launchctl load "$plist" 2>/dev/null || true
    echo "▸ autostart registered (~/Library/LaunchAgents/com.airbridge.daemon.plist)"
  fi
fi

if [ "$LAUNCH" = "1" ]; then
  echo "▸ starting AirBridge (UI on http://localhost:3411)"
  nohup "$bin" --no-browser >/dev/null 2>&1 &
fi

cat <<'DONE'

AirBridge is ready.
  • UI:        http://localhost:3411
  • Android:   install AirBridge.apk from the same release (sideload)
  • Verify:    sha256sum -c SHA256SUMS.txt  (downloaded alongside releases)
DONE
