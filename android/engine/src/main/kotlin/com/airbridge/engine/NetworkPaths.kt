package com.airbridge.engine

import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface

/**
 * One IPv4 address configured on this phone, e.g. the hotspot downlink
 * `ap0 10.42.61.1/24`, Wi-Fi `wlan0 192.168.1.23/24`, or the cellular CLAT
 * `v4-rmnet_data0 192.0.0.2/32`.
 */
data class LocalAddress(val interfaceName: String, val address: String, val prefixLength: Int) {
    /** Cellular/tunnel/loopback addresses never put a LAN peer on-link. */
    val isLan: Boolean get() = !LocalNetworks.isNonLanInterface(interfaceName) && LocalNetworks.isLanAddress(address) && prefixLength in 1..31

    fun contains(host: String): Boolean {
        val target = LocalNetworks.ipv4ToInt(host) ?: return false
        val own = LocalNetworks.ipv4ToInt(address) ?: return false
        val mask = if (prefixLength <= 0) 0 else (-1 shl (32 - prefixLength))
        return (target and mask) == (own and mask)
    }

    override fun toString(): String = "$interfaceName $address/$prefixLength"
}

object LocalNetworks {
    /**
     * Interface names that carry mobile data, tunnels or loopback on Android
     * and desktop JVMs. Matching is by prefix; hotspot/Wi-Fi/USB-tether
     * downlinks (ap0, swlan0, wlan1, softap0, rndis0, ncm0, bt-pan …) are LAN.
     */
    private val NON_LAN = Regex(
        "^(lo|rmnet|rev_rmnet|ccmni|clat|v4-|pdp|seth_|wwan|ppp|tun|ipsec|ims|epdg|dummy|p2p-dummy|ip6tnl|sit|gre|ifb|umts|radio|tailscale|wg|utun|docker|veth|virbr|br-)",
        RegexOption.IGNORE_CASE,
    )

    fun isNonLanInterface(name: String): Boolean = NON_LAN.containsMatchIn(name)

    fun ipv4ToInt(host: String): Int? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        var value = 0
        for (part in parts) {
            if (part.isEmpty() || part.length > 3 || !part.all { it.isDigit() }) return null
            val octet = part.toInt()
            if (octet > 255) return null
            value = (value shl 8) or octet
        }
        return value
    }

    private fun inCidr(host: String, base: String, prefix: Int): Boolean {
        val h = ipv4ToInt(host) ?: return false
        val b = ipv4ToInt(base) ?: return false
        val mask = if (prefix == 0) 0 else (-1 shl (32 - prefix))
        return (h and mask) == (b and mask)
    }

    /** True for usable unicast addresses that are not loopback, link-local or CLAT/464XLAT. */
    fun isLanAddress(host: String): Boolean =
        ipv4ToInt(host) != null &&
            !inCidr(host, "127.0.0.0", 8) && !inCidr(host, "0.0.0.0", 8) &&
            !inCidr(host, "169.254.0.0", 16) && !inCidr(host, "192.0.0.0", 24) &&
            !inCidr(host, "224.0.0.0", 4)

    fun isPrivate(host: String): Boolean =
        inCidr(host, "10.0.0.0", 8) || inCidr(host, "172.16.0.0", 12) || inCidr(host, "192.168.0.0", 16)

    /** Every IPv4 address on the device (Android: works without extra permissions). */
    fun snapshot(): List<LocalAddress> = try {
        NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().flatMap { nic ->
            val up = runCatching { nic.isUp }.getOrDefault(false)
            if (!up) emptyList() else nic.interfaceAddresses.orEmpty().mapNotNull { ia ->
                val inet = ia.address as? Inet4Address ?: return@mapNotNull null
                LocalAddress(nic.name, inet.hostAddress, ia.networkPrefixLength.toInt())
            }
        }
    } catch (_: Exception) {
        emptyList()
    }
}

/** A candidate desktop address with the local network it is reachable through, if any. */
data class RankedHost(val host: String, val via: LocalAddress?) {
    val onLink: Boolean get() = via != null
}

/**
 * Orders the computer's candidate addresses so the one on a network this
 * phone is attached to is tried first.
 *
 * Why: when the phone itself provides the hotspot it has no Wi-Fi client
 * connection; its default route is cellular. An address that is not on the
 * hotspot subnet (e.g. the computer's campus-LAN address) is routed out over
 * mobile data — Android reports `from /192.0.0.2` (the CLAT address) — and the
 * SYN silently dies in the carrier network. The QR now carries every address;
 * this picks the reachable one deterministically.
 *
 * Off-link candidates are kept (routed LANs with several subnets exist) but
 * always ranked after on-link ones; original desktop order breaks ties.
 */
object EndpointSelector {
    fun rank(hosts: List<String>, locals: List<LocalAddress>): List<RankedHost> {
        val lan = locals.filter { it.isLan }
        // Prefer the most specific matching prefix when several interfaces match.
        val ranked = hosts.distinctBy { it.lowercase() }.map { host ->
            RankedHost(host, lan.filter { it.contains(host) }.maxByOrNull { it.prefixLength })
        }
        return ranked.filter { it.onLink } + ranked.filterNot { it.onLink }
    }

    fun order(hosts: List<String>, locals: List<LocalAddress>): List<String> = rank(hosts, locals).map { it.host }

    /**
     * Human explanation when no candidate is on a local network, e.g.
     * "10.205.95.167 is not on any network this phone is connected to
     *  (phone networks: ap0 10.42.61.0/24). …"
     */
    fun offLinkHint(hosts: List<String>, locals: List<LocalAddress>): String? {
        val ranked = rank(hosts, locals)
        if (ranked.isEmpty() || ranked.any { it.onLink }) return null
        val ipHosts = ranked.map { it.host }.filter { LocalNetworks.ipv4ToInt(it) != null }
        if (ipHosts.isEmpty()) return null
        val lan = locals.filter { it.isLan }
        val networks = if (lan.isEmpty()) "mobile data only" else lan.joinToString { "${it.interfaceName} ${networkOf(it)}" }
        return "${ipHosts.joinToString()} ${if (ipHosts.size == 1) "is" else "are"} not on any network this phone is connected to (phone networks: $networks)."
    }

    private fun networkOf(local: LocalAddress): String {
        val value = LocalNetworks.ipv4ToInt(local.address) ?: return local.address
        val mask = if (local.prefixLength <= 0) 0 else (-1 shl (32 - local.prefixLength))
        val n = value and mask
        return "${(n ushr 24) and 255}.${(n ushr 16) and 255}.${(n ushr 8) and 255}.${n and 255}/${local.prefixLength}"
    }
}

/**
 * Asks the kernel which local address it would use to reach [host] without
 * sending a packet (UDP connect only performs a route lookup). On the
 * screenshot device this returns 192.0.0.2 — proof the destination is routed
 * over cellular, not the hotspot.
 */
object RouteProbe {
    fun sourceAddressFor(host: String, port: Int): String? = try {
        DatagramSocket().use { socket ->
            socket.connect(InetSocketAddress(InetAddress.getByName(host), port.coerceIn(1, 65535)))
            socket.localAddress?.hostAddress?.takeUnless { it == "0.0.0.0" || it == "::" }
        }
    } catch (_: Exception) {
        null
    }
}
