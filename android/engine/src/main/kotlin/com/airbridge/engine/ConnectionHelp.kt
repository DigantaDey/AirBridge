package com.airbridge.engine

import java.io.EOFException
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

/**
 * What went wrong, at which layer. A TCP timeout happens before TLS, the
 * WebSocket upgrade and pair-code checks, so each needs different advice:
 * changing the pair code never fixes an unreachable address.
 */
enum class FailureKind {
    /** SYN never answered: wrong network/address, routed over cellular, or a firewall dropping it. */
    TCP_TIMEOUT,
    /** Host reachable but nothing listening (AirBridge closed / wrong port) or a firewall rejecting. */
    TCP_REFUSED,
    /** The phone has no route at all (no Wi-Fi/hotspot, airplane mode). */
    NO_ROUTE,
    DNS,
    /** First connection: the certificate chain is not valid. */
    TLS_UNTRUSTED,
    /** The certificate does not chain to the pinned / QR-provided anchor. */
    TLS_PIN_MISMATCH,
    /** The certificate does not cover the address that was dialled (stale leaf). */
    TLS_HOSTNAME,
    /** TLS failed for another reason (plain-HTTP server, handshake timeout, protocol error). */
    TLS_HANDSHAKE,
    /** TLS fine, but the server answered the WebSocket upgrade with a non-101 status. */
    WS_REJECTED,
    /** The connection was closed by the server or network after it was established. */
    WS_CLOSED,
    /** Transport (TCP + TLS + WebSocket) is up, but AirBridge never answered our hello. */
    NO_WELCOME,
    PAIR_CODE_INVALID,
    RATE_LIMITED,
    /** We closed the socket ourselves (reconnect / network change / stop). Not an error to show. */
    CANCELLED,
    UNKNOWN,
}

/** Connection phase a failure happened in. */
enum class ConnectPhase { TCP, TLS, UPGRADE, OPEN }

/** One dial attempt to one of the computer's candidate addresses. */
data class EndpointAttempt(
    val host: String,
    val port: Int,
    val kind: FailureKind,
    val detail: String,
    /** Local address the kernel routes this host from (192.0.0.2 = cellular CLAT). */
    val routeSource: String? = null,
)

/** Thrown by [WebSocketClient.connectBlocking]: carries the phase and every candidate attempt. */
class ConnectFailure(
    val phase: ConnectPhase,
    val kind: FailureKind,
    val host: String,
    val attempts: List<EndpointAttempt>,
    message: String,
    cause: Throwable? = null,
) : IOException(message, cause)

/** The one recovery step the UI should offer as a button. */
enum class RecoveryAction {
    /** Change networks (hotspot / same Wi-Fi), then rescan. Rescanning alone won't help. */
    FIX_NETWORK,
    /** Scan the computer's current QR code. */
    RESCAN,
    /** Start AirBridge on the computer, then retry. */
    RETRY,
    /** Wait out a server rate limit. */
    WAIT,
    /** The pinned identity changed: forget the computer, then scan. */
    FORGET_AND_RESCAN,
    /** Nothing to do; the engine is already retrying. */
    NONE,
}

data class ConnectionDiagnosis(
    val kind: FailureKind,
    /** Short recovery guidance for the UI. */
    val userMessage: String,
    /** Technical detail for logs / "details" expanders. */
    val detail: String,
    val attempts: List<EndpointAttempt> = emptyList(),
) {
    val action: RecoveryAction get() = ConnectionHelp.actionFor(kind)
    /** Failed before TLS: the address/route is the problem, not the code or certificate. */
    val isReachability: Boolean get() = kind in ConnectionHelp.REACHABILITY
}

/** Turn network failures into a classified, bounded recovery hint for the app UI. */
object ConnectionHelp {
    private val unreachable = Regex(
        "failed to connect|timed out|timeout|connection refused|network is unreachable|no route to host",
        RegexOption.IGNORE_CASE,
    )

    private fun chain(t: Throwable): Sequence<Throwable> = generateSequence(t) { it.cause?.takeIf { c -> c !== it } }.take(8)

    private fun messages(t: Throwable): String = chain(t).mapNotNull { it.message }.joinToString(" | ")

    /** Classify a raw socket/TLS exception thrown during [phase]. */
    fun classify(t: Throwable, phase: ConnectPhase, closedLocally: Boolean = false): FailureKind {
        if (closedLocally) return FailureKind.CANCELLED
        if (t is ConnectFailure) return t.kind
        val text = messages(t)
        val lower = text.lowercase()
        when (phase) {
            ConnectPhase.TCP -> return when {
                chain(t).any { it is UnknownHostException } -> FailureKind.DNS
                chain(t).any { it is SocketTimeoutException } || "timed out" in lower -> FailureKind.TCP_TIMEOUT
                chain(t).any { it is NoRouteToHostException } || "unreachable" in lower || "no route" in lower -> FailureKind.NO_ROUTE
                chain(t).any { it is ConnectException } || "refused" in lower -> FailureKind.TCP_REFUSED
                // Only a close *we* initiated is a cancellation (handled by
                // closedLocally above); anything else must stay visible.
                "socket closed" in lower -> FailureKind.UNKNOWN
                else -> FailureKind.UNKNOWN
            }
            ConnectPhase.TLS -> {
                val certificateProblem = chain(t).any { it is CertificateException } || chain(t).any { it is SSLPeerUnverifiedException }
                return when {
                    "does not match the qr" in lower || "tls identity changed" in lower -> FailureKind.TLS_PIN_MISMATCH
                    "subject alternative name" in lower || "no name matching" in lower ||
                        ("hostname" in lower && "verif" in lower) || chain(t).any { it is SSLPeerUnverifiedException } -> FailureKind.TLS_HOSTNAME
                    certificateProblem || "certpath" in lower || "trust anchor" in lower -> FailureKind.TLS_UNTRUSTED
                    t is SSLHandshakeException || t is SSLException || chain(t).any { it is SSLException } -> FailureKind.TLS_HANDSHAKE
                    t is EOFException || "closed" in lower || "reset" in lower -> FailureKind.TLS_HANDSHAKE
                    chain(t).any { it is SocketTimeoutException } -> FailureKind.TLS_HANDSHAKE
                    else -> FailureKind.TLS_HANDSHAKE
                }
            }
            ConnectPhase.UPGRADE -> return when {
                "upgrade rejected" in lower || "malformed websocket" in lower || "sec-websocket-accept" in lower -> FailureKind.WS_REJECTED
                else -> FailureKind.WS_CLOSED
            }
            ConnectPhase.OPEN -> return FailureKind.WS_CLOSED
        }
    }

    fun diagnose(t: Throwable, hostsTried: List<String> = emptyList(), locals: List<LocalAddress> = emptyList()): ConnectionDiagnosis {
        if (t is ConnectFailure) return fromFailure(t, locals)
        val kind = classify(t, ConnectPhase.TCP)
        return ConnectionDiagnosis(kind, guidance(kind, hostsTried, locals, emptyList()), (t.message ?: t.javaClass.simpleName).take(320))
    }

    fun fromFailure(f: ConnectFailure, locals: List<LocalAddress> = emptyList()): ConnectionDiagnosis {
        val detail = buildString {
            append(f.message ?: f.kind.name)
            for (a in f.attempts) {
                append("\n").append(a.host).append(':').append(a.port).append(" → ").append(a.kind.name)
                a.routeSource?.let { append(" (via ").append(it).append(')') }
                if (a.detail.isNotBlank()) append(": ").append(a.detail.take(160))
            }
        }.take(1200)
        return ConnectionDiagnosis(f.kind, guidance(f.kind, f.attempts.map { it.host }.ifEmpty { listOf(f.host) }, locals, f.attempts), detail, f.attempts)
    }

    /** Server `error` frames that concern pairing. Returns null for codes the UI need not surface. */
    fun forServerError(code: String, message: String): ConnectionDiagnosis? = when (code) {
        "INVALID_PAIR_CODE" -> ConnectionDiagnosis(
            FailureKind.PAIR_CODE_INVALID,
            "The computer rejected that pair code. Check the 6 characters on the computer's screen, or scan its QR code again.",
            message.take(320),
        )
        "RATE_LIMITED" -> ConnectionDiagnosis(
            FailureKind.RATE_LIMITED,
            "Too many pairing attempts. Wait a minute, then scan the computer's current QR code once.",
            message.take(320),
        )
        else -> null
    }

    val REACHABILITY = setOf(FailureKind.TCP_TIMEOUT, FailureKind.TCP_REFUSED, FailureKind.NO_ROUTE, FailureKind.DNS)

    fun actionFor(kind: FailureKind): RecoveryAction = when (kind) {
        FailureKind.TCP_TIMEOUT, FailureKind.NO_ROUTE -> RecoveryAction.FIX_NETWORK
        FailureKind.TCP_REFUSED, FailureKind.WS_REJECTED, FailureKind.NO_WELCOME -> RecoveryAction.RETRY
        FailureKind.DNS, FailureKind.TLS_UNTRUSTED, FailureKind.TLS_HOSTNAME, FailureKind.TLS_HANDSHAKE,
        FailureKind.PAIR_CODE_INVALID -> RecoveryAction.RESCAN
        FailureKind.TLS_PIN_MISMATCH -> RecoveryAction.FORGET_AND_RESCAN
        FailureKind.RATE_LIMITED -> RecoveryAction.WAIT
        FailureKind.WS_CLOSED, FailureKind.CANCELLED -> RecoveryAction.NONE
        FailureKind.UNKNOWN -> RecoveryAction.RETRY
    }

    /** Headline for the error card: names the layer that failed. */
    fun title(kind: FailureKind): String = when (kind) {
        FailureKind.TCP_TIMEOUT -> "Computer not reachable on this network"
        FailureKind.NO_ROUTE -> "No network path to the computer"
        FailureKind.TCP_REFUSED -> "AirBridge isn't running on the computer"
        FailureKind.DNS -> "Computer address not found"
        FailureKind.TLS_UNTRUSTED, FailureKind.TLS_HANDSHAKE -> "Secure connection failed"
        FailureKind.TLS_PIN_MISMATCH -> "Computer's security identity changed"
        FailureKind.TLS_HOSTNAME -> "Certificate doesn't cover this address"
        FailureKind.WS_REJECTED -> "Connection refused by AirBridge"
        FailureKind.WS_CLOSED -> "Connection closed"
        FailureKind.NO_WELCOME -> "Computer connected but didn't answer"
        FailureKind.PAIR_CODE_INVALID -> "Pair code rejected"
        FailureKind.RATE_LIMITED -> "Too many pairing attempts"
        FailureKind.CANCELLED -> "Reconnecting"
        FailureKind.UNKNOWN -> "Connection failed"
    }

    /** Label for the recovery button, or null when no button should be shown. */
    fun actionLabel(action: RecoveryAction): String? = when (action) {
        RecoveryAction.FIX_NETWORK -> "Rescan after joining the network"
        RecoveryAction.RESCAN -> "Scan QR code again"
        RecoveryAction.RETRY -> "Retry"
        RecoveryAction.WAIT -> null
        RecoveryAction.FORGET_AND_RESCAN -> "Forget computer and rescan"
        RecoveryAction.NONE -> null
    }

    private fun viaCellular(attempts: List<EndpointAttempt>): Boolean =
        attempts.isNotEmpty() && attempts.all { a -> a.routeSource != null && !LocalNetworks.isLanAddress(a.routeSource) }

    fun guidance(kind: FailureKind, hosts: List<String>, locals: List<LocalAddress>, attempts: List<EndpointAttempt>): String {
        val offLink = EndpointSelector.offLinkHint(hosts, locals)
        val hostList = hosts.distinct().joinToString().ifEmpty { "the computer" }
        return when (kind) {
            FailureKind.TCP_TIMEOUT -> buildString {
                append("Can't reach $hostList — the connection timed out before any security check, so the pair code is not the problem. ")
                val onLink = EndpointSelector.rank(hosts, locals).firstOrNull { it.onLink }
                if (onLink != null) {
                    // Same subnet as one of the phone's own networks, yet no
                    // answer: the computer is dropping the connection (or left).
                    append("${onLink.host} is on this phone's ${onLink.via!!.interfaceName} network but didn't answer. ")
                    append("Most likely the computer's firewall is blocking AirBridge: on a Mac open System Settings → Network → Firewall → Options and allow incoming connections for AirBridge (turn off \"Block all incoming connections\"). ")
                    append("Also check the computer is still connected to this network, then scan its current QR code.")
                    return@buildString
                }
                if (offLink != null) {
                    append(offLink).append(' ')
                    // Android picks a new hotspot subnet every time the hotspot
                    // is turned on, so an address from an earlier QR goes stale.
                    if (locals.any { it.isLan }) {
                        append("That address is probably out of date: Android gives the hotspot a new address range each time it is turned on, so the computer's address changes too. ")
                    }
                } else if (viaCellular(attempts)) append("This phone is sending that traffic over mobile data, so the address is not on its Wi-Fi or hotspot. ")
                append("Connect the computer to this phone's hotspot (or both to the same Wi-Fi), then scan the computer's current QR code. ")
                append("If they already share a network, allow AirBridge through the computer's firewall.")
            }
            FailureKind.NO_ROUTE -> "This phone has no network path to $hostList. Turn on Wi-Fi or the hotspot the computer is using, then scan its QR code again." +
                (offLink?.let { " $it" } ?: "")
            FailureKind.TCP_REFUSED -> "Reached $hostList, but AirBridge isn't accepting connections there. Make sure AirBridge is running on the computer (check the port in its QR), then retry."
            FailureKind.DNS -> "Couldn't resolve $hostList. Scan the computer's QR code, which uses its IP address."
            FailureKind.TLS_UNTRUSTED -> "Reached the computer, but its security certificate isn't valid. AirBridge did not connect. Scan the QR code shown by AirBridge on the computer."
            FailureKind.TLS_PIN_MISMATCH -> "The computer answered with a different security identity than the one paired/scanned. AirBridge did not connect. If you reinstalled AirBridge on the computer, Forget computer and scan its current QR code; otherwise check you are on the right network."
            FailureKind.TLS_HOSTNAME -> "The computer's certificate doesn't cover $hostList yet (its address changed). Keep AirBridge open on the computer for a few seconds, then scan its QR code again."
            FailureKind.TLS_HANDSHAKE -> "Reached $hostList, but the secure (TLS) handshake failed. Make sure the computer runs AirBridge with HTTPS on, then scan its QR code again."
            FailureKind.WS_REJECTED -> "The computer refused the AirBridge connection. Update AirBridge on both devices and scan the QR code again."
            FailureKind.WS_CLOSED -> "The connection to the computer was closed. AirBridge will keep retrying; if it persists, check the computer is awake and on the same network."
            FailureKind.NO_WELCOME -> "Reached $hostList securely, but AirBridge on the computer didn't answer within a few seconds. Quit and reopen AirBridge on the computer, then tap Reconnect now."
            FailureKind.PAIR_CODE_INVALID -> "The computer rejected that pair code. Scan its QR code again."
            FailureKind.RATE_LIMITED -> "Too many pairing attempts. Wait a minute and try again."
            FailureKind.CANCELLED -> "Reconnecting…"
            FailureKind.UNKNOWN -> "Connection failed. Check the address and try again."
        }
    }

    /** Legacy string-based hint (kept for callers that only have a message). */
    fun message(raw: String): String {
        val safe = raw.trim().take(320)
        return if (unreachable.containsMatchIn(safe)) {
            "Can't reach this computer. Put your phone and computer on the same Wi-Fi (or connect the computer to this phone's hotspot), keep AirBridge open on the computer, and scan its current QR code again if the network or address changed."
        } else {
            safe.ifEmpty { "Connection failed. Check the address and try again." }
        }
    }
}
