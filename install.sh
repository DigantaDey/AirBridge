#!/usr/bin/env bash
# AirBridge installer for macOS + Linux — no sudo, no accounts, no fees.
#
#   curl -fsSL https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.sh | bash
#
# Flags:
#   --autostart     also register a per-user login item (daemon, no admin)
#   --no-start      skip launching AirBridge after install (default: launch)
#   --from-source   skip the prebuilt binary; clone + build + install locally
#
# Env:
#   AIRBRIDGE_REPO          owner/name (default: DigantaDey/AirBridge)
#   AIRBRIDGE_INSTALL_DIR   install location (default: ~/.local/bin)
#   AIRBRIDGE_VERSION       release tag to install (default: latest)
#   AIRBRIDGE_ALLOW_SOURCE  set to 0 to disable the automatic source fallback
set -euo pipefail

REPO="${AIRBRIDGE_REPO:-DigantaDey/AirBridge}"
INSTALL_DIR="${AIRBRIDGE_INSTALL_DIR:-$HOME/.local/bin}"
PORT="${PORT:-3000}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "install: PORT must be between 1 and 65535" >&2; exit 1
fi
AUTOSTART=0
LAUNCH=1
FROM_SOURCE=0
for arg in "$@"; do
  case "$arg" in
    --autostart)   AUTOSTART=1 ;;
    --no-start)    LAUNCH=0 ;;
    --from-source) FROM_SOURCE=1 ;;
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

mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
bin="$INSTALL_DIR/AirBridge"
tmp="$(mktemp "${TMPDIR:-/tmp}/airbridge.XXXXXX")"
sums="$(mktemp "${TMPDIR:-/tmp}/airbridge-sums.XXXXXX")"
errlog="$(mktemp "${TMPDIR:-/tmp}/airbridge-err.XXXXXX")"
cleanup() { rm -f "$tmp" "$sums" "$errlog"; }
trap cleanup EXIT

# --- release URLs -----------------------------------------------------------
# Canonical asset name: AirBridge-<os>-<arch>, plus a static -musl variant on
# Linux. `latest/download/...` is used first; if that 404s (naming drift or a
# release that predates the current scheme) we ask the API what is actually
# attached and match on that.
asset="AirBridge-${platform}-${a}"
base="https://github.com/${REPO}/releases"
if [ -n "${AIRBRIDGE_VERSION:-}" ]; then
  primary="$base/download/${AIRBRIDGE_VERSION}/${asset}"
  sums_url="$base/download/${AIRBRIDGE_VERSION}/SHA256SUMS.txt"
else
  primary="$base/latest/download/${asset}"
  sums_url="$base/latest/download/SHA256SUMS.txt"
fi
# musl is a Linux-only ABI; macOS binaries from Bun are already self-contained.
musl_url=""
if [ "$platform" = "linux" ]; then
  if [ -n "${AIRBRIDGE_VERSION:-}" ]; then
    musl_url="$base/download/${AIRBRIDGE_VERSION}/${asset}-musl"
  else
    musl_url="$base/latest/download/${asset}-musl"
  fi
fi

# -s keeps the progress meter quiet; 2>$errlog preserves the reason a download
# failed so the error message can be specific instead of a bare curl exit code.
fetch() { # fetch <url> <dest>
  : > "$errlog"
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 \
       --retry 2 --retry-delay 1 -o "$2" "$1" 2>"$errlog"
}

last_error() { [ -s "$errlog" ] && sed 's/^/  /' "$errlog" >&2 || true; }

# Ask the GitHub API for the newest release and return the asset name that
# matches this platform — tolerates historical names such as macOS-*.
discover_asset() {
  command -v curl >/dev/null 2>&1 || return 1
  local api="https://api.github.com/repos/${REPO}/releases"
  local tag
  if [ -n "${AIRBRIDGE_VERSION:-}" ]; then
    api="$api/tags/${AIRBRIDGE_VERSION}"
  else
    api="$api/latest"
  fi
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 "$api" 2>/dev/null \
    | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed 's/.*"\(https[^"]*\)"/\1/' \
    | grep -i -- "${platform}\|macos" \
    | grep -v -- '-musl' \
    | grep -E -- "-${a}(\.exe)?$" \
    | head -n 1
}

download_binary() {
  case "$FROM_SOURCE" in 1) return 1 ;; esac

  echo "▸ downloading ${asset}"
  if fetch "$primary" "$tmp" && [ -s "$tmp" ]; then
    return 0
  fi

  if [ -n "$musl_url" ]; then
    echo "▸ glibc build unavailable — trying static (musl) build"
    if fetch "$musl_url" "$tmp" && [ -s "$tmp" ]; then
      asset="${asset}-musl"
      return 0
    fi
  fi

  echo "▸ release asset '${asset}' not found — checking the release manifest"
  local discovered
  discovered="$(discover_asset || true)"
  if [ -n "$discovered" ]; then
    asset="${discovered##*/}"
    echo "▸ downloading ${asset}"
    if fetch "$discovered" "$tmp" && [ -s "$tmp" ]; then
      sums_url="${discovered%/*}/SHA256SUMS.txt"
      return 0
    fi
  fi

  if grep -qi '404\|not found' "$errlog" 2>/dev/null; then
    echo "✖ no prebuilt AirBridge binary is published for ${platform}/${a} yet." >&2
  else
    echo "✖ could not download ${asset} — the network request failed:" >&2
    last_error
  fi
  return 1
}

verify_checksum() {
  if ! fetch "$sums_url" "$sums" || [ ! -s "$sums" ]; then
    return 0 # no manifest published — nothing to compare against
  fi
  local want got
  want="$(awk -v n="$asset" '$2 == n || $2 == "*"n { print $1 }' "$sums" | head -n 1)"
  [ -n "$want" ] || return 0
  if command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  else
    got="$(sha256sum "$tmp" | awk '{print $1}')"
  fi
  if [ "$want" != "$got" ]; then
    echo "✖ checksum mismatch for ${asset}" >&2
    echo "  expected $want" >&2
    echo "  got      $got" >&2
    return 1
  fi
  echo "▸ checksum verified (sha256 ${got:0:16}…)"
}

# --- source fallback --------------------------------------------------------
install_from_source() {
  local need cmd src="$HOME/.local/share/airbridge/src"
  echo "▸ falling back to a local source build (this takes a few minutes)"
  for cmd in git node npm; do
    command -v "$cmd" >/dev/null 2>&1 || {
      echo "✖ '$cmd' is required for the source build. Install Node.js 20+ and Git," >&2
      echo "  then retry:" >&2
      echo "    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --from-source" >&2
      return 1
    }
  done
  need="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${need:-0}" -lt 20 ]; then
    echo "✖ Node.js 20+ is required (found $(node -v 2>/dev/null || echo none))" >&2
    return 1
  fi
  mkdir -p "$(dirname "$src")"
  if [ -d "$src/.git" ]; then
    git -C "$src" pull --ff-only --depth 1 >/dev/null 2>&1 || true
  else
    rm -rf "$src"
    git clone --depth 1 "https://github.com/${REPO}.git" "$src" >/dev/null 2>&1 || {
      echo "✖ could not clone https://github.com/${REPO}.git" >&2
      return 1
    }
  fi
  ( cd "$src" && npm ci --no-audit --no-fund && npm run build ) >/dev/null 2>&1 || {
    echo "✖ source build failed — run it verbosely to see why:" >&2
    echo "    cd \"$src\" && npm ci && npm run build" >&2
    return 1
  }
  [ -f "$src/dist/server/server/index.js" ] || {
    echo "✖ source build produced no server bundle" >&2
    return 1
  }
  # Thin launcher so `AirBridge` keeps working like the single-file binary.
  # Finder/Launchpad does not inherit an interactive shell's PATH (nvm, etc.).
  # Resolve Node now and shell-escape paths so spaces and quotes remain safe.
  {
    printf '#!/usr/bin/env bash\n'
    printf 'cd %q || exit 1\n' "$src"
    printf 'exec env NODE_ENV=production %q %q "$@"\n' "$(command -v node)" "$src/dist/server/server/index.js"
  } > "$bin.tmp"
  chmod +x "$bin.tmp"
  return 0
}

# Prebuilt AirBridge.app from the release (Swift shell + embedded service,
# ad-hoc signed in CI): no Xcode/swiftc needed, and the in-app updater can
# replace it as a whole. Returns 1 when the release has no app bundle.
install_prebuilt_macos_app() {
  local app="$1" zip_asset="AirBridge-macOS-${a}.zip" zip_url want got stage
  [ "${AIRBRIDGE_PREBUILT_APP:-1}" = "1" ] || return 1
  [ "$mode" = "binary" ] || return 1
  if [ -n "${AIRBRIDGE_VERSION:-}" ]; then
    zip_url="$base/download/${AIRBRIDGE_VERSION}/${zip_asset}"
  else
    zip_url="$base/latest/download/${zip_asset}"
  fi
  echo "▸ downloading ${zip_asset}"
  if ! fetch "$zip_url" "$tmp" || [ ! -s "$tmp" ]; then
    echo "▸ no prebuilt app in this release; building the app locally"
    return 1
  fi
  # The app is only accepted with a matching published checksum.
  if ! fetch "$sums_url" "$sums" || [ ! -s "$sums" ]; then
    echo "⚠ no SHA256SUMS.txt for the prebuilt app; building the app locally instead" >&2
    return 1
  fi
  want="$(awk -v n="$zip_asset" '$2 == n || $2 == "*"n { print $1 }' "$sums" | head -n 1)"
  got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "✖ checksum mismatch for ${zip_asset}; not installing it" >&2
    return 1
  fi
  echo "▸ checksum verified (sha256 ${got:0:16}…)"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/airbridge-app.XXXXXX")"
  if ! ditto -x -k "$tmp" "$stage" || [ ! -x "$stage/AirBridge.app/Contents/MacOS/AirBridge" ] \
     || ! grep -q 'com.airbridge.launcher' "$stage/AirBridge.app/Contents/Info.plist" \
     || ! codesign --verify --deep --strict "$stage/AirBridge.app" 2>/dev/null \
     || ! "$stage/AirBridge.app/Contents/Resources/airbridge-server" --version >/dev/null 2>&1; then
    echo "⚠ the prebuilt app failed verification; building the app locally instead" >&2
    rm -rf "$stage"
    return 1
  fi
  # The old bundle is kept until the new one is in place.
  mkdir -p "$(dirname "$app")"
  if [ -e "$app" ]; then mv "$app" "$stage/AirBridge.app.old"; fi
  if ! mv "$stage/AirBridge.app" "$app"; then
    if [ -e "$stage/AirBridge.app.old" ]; then mv "$stage/AirBridge.app.old" "$app"; fi
    rm -rf "$stage"
    return 1
  fi
  rm -rf "$stage"
  # Per-user settings live outside the signed bundle (editing it breaks the seal).
  mkdir -p "$HOME/.airbridge"
  if [ "$PORT" != "3000" ]; then printf '%s\n' "$PORT" > "$HOME/.airbridge/port"; else rm -f "$HOME/.airbridge/port"; fi
  # One copy of the service: the CLI runs the app's embedded binary, so app
  # updates update the CLI too.
  ln -sfn "$app/Contents/Resources/airbridge-server" "$bin"
  if [ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]; then
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" || true
  fi
  echo "▸ app installed: $app (prebuilt, signature verified; updates itself from the menu bar)"
  return 0
}

# Install a tiny Launch Services app that starts the same server as the CLI.
# The installer is often piped to bash, so everything needed to create the
# launcher is included here; the artwork is fetched separately and is optional.
install_macos_app() {
  local app="$HOME/Applications/AirBridge.app" contents icon_url
  contents="$app/Contents"
  if [ -e "$app" ] && { [ ! -f "$contents/Info.plist" ] || ! grep -q 'com.airbridge.launcher' "$contents/Info.plist"; }; then
    echo "✖ $app already exists and is not an AirBridge launcher; not replacing it." >&2
    return 1
  fi
  if install_prebuilt_macos_app "$app"; then
    return 0
  fi
  # Fallback (older releases, source installs): assemble the app locally. An
  # earlier prebuilt bundle is sealed; start from a clean directory.
  if [ -f "$contents/Resources/airbridge-server" ]; then rm -rf "$app"; fi
  mkdir -p "$contents/MacOS" "$contents/Resources"
  cat > "$contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.airbridge.launcher</string>
  <key>CFBundleName</key><string>AirBridge</string>
  <key>CFBundleDisplayName</key><string>AirBridge</string>
  <key>CFBundleExecutable</key><string>AirBridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AirBridge.icns</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key><string>Your paired phone can hand over its hotspot over Bluetooth when it and this Mac share no network.</string>
</dict></plist>
PLIST
  printf '%s\n' "$bin" > "$contents/Resources/binary-path"
  printf '%s\n' "$PORT" > "$contents/Resources/port"

  # Compile Native Swift App Launcher if swiftc is available
  local local_swift="$(dirname "$0")/scripts/mac_app.swift"
  local swift_src="$(mktemp "${TMPDIR:-/tmp}/mac_app.XXXXXX.swift")"
  local swift_url="https://raw.githubusercontent.com/${REPO}/main/scripts/mac_app.swift"

  if [ -f "$local_swift" ]; then
    cp "$local_swift" "$swift_src"
  else
    fetch "$swift_url" "$swift_src" || true
  fi

  if [ "${AIRBRIDGE_NATIVE_APP:-1}" = "1" ] && command -v swiftc >/dev/null 2>&1 && [ -s "$swift_src" ]; then
    echo "▸ compiling native macOS Swift App GUI"
    if swiftc -O -suppress-warnings "$swift_src" -o "$contents/MacOS/AirBridge" -framework AppKit -framework WebKit -framework UserNotifications -framework CoreBluetooth 2>/dev/null; then
      codesign --force -s - "$contents/MacOS/AirBridge" 2>/dev/null || true
      rm -f "$swift_src"
      icon_url="https://raw.githubusercontent.com/${REPO}/main/macos/AirBridge.icns"
      if fetch "$icon_url" "$tmp" && [ -s "$tmp" ]; then
        cp "$tmp" "$contents/Resources/AirBridge.icns"
      fi
      if [ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]; then
        /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" || true
      fi
      echo "▸ native app installed: $app (Launchpad or Applications)"
      return 0
    fi
  fi
  rm -f "$swift_src"

  cat > "$contents/MacOS/AirBridge" <<'APP'
#!/bin/bash
# Launch Services has a minimal environment. Do not rely on shell aliases,
# PATH customizations, or the directory from which the app was opened.
resources="$(cd "$(dirname "$0")/../Resources" && pwd)"
IFS= read -r bin < "$resources/binary-path"
IFS= read -r port < "$resources/port"
url="http://localhost:$port"
log="$HOME/.airbridge/launcher.log"
mkdir -p "$HOME/.airbridge"
ready() {
  curl --noproxy '*' -fsS --max-time 1 "$url/api/health" 2>/dev/null | grep -q '"service":"AirBridge Warp Server"'
}
fail() {
  osascript - "$1" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  display dialog (item 1 of argv) with title "AirBridge" buttons {"OK"} default button "OK" with icon caution
end run
APPLESCRIPT
  exit 1
}
if ! ready; then
  [ -x "$bin" ] || fail "AirBridge could not be found at $bin. Reinstall AirBridge to restore it."
  PORT="$port" nohup "$bin" --no-browser >> "$log" 2>&1 < /dev/null &
  # TLS certificate generation can take a few seconds on the first launch.
  for ((i=0; i<60; i++)); do
    ready && break
    sleep 1
  done
  ready || fail "AirBridge could not start on port $port. Check that the port is free and see $log for details."
fi
open "$url" || fail "AirBridge is running, but the browser could not be opened."
APP
  chmod +x "$contents/MacOS/AirBridge"
  icon_url="https://raw.githubusercontent.com/${REPO}/main/macos/AirBridge.icns"
  if fetch "$icon_url" "$tmp" && [ -s "$tmp" ]; then
    cp "$tmp" "$contents/Resources/AirBridge.icns"
  else
    echo "⚠ could not download the AirBridge icon; the app will use a generic icon." >&2
  fi
  # Launch Services normally notices apps in ~/Applications automatically;
  # request registration too so it appears promptly on existing desktops.
  if [ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]; then
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" || true
  fi
  echo "▸ app installed: $app (open from Launchpad or Applications)"
}

# --- install ----------------------------------------------------------------
mode="binary"
if ! download_binary; then
  if [ "${AIRBRIDGE_ALLOW_SOURCE:-1}" = "0" ]; then
    echo "  Re-run with --from-source to build AirBridge locally instead." >&2
    exit 1
  fi
  install_from_source
  mode="source"
else
  verify_checksum
  chmod +x "$tmp"
  mv "$tmp" "$bin.tmp"
  # A binary that cannot report its version is the wrong arch, truncated, or
  # unsigned in a way the kernel refuses (Apple silicon kills unsigned arm64).
  if ! "$bin.tmp" --version >/dev/null 2>"$errlog"; then
    echo "✖ the downloaded binary failed to start:" >&2
    last_error
    rm -f "$bin.tmp"
    if [ "${AIRBRIDGE_ALLOW_SOURCE:-1}" = "0" ]; then exit 1; fi
    echo "▸ trying a local source build instead"
    install_from_source || exit 1
    mode="source"
  fi
fi

stop_running_daemon() {
  stopped=0
  # A LaunchAgent with KeepAlive (e.g. the sample macos/com.airbridge.daemon.plist)
  # would immediately respawn the old server; unload it first. Autostart below
  # registers it again for the new binary when requested.
  if [ "$os" = "Darwin" ] && command -v launchctl >/dev/null 2>&1 \
     && launchctl list 2>/dev/null | grep -q 'com\.airbridge\.daemon'; then
    launchctl bootout "gui/$(id -u)/com.airbridge.daemon" 2>/dev/null \
      || launchctl unload "$HOME/Library/LaunchAgents/com.airbridge.daemon.plist" 2>/dev/null || true
  fi
  if [ -e "$bin" ] && command -v pgrep >/dev/null 2>&1; then
    for pid in $(pgrep -f "$bin" 2>/dev/null || true); do
      [ "$pid" = "$$" ] && continue
      kill -TERM "$pid" 2>/dev/null && stopped=1 || true
    done
  fi
  # Whatever AirBridge still holds the port (an older install at another path,
  # a source checkout, …) would keep answering with its old version and old
  # addresses after this update. Never touch non-AirBridge programs.
  if command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
      [ "$pid" = "$$" ] && continue
      cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
      case "$cmd" in
        *AirBridge*|*airbridge*) kill -TERM "$pid" 2>/dev/null && stopped=1 || true ;;
      esac
    done
  fi
  if [ "$stopped" = "1" ]; then
    sleep 0.5
  fi
}

stop_running_daemon
chmod +x "$bin.tmp"
# A previous prebuilt-app install made $bin a symlink into the app bundle;
# replace the link itself, never the file inside the signed bundle.
if [ -L "$bin" ]; then rm -f "$bin"; fi
mv "$bin.tmp" "$bin"

# macOS: release binaries are ad-hoc signed on macOS CI; this re-sign covers
# locally built copies. Files fetched by curl carry no quarantine attribute,
# so Gatekeeper does not gate launch — no notarization, no $99/yr account.
if [ "$os" = "Darwin" ] && [ "$mode" = "binary" ]; then
  codesign --force -s - "$bin" 2>/dev/null || true
fi

echo "▸ installed: $bin ($mode install)"
if [ "$os" = "Darwin" ]; then
  # A running AirBridge.app keeps its window (and the old UI) alive in the menu
  # bar; the server it was showing was just stopped. Quit it, install the new
  # launcher, and start it again so it runs the new version end to end.
  app_exe="$HOME/Applications/AirBridge.app/Contents/MacOS/AirBridge"
  app_was_running=0
  if command -v pgrep >/dev/null 2>&1 && pgrep -f "$app_exe" >/dev/null 2>&1; then
    app_was_running=1
    echo "▸ quitting the running AirBridge app"
    osascript -e 'tell application id "com.airbridge.launcher" to quit' >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      pgrep -f "$app_exe" >/dev/null 2>&1 || break
      sleep 0.25
    done
    pkill -TERM -f "$app_exe" >/dev/null 2>&1 || true
  fi
  install_macos_app
  if [ "$app_was_running" = "1" ] && [ -d "$HOME/Applications/AirBridge.app" ]; then
    echo "▸ starting AirBridge again"
    open "$HOME/Applications/AirBridge.app" >/dev/null 2>&1 || true
  fi
fi
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "  add to PATH:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

xml_escape() { sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

if [ "$AUTOSTART" = "1" ]; then
  mkdir -p "$HOME/.airbridge"
  if [ "$os" = "Linux" ]; then
    # Preferred: a systemd user service (restarts on failure and after updates).
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      unit_dir="$HOME/.config/systemd/user"
      mkdir -p "$unit_dir"
      cat > "$unit_dir/airbridge.service" <<UNIT
[Unit]
Description=AirBridge (end-to-end encrypted file and clipboard sharing)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
ExecStart="$bin" --no-browser --port $PORT
Environment=PORT=$PORT
Environment=AIRBRIDGE_SUPERVISED=systemd
# Exit 75 = "restart me" (update installed); crashes restart too, throttled.
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
      rm -f "$HOME/.config/autostart/airbridge.desktop"
      systemctl --user daemon-reload || true
      if systemctl --user enable --now airbridge.service >/dev/null 2>&1; then
        LAUNCH=0 # systemd started it
      fi
      echo "▸ autostart registered (systemd user service: systemctl --user status airbridge)"
    else
      mkdir -p "$HOME/.config/autostart"
      cat > "$HOME/.config/autostart/airbridge.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=AirBridge
Exec=$bin --no-browser
X-GNOME-Autostart-enabled=true
DESKTOP
      echo "▸ autostart registered (~/.config/autostart/airbridge.desktop)"
    fi
  else
    domain="gui/$(id -u)"
    app_exe="$HOME/Applications/AirBridge.app/Contents/MacOS/AirBridge"
    if [ -x "$app_exe" ] && [ "$(head -c 2 "$app_exe")" != "#!" ]; then
      # Native app: start it at login (menu bar; it supervises the service).
      # Same agent as the app's "Open at Login" menu item.
      launchctl bootout "$domain/com.airbridge.daemon" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/com.airbridge.daemon.plist"
      label="com.airbridge.app"
      args="<string>$(printf %s "$app_exe" | xml_escape)</string><string>--background</string>"
      env_xml=""
    else
      label="com.airbridge.daemon"
      args="<string>$(printf %s "$bin" | xml_escape)</string><string>--no-browser</string><string>--port</string><string>$PORT</string>"
      env_xml="<key>EnvironmentVariables</key><dict><key>PORT</key><string>$PORT</string><key>AIRBRIDGE_SUPERVISED</key><string>launchd</string></dict>"
    fi
    plist="$HOME/Library/LaunchAgents/$label.plist"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>$args</array>
  $env_xml
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash or an update (exit 75), not after Quit (exit 0). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(printf %s "$HOME/.airbridge/daemon.log" | xml_escape)</string>
  <key>StandardErrorPath</key><string>$(printf %s "$HOME/.airbridge/daemon.log" | xml_escape)</string>
</dict>
</plist>
PLIST
    launchctl bootout "$domain/$label" 2>/dev/null || true
    launchctl bootstrap "$domain" "$plist" 2>/dev/null \
      || launchctl load "$plist" 2>/dev/null || true
    echo "▸ autostart registered (~/Library/LaunchAgents/$label.plist)"
  fi
fi

if [ "$LAUNCH" = "1" ]; then
  echo "▸ starting AirBridge (UI on http://localhost:${PORT})"
  if [ "$os" = "Darwin" ]; then
    open "$HOME/Applications/AirBridge.app" || echo "⚠ could not open the app; launch AirBridge from Applications." >&2
  else
    nohup "$bin" --no-browser >/dev/null 2>&1 &
  fi
fi

cat <<DONE

AirBridge is ready.
  • UI:        http://localhost:${PORT}
  • Android:   sideload AirBridge.apk from https://github.com/${REPO}/releases/latest
  • Verify:    sha256sum -c SHA256SUMS.txt  (downloaded alongside releases)
  • Uninstall: rm "$bin"
DONE
if [ "$os" = "Darwin" ]; then
  echo '  • Mac app:   ~/Applications/AirBridge.app (Launchpad or Finder)'
  echo '  • Remove:    delete AirBridge.app from Applications; remove the binary above'
  echo '               (if enabled, also remove ~/Library/LaunchAgents/com.airbridge.app.plist'
  echo '               or com.airbridge.daemon.plist)'
fi
