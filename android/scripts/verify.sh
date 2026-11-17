#!/usr/bin/env bash
# Local preflight for the Kotlin engine + Android Jetpack Compose app.
#
#   1. engine sources compile (kotlinc, pure JVM, zero dependencies)
#   2. TypeScript-reference vectors, pairing-link, journal, transport, M1 & M2 checks pass
#   3. app Compose sources compile via Gradle (:app:compileDebugKotlin) when Gradle is present
#
# Environment overrides:
#   KOTLINC       path to kotlinc           (default: kotlinc on PATH)
#   JAVA          path to java              (default: java on PATH)
#   ANDROID_JAR   path to android.jar       (default: auto-detect)
#   KOTLIN_STDLIB kotlin-stdlib.jar for the java classpath (optional on PATH installs)
#   GRADLE_BIN    path to gradle executable (default: auto-detect)
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO="$(pwd)"

KOTLINC="${KOTLINC:-kotlinc}"
if ! command -v "$KOTLINC" >/dev/null 2>&1; then
  if [[ -x "/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc" ]]; then
    KOTLINC="/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc"
  fi
fi
JAVA="${JAVA:-java}"
# kotlinc's own launcher shells out to `java` on PATH — make an explicit JAVA
# visible to it too.
export PATH="$(dirname "$JAVA"):$PATH"

die() { echo "verify: $*" >&2; exit 1; }

command -v "$KOTLINC" >/dev/null 2>&1 || die "kotlinc not found (set KOTLINC=...)"
command -v "$JAVA" >/dev/null 2>&1 || die "java not found (set JAVA=...)"

# --- kotlin-stdlib for the java runtime classpath ---------------------------
find_stdlib() {
  if [[ -n "${KOTLIN_STDLIB:-}" && -f "${KOTLIN_STDLIB:-}" ]]; then echo "$KOTLIN_STDLIB"; return; fi
  local c
  for c in \
    "$(dirname "$(command -v "$KOTLINC")")/../lib/kotlin-stdlib.jar" \
    "$HOME/.sdkman/candidates/kotlin/current/lib/kotlin-stdlib.jar" \
    "/usr/share/kotlin/kotlinc/lib/kotlin-stdlib.jar"; do
    if [[ -f "$c" ]]; then echo "$c"; return; fi
  done
  return 1
}
STDLIB="$(find_stdlib || true)"

OUT="$REPO/build/verify"
rm -rf "$OUT"
mkdir -p "$OUT/engine" "$OUT/app"

echo "==> compiling engine"
ENGINE_SRC=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ENGINE_SRC+=("$line")
done < <(find "$REPO/android/engine/src/main/kotlin" -name '*.kt' | sort)

TEST_SRC=()
while IFS= read -r line; do
  [[ -n "$line" ]] && TEST_SRC+=("$line")
done < <(find "$REPO/android/engine/src/test/kotlin" -name '*.kt' 2>/dev/null | sort)
"$KOTLINC" -nowarn -d "$OUT/engine" "${ENGINE_SRC[@]}" "${TEST_SRC[@]}"

echo "==> running TS-reference vectors"
CP="$OUT/engine"
[[ -n "$STDLIB" ]] && CP="$CP:$STDLIB"
"$JAVA" -cp "$CP" com.airbridge.engine.VectorsTestKt \
  "$REPO/android/engine/src/test/resources/vectors.json"

echo "==> running pairing-link checks"
"$JAVA" -cp "$CP" com.airbridge.engine.PairingLinkTestKt

echo "==> running hotspot pairing checks (endpoint ranking, TCP race, failure classification)"
"$JAVA" -cp "$CP" com.airbridge.engine.HotspotPairingTestKt

echo "==> running phone continuity checks (contacts, calls, screen sharing)"
"$JAVA" -cp "$CP" com.airbridge.engine.ContinuityTestKt

echo "==> running append-only file journal checks"
"$JAVA" -cp "$CP" com.airbridge.engine.FilesTestKt

echo "==> running transport and flow-control regressions"
"$JAVA" -cp "$CP" com.airbridge.engine.TransportTestKt

echo "==> running milestone 1 reliability and packaging checks"
"$JAVA" -cp "$CP" com.airbridge.engine.Milestone1TestKt

echo "==> running milestone 2 high-speed transfer pipeline checks"
"$JAVA" -cp "$CP" com.airbridge.engine.Milestone2TestKt

find_gradle() {
  if [[ -n "${GRADLE_BIN:-}" && -x "${GRADLE_BIN:-}" ]]; then echo "$GRADLE_BIN"; return; fi
  if [[ -x "$REPO/android/gradlew" ]]; then echo "$REPO/android/gradlew"; return; fi
  if command -v gradle >/dev/null 2>&1; then command -v gradle; return; fi
  local cached
  cached="$(find "$HOME/.gradle/wrapper/dists" -name gradle -type f 2>/dev/null | sort | tail -1 || true)"
  if [[ -n "$cached" && -x "$cached" ]]; then echo "$cached"; return; fi
  return 1
}

find_java_home() {
  if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]]; then echo "$JAVA_HOME"; return; fi
  local candidates=(
    "/Users/digantadey/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home"
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -x "$c/bin/java" ]]; then echo "$c"; return; fi
  done
  return 1
}

echo "==> typechecking native Compose app via Gradle"
GRADLE_EXEC="$(find_gradle || true)"
if [[ -n "$GRADLE_EXEC" ]]; then
  RESOLVED_JAVA_HOME="$(find_java_home || true)"
  if [[ -n "$RESOLVED_JAVA_HOME" ]]; then
    JAVA_HOME="$RESOLVED_JAVA_HOME" "$GRADLE_EXEC" -p "$REPO/android" :app:compileDebugKotlin --no-daemon --quiet
  else
    "$GRADLE_EXEC" -p "$REPO/android" :app:compileDebugKotlin --no-daemon --quiet
  fi
else
  die "gradle not found to compile Jetpack Compose :app (set GRADLE_BIN=...)"
fi

echo "VERIFY OK: engine + vectors + Compose app compile"
