#!/usr/bin/env bash
# Local preflight for the Kotlin engine + Android app — no Gradle required.
#
#   1. engine sources compile (kotlinc, pure JVM, zero dependencies)
#   2. TypeScript-reference vectors pass (62 cross-implementation checks)
#   3. app sources typecheck against android.jar (framework Views only)
#
# Environment overrides:
#   KOTLINC       path to kotlinc           (default: kotlinc on PATH)
#   JAVA          path to java              (default: java on PATH)
#   ANDROID_JAR   path to android.jar       (default: auto-detect)
#   KOTLIN_STDLIB kotlin-stdlib.jar for the java classpath (optional on PATH installs)
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO="$(pwd)"

KOTLINC="${KOTLINC:-kotlinc}"
JAVA="${JAVA:-java}"
# kotlinc's own launcher shells out to `java` on PATH — make an explicit JAVA
# visible to it too.
export PATH="$(dirname "$JAVA"):$PATH"

die() { echo "verify: $*" >&2; exit 1; }

command -v "$KOTLINC" >/dev/null 2>&1 || die "kotlinc not found (set KOTLINC=...)"
command -v "$JAVA" >/dev/null 2>&1 || die "java not found (set JAVA=...)"

# --- locate android.jar -----------------------------------------------------
find_android_jar() {
  if [[ -n "${ANDROID_JAR:-}" && -f "${ANDROID_JAR:-}" ]]; then echo "$ANDROID_JAR"; return; fi
  local candidates=(
    "${ANDROID_HOME:-/nonexistent}"/platforms/android-35/android.jar
    "${ANDROID_SDK_ROOT:-/nonexistent}"/platforms/android-35/android.jar
    "$HOME/toolchains/android-platforms/android-35/android.jar"
    "$HOME/toolchains/android-platforms/android-34/android.jar"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -f "$c" ]]; then echo "$c"; return; fi
  done
  return 1
}
ANDROID_JAR_PATH="$(find_android_jar)" || die "android.jar not found (set ANDROID_JAR=...)"

# --- kotlin-stdlib for the java runtime classpath ---------------------------
find_stdlib() {
  if [[ -n "${KOTLIN_STDLIB:-}" && -f "${KOTLIN_STDLIB:-}" ]]; then echo "$KOTLIN_STDLIB"; return; fi
  local home
  home="$("$KOTLINC" -version 2>&1 | sed -n 's/.*INFO: kotlinc/ /p' | tr -d ' ' || true)"
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
mapfile -t ENGINE_SRC < <(find "$REPO/android/engine/src/main/kotlin" -name '*.kt' | sort)
mapfile -t TEST_SRC < <(find "$REPO/android/engine/src/test/kotlin" -name '*.kt' 2>/dev/null | sort)
"$KOTLINC" -nowarn -d "$OUT/engine" "${ENGINE_SRC[@]}" "${TEST_SRC[@]}"

echo "==> running TS-reference vectors"
CP="$OUT/engine"
[[ -n "$STDLIB" ]] && CP="$CP:$STDLIB"
"$JAVA" -cp "$CP" com.airbridge.engine.VectorsTestKt \
  "$REPO/android/engine/src/test/resources/vectors.json"

echo "==> typechecking app against android.jar"
mapfile -t APP_SRC < <(find "$REPO/android/app/src/main/kotlin" -name '*.kt' | sort)
"$KOTLINC" -nowarn -classpath "$ANDROID_JAR_PATH:$OUT/engine" -d "$OUT/app" "${APP_SRC[@]}"

echo "VERIFY OK: engine + vectors + app typecheck"
