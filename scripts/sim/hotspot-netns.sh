#!/usr/bin/env bash
# Simulate "MacBook on an Android phone hotspot" with Linux network namespaces.
#
#   sudo scripts/sim/hotspot-netns.sh up   <scenario>
#   sudo scripts/sim/hotspot-netns.sh down
#
# Namespaces:
#   abmac      the computer running AirBridge (interfaces named like macOS: en0, en7)
#   abphone    the Android phone: hotspot downlink `ap0` + cellular uplink `rmnet0`
#              carrying the 464XLAT CLAT address 192.0.0.2 (what the screenshot shows)
#   abcarrier  the mobile carrier: owns the default route and silently drops
#              traffic for private (RFC 1918) destinations -> TCP connect timeout
#   abcampus   an unrelated LAN the computer may also be attached to
#
# Scenarios:
#   two-nics      Mac en0 = 10.205.95.167/22 on an unrelated LAN (campus/office/
#                 home Wi-Fi or Ethernet), Mac en7 = 10.42.61.23/24 on the phone's
#                 hotspot. en0 sorts first, so the old QR advertised 10.205.95.167.
#   hotspot-only  Mac en0 = 10.205.95.167/24 *is* on the phone's hotspot.
#   firewall      like hotspot-only, but the Mac drops inbound TCP/3000 on en0
#                 (models the macOS application firewall in stealth mode).
#                 Connects via the reverse path (the Mac dials the phone, its
#                 default gateway); AIRBRIDGE_SIM_REVERSE=0 shows the old failure.
#
# Requires root (ip netns). Not run in CI. End-to-end probe (real server +
# real Android engine): scripts/sim/run-scenario.sh <scenario>.
# See docs/hotspot-pairing.md.
set -euo pipefail

NS_MAC=abmac NS_PHONE=abphone NS_CARRIER=abcarrier NS_CAMPUS=abcampus

down() {
  for ns in "$NS_MAC" "$NS_PHONE" "$NS_CARRIER" "$NS_CAMPUS"; do
    ip netns del "$ns" 2>/dev/null || true
  done
}

link() { # link <nsA> <ifA> <nsB> <ifB>
  ip link add "$2" netns "$1" type veth peer name "$4" netns "$3"
  ip -n "$1" link set "$2" up
  ip -n "$3" link set "$4" up
}

up() {
  local scenario="${1:-two-nics}"
  down
  for ns in "$NS_MAC" "$NS_PHONE" "$NS_CARRIER" "$NS_CAMPUS"; do
    ip netns add "$ns"
    ip -n "$ns" link set lo up
  done

  # Phone cellular uplink: CLAT 192.0.0.2 with the default route via the carrier.
  link "$NS_PHONE" rmnet0 "$NS_CARRIER" pgw0
  ip -n "$NS_PHONE" addr add 192.0.0.2/29 dev rmnet0
  ip -n "$NS_CARRIER" addr add 192.0.0.1/29 dev pgw0
  ip -n "$NS_PHONE" route add default via 192.0.0.1 dev rmnet0 src 192.0.0.2
  # The carrier never forwards private destinations: SYNs vanish (timeout).
  ip netns exec "$NS_CARRIER" sysctl -qw net.ipv4.ip_forward=0

  case "$scenario" in
    two-nics)
      link "$NS_MAC" en0 "$NS_CAMPUS" lan0
      ip -n "$NS_MAC" addr add 10.205.95.167/22 dev en0
      ip -n "$NS_CAMPUS" addr add 10.205.92.1/22 dev lan0
      ip -n "$NS_MAC" route add default via 10.205.92.1 dev en0
      link "$NS_MAC" en7 "$NS_PHONE" ap0
      ip -n "$NS_MAC" addr add 10.42.61.23/24 dev en7
      ip -n "$NS_PHONE" addr add 10.42.61.1/24 dev ap0
      ;;
    hotspot-only)
      link "$NS_MAC" en0 "$NS_PHONE" ap0
      ip -n "$NS_MAC" addr add 10.205.95.167/24 dev en0
      ip -n "$NS_PHONE" addr add 10.205.95.1/24 dev ap0
      ip -n "$NS_MAC" route add default via 10.205.95.1 dev en0
      ;;
    firewall)
      link "$NS_MAC" en0 "$NS_PHONE" ap0
      ip -n "$NS_MAC" addr add 10.205.95.167/24 dev en0
      ip -n "$NS_PHONE" addr add 10.205.95.1/24 dev ap0
      ip -n "$NS_MAC" route add default via 10.205.95.1 dev en0
      # Stealth-mode firewall: the SYN arrives but is never answered. This
      # sandbox kernel has no netfilter, so blackhole the Mac's SYN-ACKs from
      # port 3000 with policy routing instead -- same effect on the wire.
      ip -n "$NS_MAC" rule add ipproto tcp sport 3000 lookup 100 priority 100
      ip -n "$NS_MAC" route add blackhole default table 100
      ;;
    *) echo "unknown scenario: $scenario" >&2; exit 2 ;;
  esac
  echo "scenario $scenario is up"
  echo "--- $NS_MAC";   ip -n "$NS_MAC" -4 -br addr
  echo "--- $NS_PHONE"; ip -n "$NS_PHONE" -4 -br addr; ip -n "$NS_PHONE" -4 route
}

case "${1:-}" in
  up) up "${2:-two-nics}" ;;
  down) down ;;
  *) echo "usage: $0 up <two-nics|hotspot-only|firewall> | down" >&2; exit 2 ;;
esac
