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
if [ "$platform" = "Linux" ]; then
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
  cat > "$bin.tmp" <<LAUNCHER
#!/usr/bin/env bash
cd "$src" || exit 1
exec env NODE_ENV=production node "$src/dist/server/server/index.js" "\$@"
LAUNCHER
  chmod +x "$bin.tmp"
  return 0
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

chmod +x "$bin.tmp"
mv "$bin.tmp" "$bin"

# macOS: release binaries are ad-hoc signed on macOS CI; this re-sign covers
# locally built copies. Files fetched by curl carry no quarantine attribute,
# so Gatekeeper does not gate launch — no notarization, no $99/yr account.
if [ "$os" = "Darwin" ] && [ "$mode" = "binary" ]; then
  codesign --force -s - "$bin" 2>/dev/null || true
fi

echo "▸ installed: $bin ($mode install)"
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
    mkdir -p "$(dirname "$plist")" "$HOME/.airbridge"
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
  echo "▸ starting AirBridge (UI on http://localhost:${PORT})"
  nohup "$bin" --no-browser >/dev/null 2>&1 &
fi

cat <<DONE

AirBridge is ready.
  • UI:        http://localhost:${PORT}
  • Android:   sideload AirBridge.apk from https://github.com/${REPO}/releases/latest
  • Verify:    sha256sum -c SHA256SUMS.txt  (downloaded alongside releases)
  • Uninstall: rm "$bin"
DONE
