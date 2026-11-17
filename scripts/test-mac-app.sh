#!/usr/bin/env bash
# Real macOS test of the AirBridge.app shell (scripts/mac_app.swift) as a
# service supervisor. Runs in CI on macos-latest (GUI session available).
#
#   scripts/test-mac-app.sh <path-to-darwin-binary> [<prebuilt AirBridge.app>]
#
#  1. starts the installed service and serves the UI
#  2. restarts the service when it is killed
#  3. replaces a stale (older / version-less) AirBridge server on the port
#  4. never touches a non-AirBridge program on the port
#  5. stops the service it started when the app quits
#  6. a busy (blocked) service is not restarted; 7. crash loops back off
#  8. prebuilt bundle (scripts/package-mac-app.sh) runs its embedded service,
#     subscribes to the service event stream, and self-update targets the bundle
#  9. a second launch (e.g. login item) hands over and exits
# 10. exit status 75 ("restart me", after an update) restarts at once
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
PKG="${2:-}"
PORT="${AIRBRIDGE_TEST_PORT:-3456}"
WANT="$(node -p 'require("./package.json").version')"
WORK="$(mktemp -d)"
APP="$WORK/AirBridgeTest.app"
EXE="$APP/Contents/MacOS/AirBridge"
APP_PID=""

cleanup() {
  [ -n "$APP_PID" ] && kill -9 "$APP_PID" 2>/dev/null || true
  for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do kill -9 "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*"; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=mac-app supervisor::$*"; echo "--- server.log"; tail -n 60 "$HOME/.airbridge/server.log" 2>/dev/null || true; exit 1; }
ok() { echo "  ok: $*"; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::notice title=mac-app supervisor::$*" || true; }

health() { curl --noproxy '*' -fsS --max-time 2 "http://localhost:$PORT/api/health" 2>/dev/null || true; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];process.stdout.write(v===undefined||v===null?"":String(v))}catch{}})' "$1"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=j[process.argv[1]];process.stdout.write(v===undefined?"":String(v))}catch{}})' "$1"; }
wait_for() { # wait_for <seconds> <description> <command...>
  local secs="$1" what="$2"; shift 2
  for _ in $(seq 1 $((secs * 4))); do
    if "$@"; then return 0; fi
    sleep 0.25
  done
  fail "timed out after ${secs}s: $what"
}
version_is() { [ "$(health | field version)" = "$1" ]; }
pid_differs() { local p; p="$(health | field pid)"; [ -n "$p" ] && [ "$p" != "$1" ]; }
port_free() { [ -z "$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]; }

echo "▸ building test app bundle"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.airbridge.launcher.test</string>
  <key>CFBundleName</key><string>AirBridgeTest</string>
  <key>CFBundleExecutable</key><string>AirBridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
printf '%s\n' "$BIN" > "$APP/Contents/Resources/binary-path"
printf '%s\n' "$PORT" > "$APP/Contents/Resources/port"
swiftc -O scripts/mac_app.swift -o "$EXE" -framework AppKit -framework WebKit -framework UserNotifications
codesign --force -s - "$EXE"
"$BIN" --version | grep -q "$WANT" || fail "binary reports $("$BIN" --version), want $WANT"

launch() { "$EXE" >/dev/null 2>&1 & APP_PID=$!; }
stop_app() { kill -9 "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; APP_PID=""; }

echo "▸ 1. app starts the installed service"
port_free || fail "port $PORT busy before the test"
launch
wait_for 30 "service up with version $WANT" version_is "$WANT"
PID1="$(health | field pid)"
[ -n "$PID1" ] || fail "health has no pid for a local caller"
curl --noproxy '*' -fsS "http://localhost:$PORT/" | grep -qi '<div id="root"' || fail "UI not served"
ok "service $WANT running (pid $PID1), UI served"

echo "▸ 2. killed service is restarted"
kill -9 "$PID1"
wait_for 20 "service restarted" pid_differs "$PID1"
PID2="$(health | field pid)"
ok "restarted after kill (pid $PID1 → $PID2)"

echo "▸ 3. stale AirBridge server on the port is replaced"
stop_app
kill -TERM "$PID2" 2>/dev/null || true
wait_for 10 "port free" port_free
# An "old build": answers /api/health as AirBridge but reports no version.
cat > "$WORK/airbridge-old-server.mjs" <<'JS'
import http from 'node:http';
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', service: 'AirBridge Warp Server', lanUrls: ['https://10.205.95.167:3000'] }));
}).listen(Number(process.argv[2]), '0.0.0.0');
JS
node "$WORK/airbridge-old-server.mjs" "$PORT" & OLD_PID=$!
wait_for 10 "old server up" bash -c "curl -fsS --max-time 1 http://localhost:$PORT/api/health >/dev/null"
[ -z "$(health | field version)" ] || fail "fake old server reports a version"
launch
wait_for 30 "stale server replaced by $WANT" version_is "$WANT"
kill -0 "$OLD_PID" 2>/dev/null && fail "old server still running"
ok "version-less AirBridge server replaced by $WANT"

echo "▸ 4. a non-AirBridge program on the port is left alone"
stop_app
for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do kill -TERM "$pid" 2>/dev/null || true; done
wait_for 10 "port free" port_free
cat > "$WORK/other-app.mjs" <<'JS'
import http from 'node:http';
http.createServer((req, res) => { res.end('not airbridge'); }).listen(Number(process.argv[2]), '0.0.0.0');
JS
node "$WORK/other-app.mjs" "$PORT" & OTHER_PID=$!
sleep 1
launch
sleep 8
kill -0 "$OTHER_PID" 2>/dev/null || fail "app killed a non-AirBridge program"
ok "foreign program on port $PORT untouched"
stop_app
kill -TERM "$OTHER_PID" 2>/dev/null || true
wait_for 10 "port free" port_free

echo "▸ 5. quitting the app stops its service"
launch
wait_for 30 "service up" version_is "$WANT"
PID3="$(health | field pid)"
kill -TERM "$APP_PID"   # same path as logout / Activity Monitor → NSApp.terminate
wait_for 15 "service stopped after quit" bash -c "! kill -0 $PID3 2>/dev/null"
APP_PID=""
ok "service stopped with the app"

echo "▸ 6. a busy (event loop blocked) but alive service is NOT restarted"
# Regression: a 15–30 s synchronous helper compile inside the service made the
# old watchdog (3 failed checks ≈ 9 s) restart it forever.
wait_for 10 "port free" port_free
cat > "$WORK/airbridge-busy-server.mjs" <<'JS'
import http from 'node:http';
const [port, version] = [Number(process.argv[2]), process.argv[3]];
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', service: 'AirBridge Warp Server', version, pid: process.pid }));
}).listen(port, '0.0.0.0');
// After start-up, block the event loop for 25 s (like a synchronous swiftc run).
setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25_000), 3_000);
JS
cat > "$WORK/airbridge-busy" <<SH
#!/bin/bash
if [ "\$1" = --version ]; then echo "airbridge $WANT"; exit 0; fi
exec node "$WORK/airbridge-busy-server.mjs" "\$3" "$WANT"
SH
chmod +x "$WORK/airbridge-busy"
printf '%s\n' "$WORK/airbridge-busy" > "$APP/Contents/Resources/binary-path"
launch
wait_for 30 "busy service up" version_is "$WANT"
BUSY_PID="$(health | field pid)"
sleep 6
[ -z "$(health)" ] || fail "busy service still answered (event loop not blocked?)"
sleep 26
kill -0 "$BUSY_PID" 2>/dev/null || fail "busy service was killed by the watchdog"
wait_for 10 "busy service answers again" version_is "$WANT"
[ "$(health | field pid)" = "$BUSY_PID" ] || fail "busy service was restarted (pid changed)"
ok "service blocked for 25 s kept running (pid $BUSY_PID)"
stop_app
kill -TERM "$BUSY_PID" 2>/dev/null || true
wait_for 10 "port free" port_free

echo "▸ 7. a service that crashes at start is backed off, not restarted in a burst"
cat > "$WORK/airbridge-crash" <<SH
#!/bin/bash
if [ "\$1" = --version ]; then echo "airbridge $WANT"; exit 0; fi
echo "simulated start-up failure" >&2
exit 3
SH
chmod +x "$WORK/airbridge-crash"
printf '%s\n' "$WORK/airbridge-crash" > "$APP/Contents/Resources/binary-path"
LOG="$HOME/.airbridge/server.log"
BEFORE=$(wc -l < "$LOG" 2>/dev/null || echo 0)
launch
sleep 20
stop_app
STARTS=$(tail -n +"$((BEFORE + 1))" "$LOG" | grep -c "started AirBridge" || true)
[ "$STARTS" -ge 2 ] || fail "crashed service was not retried ($STARTS starts)"
[ "$STARTS" -le 4 ] || fail "crash loop not backed off: $STARTS starts in 20 s"
tail -n +"$((BEFORE + 1))" "$LOG" | grep -q "simulated start-up failure" || fail "service output not captured in server.log"
ok "crashing service retried with backoff ($STARTS starts in 20 s), output kept in server.log"

echo "▸ 10. exit status 75 (restart after update) restarts immediately, without crash backoff"
wait_for 10 "port free" port_free
cat > "$WORK/airbridge-update" <<SH
#!/bin/bash
if [ "\$1" = --version ]; then echo "airbridge $WANT"; exit 0; fi
# First start: behave like a service that just installed an update.
if [ ! -f "$WORK/updated" ]; then touch "$WORK/updated"; sleep 1; exit 75; fi
exec node "$WORK/airbridge-busy-server.mjs" "\$3" "$WANT"
SH
# Reuse the busy server without its blocking phase.
sed -i '' 's/^setTimeout(() => Atomics.wait.*$//' "$WORK/airbridge-busy-server.mjs"
chmod +x "$WORK/airbridge-update"
printf '%s\n' "$WORK/airbridge-update" > "$APP/Contents/Resources/binary-path"
BEFORE=$(wc -l < "$LOG" 2>/dev/null || echo 0)
launch
wait_for 8 "service back up after exit 75" version_is "$WANT"
tail -n +"$((BEFORE + 1))" "$LOG" | grep -q "asked to be restarted" || fail "exit 75 not recognised"
tail -n +"$((BEFORE + 1))" "$LOG" | grep -q "next start in" && fail "exit 75 was treated as a crash (backoff)"
ok "exit 75 → restarted at once"
stop_app
for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do kill -TERM "$pid" 2>/dev/null || true; done
wait_for 10 "port free" port_free

if [ -n "$PKG" ]; then
  PKG_EXE="$PKG/Contents/MacOS/AirBridge"
  echo "▸ 8. prebuilt bundle runs its embedded service"
  codesign --verify --deep --strict "$PKG" || fail "prebuilt bundle signature invalid"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PKG/Contents/Info.plist")" = "$WANT" ] || fail "bundle version is not $WANT"
  mkdir -p "$HOME/.airbridge"
  PORT_FILE="$HOME/.airbridge/port"
  [ -f "$PORT_FILE" ] && cp "$PORT_FILE" "$WORK/port.bak"
  printf '%s\n' "$PORT" > "$PORT_FILE"   # prebuilt bundles read the port from ~/.airbridge, never from inside the signed bundle
  "$PKG_EXE" >/dev/null 2>&1 & APP_PID=$!
  wait_for 30 "embedded service up" version_is "$WANT"
  SPID="$(health | field pid)"
  ps -p "$SPID" -o command= | grep -q "Contents/Resources/airbridge-server" || fail "service is not the embedded binary: $(ps -p "$SPID" -o command=)"
  wait_for 20 "app subscribed to the service event stream" bash -c "[ \"\$(curl -fsS http://localhost:$PORT/api/diagnostics | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(String(JSON.parse(s).shell.subscribers)))')\" -ge 1 ]"
  DIAG="$(curl -fsS "http://localhost:$PORT/api/diagnostics")"
  [ "$(printf %s "$DIAG" | jget app.appBundle)" = "true" ] || fail "service does not know it runs inside the app bundle"
  [ "$(printf %s "$DIAG" | jget update.supported)" = "true" ] || fail "self-update unsupported in the prebuilt app: $(printf %s "$DIAG" | jget update.reason)"
  [ "$(printf %s "$DIAG" | jget update.asset)" = "AirBridge-macOS-arm64.zip" ] || fail "update asset is $(printf %s "$DIAG" | jget update.asset)"
  ok "embedded service $WANT (pid $SPID), event stream subscribed, updates target AirBridge-macOS-arm64.zip"

  echo "▸ 9. a second launch hands over and exits"
  START=$(date +%s)
  "$PKG_EXE" --background >/dev/null 2>&1 || fail "second instance exited with an error"
  [ $(( $(date +%s) - START )) -le 10 ] || fail "second instance did not exit promptly"
  kill -0 "$APP_PID" 2>/dev/null || fail "first instance died"
  [ "$(health | field pid)" = "$SPID" ] || fail "service was restarted by the second launch"
  ok "second instance exited; first instance and service untouched"

  kill -TERM "$APP_PID"
  wait_for 15 "embedded service stopped with the app" bash -c "! kill -0 $SPID 2>/dev/null"
  APP_PID=""
  if [ -f "$WORK/port.bak" ]; then cp "$WORK/port.bak" "$PORT_FILE"; else rm -f "$PORT_FILE"; fi
fi

echo "MAC APP SUPERVISOR: ALL PASS"
