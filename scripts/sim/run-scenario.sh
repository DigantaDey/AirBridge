#!/usr/bin/env bash
# Real-kernel reproduction of the hotspot pairing scenarios (see docs/hotspot-pairing.md).
#
#   scripts/sim/run-scenario.sh <two-nics|hotspot-only|firewall>
#
# Needs: passwordless sudo (ip netns), node + npx tsx, java, kotlinc, and the
# compiled engine classes in $ENGINE_CLASSES (e.g. build/verify/engine from
# android/scripts/verify.sh). The phone namespace runs scripts/sim/HotspotProbe.kt.
set -euo pipefail
cd "$(dirname "$0")/../.."
SCENARIO="${1:?scenario}"
ENGINE_CLASSES="${ENGINE_CLASSES:-build/verify/engine}"
KOTLINC="${KOTLINC:-kotlinc}"
JAVA="${JAVA:-java}"
STDLIB="${KOTLIN_STDLIB:-$(dirname "$(command -v "$KOTLINC")")/../lib/kotlin-stdlib.jar}"
PROBE=/tmp/airbridge-sim/probe
mkdir -p "$PROBE"
"$KOTLINC" -nowarn -cp "$ENGINE_CLASSES" -d "$PROBE" scripts/sim/HotspotProbe.kt
trap 'sudo scripts/sim/hotspot-netns.sh down >/dev/null 2>&1 || true' EXIT
sudo scripts/sim/hotspot-netns.sh up "$SCENARIO"
rm -f /tmp/airbridge-sim/qr.txt
sudo ip netns exec abmac sudo -u "$USER" env PATH="$PATH" HOME="$HOME" AIRBRIDGE_SIM_REVERSE="${AIRBRIDGE_SIM_REVERSE:-1}" timeout 60 npx tsx scripts/sim/hotspot-host.mts &
for _ in $(seq 1 80); do [[ -s /tmp/airbridge-sim/qr.txt ]] && break; sleep 0.5; done
echo "--- phone (netns abphone)"
sudo ip netns exec abphone sudo -u "$USER" "$JAVA" -cp "$PROBE:$(realpath "$ENGINE_CLASSES"):$STDLIB" HotspotProbeKt "$(cat /tmp/airbridge-sim/qr.txt)" || true
sudo ip netns pids abmac | xargs -r sudo kill 2>/dev/null || true
