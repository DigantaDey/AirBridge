package com.airbridge.app

import android.bluetooth.BluetoothStatusCodes
import com.airbridge.app.ui.components.ThumbnailLruCache
import com.airbridge.app.ui.viewmodels.DeepLinkConfirmationPolicy
import com.airbridge.engine.ConnectionState
import com.airbridge.engine.DiscoveryQueue
import com.airbridge.engine.EndpointAttempt
import com.airbridge.engine.EngineDiagnosticsSnapshot
import com.airbridge.engine.FailureKind
import com.airbridge.engine.JsonValue
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class AndroidHardeningTest {

    @Test
    fun androidDiagnosticsRedactsSecretsPathsMacsAndEmails() {
        val raw = """
            Connecting to https://192.168.1.42:3411?pair=ABC-DEF&token=sec_98765&ca=MIIC999&key=priv_123
            Wifi credentials psk=MySuperSecretWifiPass password:hunter2
            JSON payload {"pairCode":"K9M-2P4","psk":"wpa2secret","tlsPin":"sha256/AAAA","deviceName":"Pixel"}
            Auth header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret.sig
            Paths /Users/alice/Secrets/file.txt and /home/bob/.config/airbridge and C:\Users\charlie\Documents\key.pem
            BLE peer AA:BB:CC:11:22:33 user alice.smith@example.com
        """.trimIndent()

        val scrubbed = AndroidDiagnostics.redact(raw)

        assertFalse(scrubbed.contains("ABC-DEF"))
        assertFalse(scrubbed.contains("sec_98765"))
        assertFalse(scrubbed.contains("MIIC999"))
        assertFalse(scrubbed.contains("priv_123"))
        assertFalse(scrubbed.contains("MySuperSecretWifiPass"))
        assertFalse(scrubbed.contains("hunter2"))
        assertFalse(scrubbed.contains("K9M-2P4"))
        assertFalse(scrubbed.contains("wpa2secret"))
        assertFalse(scrubbed.contains("eyJhbGciOiJIUzI1NiJ9"))
        assertFalse(scrubbed.contains("/Users/alice"))
        assertFalse(scrubbed.contains("/home/bob"))
        assertFalse(scrubbed.contains("C:\\Users\\charlie"))
        assertFalse(scrubbed.contains("AA:BB:CC:11:22:33"))
        assertFalse(scrubbed.contains("alice.smith@example.com"))

        assertTrue(scrubbed.contains("pair=[REDACTED]"))
        assertTrue(scrubbed.contains("token=[REDACTED]"))
        assertTrue(scrubbed.contains("ca=[REDACTED]"))
        assertTrue(scrubbed.contains("key=[REDACTED]"))
        assertTrue(scrubbed.contains("psk=[REDACTED]"))
        assertTrue(scrubbed.contains("password:[REDACTED]"))
        assertTrue(scrubbed.contains("\"pairCode\":\"[REDACTED]\""))
        assertTrue(scrubbed.contains("\"psk\":\"[REDACTED]\""))
        assertTrue(scrubbed.contains("/Users/[REDACTED]/Secrets/file.txt"))
        assertTrue(scrubbed.contains("/home/[REDACTED]/.config/airbridge"))
        assertTrue(scrubbed.contains("[REDACTED_MAC]"))
        assertTrue(scrubbed.contains("[REDACTED_EMAIL]"))
        // Safe non-secret fields remain intact
        assertTrue(scrubbed.contains("192.168.1.42:3411"))
        assertTrue(scrubbed.contains("\"deviceName\":\"Pixel\""))
    }

    @Test
    fun androidDiagnosticsBoundedLogRingCrashBreadcrumbAndReportStructure() {
        AndroidDiagnostics.clearLogs()
        for (i in 1..450) {
            AndroidDiagnostics.recordEvent(
                category = "test",
                message = "Event #$i pair=SECRET-$i from /Users/tester/app",
                level = if (i % 10 == 0) "WARN" else "INFO",
                timestampMs = 1_700_000_000_000L + i,
            )
        }
        val logs = AndroidDiagnostics.logsSnapshot()
        assertEquals(AndroidDiagnostics.MAX_LOG_ENTRIES, logs.size)
        // First 50 events evicted, entry 51 is oldest
        assertTrue(logs.first().message.contains("Event #51"))
        assertTrue(logs.last().message.contains("Event #450"))
        assertFalse(logs.any { it.message.contains("SECRET-") })
        assertFalse(logs.any { it.message.contains("/Users/tester") })

        val tempNoBackup = Files.createTempDirectory("airbridge-diag-test").toFile()
        try {
            val crashEx = IllegalStateException("Fatal failure connecting with pair=ZXC-VBN at /Users/alice/crash")
            AndroidDiagnostics.writeCrashBreadcrumb(
                noBackupDir = tempNoBackup,
                threadName = "airbridge-worker",
                throwable = crashEx,
                timestampMs = 1_700_000_123_456L,
            )

            val engineSnap = EngineDiagnosticsSnapshot(
                connectionState = ConnectionState.CONNECTED,
                tlsMode = "pinned",
                tlsAnchored = true,
                verifiedIpSanHost = "192.168.1.14",
                anchorPinPrefix = "a1b2c3d4e5f6",
                connectedHost = "192.168.1.14",
                connectedViaReverse = false,
                connectedViaRelay = false,
                admission = "pake",
                reversePort = 47390,
                wsConnectAttempts = 3L,
                wsLastDnsMs = 4L,
                wsWriteStallCount = 0L,
                wsActiveDialThreads = 0,
                lastAttempts = listOf(
                    EndpointAttempt(
                        host = "192.168.1.14",
                        port = 3411,
                        kind = FailureKind.TCP_TIMEOUT,
                        routeSource = "192.168.1.25",
                        detail = "retry succeeded on eth0",
                    ),
                ),
                activeTransferCount = 1,
                peerCount = 1,
            )

            val reportJson = AndroidDiagnostics.collectReportJson(
                context = null,
                extraState = null,
                engineSnapshotOverride = engineSnap,
                noBackupDirOverride = tempNoBackup,
            )

            // Verify all required top-level diagnostic sections
            assertNotNull(reportJson.optObj("app"))
            assertNotNull(reportJson.optObj("device"))
            val perms = reportJson.optObj("permissions")
            assertNotNull(perms)
            assertNotNull(perms!!.optBool("localNetwork"))
            assertNotNull(perms.optBool("camera"))
            assertNotNull(perms.optBool("recordAudio"))
            assertNotNull(reportJson.optBool("batteryExempt"))
            assertNotNull(reportJson.optObj("fgs"))
            assertNotNull(reportJson.optObj("power"))
            val conn = reportJson.optObj("connectivity")
            assertNotNull(conn)
            assertEquals("CONNECTED", conn!!.optStr("connectionState"))
            assertEquals("pinned", conn.optStr("tlsMode"))
            assertEquals(true, conn.optBool("tlsPinPresent"))
            assertEquals("a1b2c3d4e5f6", conn.optStr("tlsAnchorPrefix"))
            assertEquals("192.168.1.14", conn.optStr("verifiedIpSanHost"))
            assertNotNull(reportJson.optObj("nsd"))
            assertNotNull(reportJson.optObj("handoff"))
            assertNotNull(reportJson.optObj("ble"))
            assertNotNull(reportJson.optObj("screenShare"))
            assertNotNull(reportJson.optObj("qr"))
            assertNotNull(reportJson.optObj("storage"))

            val crash = reportJson.optObj("crashBreadcrumb")
            assertNotNull(crash)
            assertEquals("java.lang.IllegalStateException", crash!!.optStr("exceptionClass"))
            assertFalse(crash.optStr("message").orEmpty().contains("ZXC-VBN"))
            assertTrue(crash.optStr("message").orEmpty().contains("pair=[REDACTED]"))

            val shareable = AndroidDiagnostics.formatShareableReport(
                context = null,
                extraState = null,
                engineSnapshotOverride = engineSnap,
                noBackupDirOverride = tempNoBackup,
            )
            assertTrue(shareable.contains("=== AirBridge Android Diagnostic Report ==="))
            assertFalse(shareable.contains("ZXC-VBN"))
            assertFalse(shareable.contains("SECRET-"))
            // Confirm embedded JSON parses cleanly
            val jsonStart = shareable.indexOf('{')
            assertTrue(jsonStart > 0)
            val parsedBack = JsonValue.parseObject(shareable.substring(jsonStart))
            assertEquals("CONNECTED", parsedBack.optObj("connectivity")?.optStr("connectionState"))
        } finally {
            tempNoBackup.deleteRecursively()
            AndroidDiagnostics.clearLogs()
        }
    }

    @Test
    fun deepLinkConfirmationPolicyRequiresConfirmationWhenAlreadyPaired() {
        // 1. Unpaired device connects immediately on valid airbridge:// link
        val (unpairedDecision, unpairedLink) = DeepLinkConfirmationPolicy.evaluate(
            scheme = "airbridge",
            rawUri = "airbridge://192.168.1.50:3411?pair=ABC-DEF",
            existingTarget = "",
        )
        assertEquals(DeepLinkConfirmationPolicy.Decision.CONNECT_IMMEDIATELY, unpairedDecision)
        assertNotNull(unpairedLink)
        assertEquals("192.168.1.50", unpairedLink!!.host)
        assertEquals(3411, unpairedLink.port)

        // 2. Paired device MUST require explicit user confirmation before overwriting target/TLS pin
        val (pairedDecision, pairedLink) = DeepLinkConfirmationPolicy.evaluate(
            scheme = "airbridge",
            rawUri = "airbridge://10.0.0.99:3411?pair=HIJ-KLM",
            existingTarget = "https://192.168.1.14:3411",
        )
        assertEquals(DeepLinkConfirmationPolicy.Decision.REQUIRE_CONFIRMATION, pairedDecision)
        assertNotNull(pairedLink)
        assertEquals("10.0.0.99", pairedLink!!.host)

        // 3. Non-airbridge scheme or malformed URI is rejected
        val (httpDecision, _) = DeepLinkConfirmationPolicy.evaluate(
            scheme = "https",
            rawUri = "https://192.168.1.50:3411?pair=ABC-DEF",
            existingTarget = "",
        )
        assertEquals(DeepLinkConfirmationPolicy.Decision.REJECT, httpDecision)
    }

    @Test
    fun shareContactUriValidationBlocksFileSchemeAndOwnProviders() {
        val pkg = "com.airbridge.app"

        // Block file:// URIs
        assertFalse(ShareContactActivity.isAllowedShareUri("file", "", pkg))
        assertFalse(ShareContactActivity.isAllowedShareUri("file", "localhost", pkg))

        // Block own ContentProvider authorities (including userinfo@ bypass attempts)
        assertFalse(ShareContactActivity.isAllowedShareUri("content", "com.airbridge.app.clipboard", pkg))
        assertFalse(ShareContactActivity.isAllowedShareUri("content", "com.airbridge.app", pkg))
        assertFalse(ShareContactActivity.isAllowedShareUri("content", "COM.AIRBRIDGE.APP.CLIPBOARD", pkg))
        assertFalse(ShareContactActivity.isAllowedShareUri("content", "evil@com.airbridge.app.clipboard", pkg))

        // Block missing scheme or authority
        assertFalse(ShareContactActivity.isAllowedShareUri(null, "com.android.contacts", pkg))
        assertFalse(ShareContactActivity.isAllowedShareUri("content", null, pkg))
        assertFalse(ShareContactActivity.isAllowedShareUri("content", "", pkg))

        // Allow external contacts provider content:// URIs
        assertTrue(ShareContactActivity.isAllowedShareUri("content", "com.android.contacts", pkg))
        assertTrue(ShareContactActivity.isAllowedShareUri("content", "com.google.android.contacts.files", pkg))
    }

    @Test
    fun wakeAndWifiLocksAreGatedStrictlyOnActiveTransfers() {
        var nowMs = 1_000L
        val policy = TransferLockPolicy(clockMs = { nowMs })

        // Idle with connectionContinuity = true MUST NOT hold WakeLock or WifiLock
        assertFalse(policy.shouldHoldLocks(transferActive = false, connectionContinuity = true))
        assertFalse(policy.shouldHoldLocks(transferActive = false, connectionContinuity = false))
        assertTrue(policy.shouldHoldLocks(transferActive = true, connectionContinuity = false))
        assertTrue(policy.shouldHoldLocks(transferActive = true, connectionContinuity = true))

        // Track cumulative durations across active transfer bursts
        policy.onWakeLockAcquired()
        policy.onWifiLockAcquired()
        assertTrue(policy.isWakeHeld)
        assertTrue(policy.isWifiHeld)

        nowMs += 2_500L
        assertEquals(2_500L, policy.totalWakeLockHeldMs())
        assertEquals(2_500L, policy.totalWifiLockHeldMs())

        policy.onLocksReleased()
        assertFalse(policy.isWakeHeld)
        assertFalse(policy.isWifiHeld)

        // Idle period does not increase held duration
        nowMs += 10_000L
        assertEquals(2_500L, policy.totalWakeLockHeldMs())
        assertEquals(2_500L, policy.totalWifiLockHeldMs())

        // Second transfer burst adds to cumulative total
        policy.onWakeLockAcquired()
        nowMs += 1_500L
        policy.onLocksReleased()
        assertEquals(4_000L, policy.totalWakeLockHeldMs())
        assertEquals(2_500L, policy.totalWifiLockHeldMs())
    }

    @Test
    fun discoveryQueueIsThreadSafeUnderConcurrentOperations() {
        val queue = DiscoveryQueue<String>()
        queue.start()
        val pool = Executors.newFixedThreadPool(8)
        val startLatch = CountDownLatch(1)
        val doneLatch = CountDownLatch(8)
        val failed = AtomicBoolean(false)

        for (t in 0 until 8) {
            pool.execute {
                try {
                    startLatch.await()
                    for (i in 0 until 200) {
                        val name = "Mac-${(t + i) % 12}"
                        queue.enqueue(name, "192.168.1.${(i % 250) + 1}")
                        val next = queue.nextToResolve()
                        if (next != null) {
                            val (gen, resolvedName, _) = next
                            assertNotNull(resolvedName)
                            queue.finish(gen)
                        }
                        if (i % 15 == 0) {
                            queue.removePending("Mac-${i % 12}")
                        }
                        if (i == 100 && t == 0) {
                            queue.reset()
                            queue.start()
                        }
                    }
                } catch (_: Throwable) {
                    failed.set(true)
                } finally {
                    doneLatch.countDown()
                }
            }
        }

        startLatch.countDown()
        assertTrue(doneLatch.await(10, TimeUnit.SECONDS))
        pool.shutdownNow()
        assertFalse("Concurrent DiscoveryQueue operations threw an exception", failed.get())

        // Drain remaining items and verify state consistency
        while (true) {
            val next = queue.nextToResolve() ?: break
            assertTrue(queue.finish(next.first))
        }
        assertEquals(0, queue.pendingCount())
        assertNull(queue.inFlightName)
    }

    @Test
    fun bleStatusCodesQrLuminanceStrideThumbnailLruAndClipboardProviderValidation() {
        // AND-02: API 33+ writeCharacteristic status code check uses BluetoothStatusCodes.SUCCESS
        assertTrue(HotspotHandoff.isApi33GattWriteSuccess(BluetoothStatusCodes.SUCCESS))
        assertFalse(HotspotHandoff.isApi33GattWriteSuccess(BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY))
        assertFalse(HotspotHandoff.isApi33GattWriteSuccess(BluetoothStatusCodes.ERROR_UNKNOWN))

        // AND-18: QR Y-plane de-interleaving when pixelStride == 2
        val width = 4
        val height = 2
        val pixelStride = 2
        val rowStride = 8
        val interleaved = byteArrayOf(
            10, 99, 20, 99, 30, 99, 40, 99,
            50, 99, 60, 99, 70, 99, 80, 99,
        )
        val extracted = QrScannerView.extractLuminancePlane(
            src = interleaved,
            srcValidBytes = interleaved.size,
            width = width,
            height = height,
            rowStride = rowStride,
            pixelStride = pixelStride,
        )
        assertArrayEquals(byteArrayOf(10, 20, 30, 40, 50, 60, 70, 80), extracted)
        assertEquals(90, QrScannerView.computeAlignedRotationDegrees(90, 0))
        assertEquals(0, QrScannerView.computeAlignedRotationDegrees(90, 90))
        assertEquals(270, QrScannerView.computeAlignedRotationDegrees(90, 180))

        // AND-18: ThumbnailLruCache bounded LRU eviction
        val cache = ThumbnailLruCache<String, String>(maxEntries = 3)
        cache.put("a", "imgA")
        cache.put("b", "imgB")
        cache.put("c", "imgC")
        // Touch "a" so "b" becomes least-recently-used
        assertEquals("imgA", cache.get("a"))
        cache.put("d", "imgD")
        assertEquals(3, cache.size())
        assertNull(cache.get("b"))
        assertEquals("imgA", cache.get("a"))
        assertEquals("imgC", cache.get("c"))
        assertEquals("imgD", cache.get("d"))

        // AND-20: ClipboardImageProvider throws FileNotFoundException for missing or traversal filenames
        val tempCache = Files.createTempDirectory("airbridge-clip-test").toFile()
        try {
            val validUuidName = "123e4567-e89b-12d3-a456-426614174000.png"
            var missingThrew = false
            try {
                ClipboardImageProvider.resolveExistingFile(tempCache, validUuidName)
            } catch (_: FileNotFoundException) {
                missingThrew = true
            }
            assertTrue("Expected FileNotFoundException when cached file is absent", missingThrew)

            var traversalThrew = false
            try {
                ClipboardImageProvider.resolveExistingFile(tempCache, "../airbridge.xml")
            } catch (_: FileNotFoundException) {
                traversalThrew = true
            }
            assertTrue("Expected FileNotFoundException for non-UUID path", traversalThrew)

            val clipDir = File(tempCache, "clipboard-images").apply { mkdirs() }
            val existing = File(clipDir, validUuidName).apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }
            val resolved = ClipboardImageProvider.resolveExistingFile(tempCache, validUuidName)
            assertEquals(existing.canonicalPath, resolved.canonicalPath)
        } finally {
            tempCache.deleteRecursively()
        }
    }
}
