package com.airbridge.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import com.airbridge.engine.PairingLink
import org.json.JSONObject
import java.lang.ref.WeakReference

/** A computer that announced itself over mDNS. */
data class NearbyHost(val name: String, val address: String)

/**
 * The Android app *is* the web app.
 *
 * The desktop server already ships this exact UI, so the phone renders the same
 * page in a WebView instead of re-implementing it: every screen, feature and
 * fix lands on both devices at once. [LoopbackRelay] puts that page on a
 * `http://127.0.0.1:<port>` origin, which is why the browser APIs the UI needs
 * (WebCrypto, storage) are available without trusting a certificate.
 *
 * On first run — an unpaired phone — a QR scanner opens on top of the connect
 * screen so the user can scan the code the desktop prints. Closing the scanner
 * leaves the connect screen usable: mDNS-discovered computers, or a typed
 * address.
 */
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private var relay: LoopbackRelay? = null
    private var discovery: ServerDiscovery? = null
    private var scanner: QrScannerView? = null
    private var pendingChooser: ValueCallback<Array<Uri>>? = null
    private var pendingScanAfterPermission = false
    @Volatile private var transferActive = false
    private var connectedLink: PairingLink? = null
    private var darkTheme = false
    private var backInvokedCallback: Any? = null
    private lateinit var bridge: ShellBridge

    /** Computers announced over mDNS, keyed by base address. */
    private val nearby = LinkedHashMap<String, NearbyHost>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        configureEdgeToEdge()
        buildContentView()
        registerSystemBackCallback()
        startDiscovery()
        if (prefs.connectionContinuity && prefs.pairingLink() != null) startConnectionService()

        val fromIntent = pairingLinkFromIntent(intent)
        if (fromIntent != null) {
            applyPairing(fromIntent)
        } else {
            val paired = prefs.pairingLink()
            if (paired == null) {
                showConnectScreen()
                openScanner()
            } else {
                openApp(paired)
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        pairingLinkFromIntent(intent)?.let { applyPairing(it) }
    }

    override fun onResume() {
        super.onResume()
        // The user may have just returned from Android's Accessibility settings.
        if (::webView.isInitialized) publishAccessibilityServiceState()
    }

    override fun onDestroy() {
        if (transferActive) setTransferActive(false)
        closeScanner()
        relay?.stop()
        relay = null
        discovery?.stop()
        discovery = null
        if (::webView.isInitialized) {
            attachWebView(null)
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        unregisterSystemBackCallback()
        super.onDestroy()
    }

    // Framework-only activity: no AndroidX back dispatcher is available.
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (!handleSystemBack()) {
            super.onBackPressed()
        }
    }

    /**
     * Android 13+ delivers Back through OnBackInvokedCallback when the app opts
     * in; older versions still use onBackPressed. Both routes share this logic:
     * scanner → file chooser → in-page sheets → WebView history → exit.
     */
    private fun registerSystemBackCallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val callback = OnBackInvokedCallback { handleSystemBack(); Unit }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                callback,
            )
            backInvokedCallback = callback
        }
    }

    private fun unregisterSystemBackCallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val callback = backInvokedCallback as? OnBackInvokedCallback ?: return
            onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback)
            backInvokedCallback = null
        }
    }

    /** Returns true when Back was consumed (or is being handled asynchronously). */
    private fun handleSystemBack(): Boolean {
        if (scanner != null) {
            closeScanner()
            return true
        }
        if (pendingChooser != null) {
            pendingChooser?.onReceiveValue(null)
            pendingChooser = null
            return true
        }
        if (!::webView.isInitialized) {
            finish()
            return true
        }
        webView.evaluateJavascript(
            "(function(){return typeof window.__airbridgeSystemBack === 'function' && window.__airbridgeSystemBack() === true ? 'true' : 'false'})()",
        ) { result ->
            val handled = result?.trim('"') == "true"
            runOnUiThread {
                if (handled) return@runOnUiThread
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        }
        return true
    }

    // ------------------------------------------------------------------ webview

    private fun buildContentView() {
        root = FrameLayout(this)
        webView = WebView(this).apply {
            setBackgroundColor(0xFFFFFFFF.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.useWideViewPort = true
            // An overflowing header used to make WebView zoom the whole page
            // out to fit its wider layout, shrinking/clipping every control.
            settings.loadWithOverviewMode = false
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            settings.allowFileAccess = false
            settings.allowContentAccess = true
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.mediaPlaybackRequiresUserGesture = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            webViewClient = ShellWebViewClient()
            webChromeClient = ShellChromeClient()
            bridge = ShellBridge(this@MainActivity)
            addJavascriptInterface(bridge, BRIDGE_NAME)
            setDownloadListener { url, _, contentDisposition, mimeType, _ ->
                // blob:/data: downloads are handled by the page through the bridge.
                if (url.startsWith("blob:") || url.startsWith("data:")) return@setDownloadListener
                val uri = Uri.parse(url)
                if (isShellPage(uri)) {
                    bridge.downloadFromRelay(url, downloadName(uri, contentDisposition), mimeType.orEmpty())
                } else {
                    openExternally(uri)
                }
            }
        }
        attachWebView(webView)
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)
        applySystemBarColors(darkTheme)
        applySystemBarAppearance(darkTheme)
        installSystemBarInsets(webView)
    }

    private inner class ShellWebViewClient : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            super.onPageFinished(view, url)
            // Top-level loads replace the shell rather than being user
            // navigation; keep Back from returning to a stale connect page.
            view.clearHistory()
            publishAccessibilityServiceState()
        }

        /** A crashed renderer leaves the WebView blank and unusable; rebuild it. */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "web renderer gone (crashed=${detail.didCrash()})")
            recreate()
            return true
        }

        /**
         * The paired computer is off or off the network: Chromium would show its
         * own error page, which leaves the user stuck in the shell. Fall back to
         * the connect screen (last address pre-filled) instead.
         */
        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (!request.isForMainFrame) return
            val host = connectedLink?.host ?: "your computer"
            Log.w(TAG, "main frame failed: ${error.description} ($host)")
            toast("Could not reach $host")
            root.post { showConnectScreen() }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (isShellPage(uri)) return false
            openExternally(uri)
            return true
        }
    }

    private inner class ShellChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView?,
            callback: ValueCallback<Array<Uri>>?,
            params: FileChooserParams?,
        ): Boolean {
            pendingChooser?.onReceiveValue(null)
            pendingChooser = callback
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = params?.acceptTypes?.firstOrNull { it.isNotBlank() && !it.startsWith(".") } ?: "*/*"
                putExtra(
                    Intent.EXTRA_ALLOW_MULTIPLE,
                    params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE,
                )
            }
            return try {
                startActivityForResult(intent, REQ_PICK)
                true
            } catch (_: ActivityNotFoundException) {
                pendingChooser = null
                false
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PICK) return
        val callback = pendingChooser ?: return
        pendingChooser = null
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null)
            return
        }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri)
        } ?: data.data?.let { uris.add(it) }
        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        val scanNow = pendingScanAfterPermission
        pendingScanAfterPermission = false
        if (granted && scanNow) {
            openScanner()
        } else if (!granted) {
            toast("Camera permission denied — type your computer's address instead")
        }
    }

    /** True for the relay origin and the bundled connect page — everything else
     *  (GitHub release links, the CA download, mailto:) belongs in a real app. */
    private fun isShellPage(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme == "about" || scheme == "data" || scheme == "blob") return true
        if (scheme != "http" && scheme != "https") return false
        val host = uri.host?.lowercase() ?: return false
        return host == "127.0.0.1" || host == "localhost" || host == CONNECT_HOST
    }

    /** Best-effort file name for a download link. */
    private fun downloadName(uri: Uri, contentDisposition: String?): String {
        val quoted = contentDisposition?.substringAfter("filename=", "")?.trim()?.trim('"')
        if (!quoted.isNullOrBlank() && quoted != contentDisposition) return quoted.substringAfterLast('/')
        return uri.lastPathSegment?.substringAfterLast('/')?.ifBlank { null } ?: "airbridge-file"
    }

    private fun openExternally(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            toast("No app can open that link")
        }
    }

    // -------------------------------------------------------------- navigation

    /** Shows the unpaired connect screen (also used after "forget computer"). */
    private fun showConnectScreen() {
        val html = try {
            assets.open(CONNECT_ASSET).bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            Log.w(TAG, "connect screen asset missing: ${e.message}")
            FALLBACK_HTML
        }
        webView.loadDataWithBaseURL(CONNECT_ORIGIN, html, "text/html", "utf-8", null)
    }

    /**
     * Points the WebView at the paired computer. The relay hop is what makes the
     * page a secure context; the pair code is replayed so the phone rejoins the
     * desktop's pairing group on the first load.
     */
    private fun openApp(link: PairingLink) {
        val port = startRelay(link)
        if (port == 0) {
            showConnectScreen()
            return
        }
        connectedLink = link
        // Only a code that was just scanned is replayed; afterwards the web app
        // remembers its own pairing in localStorage.
        val code = prefs.consumePendingPairCode()
        val url = "http://127.0.0.1:$port/" + if (code != null) "?pair=$code" else ""
        webView.loadUrl(url)
    }

    private fun startRelay(link: PairingLink): Int {
        relay?.stop()
        relay = null
        return try {
            val created = LoopbackRelay(link.host, link.port)
            val port = created.start(prefs.relayPort)
            prefs.relayPort = port
            relay = created
            port
        } catch (e: Exception) {
            Log.w(TAG, "relay start failed: ${e.message}")
            toast("Could not reach ${link.host}")
            0
        }
    }

    private fun applyPairing(link: PairingLink) {
        prefs.target = link.baseUrl
        prefs.pairCode = link.pairCode.orEmpty()
        prefs.pendingPairCode = link.pairCode.orEmpty()
        closeScanner()
        openApp(link)
        if (prefs.connectionContinuity) startConnectionService()
        toast("Connecting to ${link.host}")
    }

    /**
     * Android 15+ enforces edge-to-edge display and WebView children can get
     * all-zero insets. Listen on the decor view, which always sees the real
     * values, then pad the WebView and scanner chrome manually.
     */
    private fun installSystemBarInsets(view: View) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        window.decorView.setOnApplyWindowInsetsListener { _, insets ->
            val bars = insets.systemBarInsets()
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            scanner?.applyChromeInsets(bars)
            insets
        }
        view.post { window.decorView.requestApplyInsets() }
    }

    /** Opt into edge-to-edge on API 30-34; API 35+ already enforces it. */
    private fun configureEdgeToEdge() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            @Suppress("DEPRECATION")
            window.setDecorFitsSystemWindows(false)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }
        darkTheme = isSystemDarkTheme()
        applySystemBarColors(darkTheme)
    }

    private fun isSystemDarkTheme(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    /** Fill the system-bar areas with the web app's background colour. */
    private fun applySystemBarColors(dark: Boolean) {
        val color = if (dark) 0xFF111111.toInt() else 0xFFFFFFFF.toInt()
        // API 35+ ignores statusBarColor/navigationBarColor; the decor view
        // background is what shows behind the padded WebView content.
        window.decorView.setBackgroundColor(color)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
        } else {
            window.statusBarColor = color
            window.navigationBarColor = color
        }
    }

    /** Keep status/navigation-bar icons legible in light and dark themes. */
    private fun applySystemBarAppearance(dark: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            @Suppress("DEPRECATION")
            val lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
                View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            val decor = window.decorView
            val flags = decor.systemUiVisibility and lightFlags.inv()
            decor.systemUiVisibility = if (dark) flags else flags or lightFlags
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.decorView.windowInsetsController
            val appearance = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            controller?.setSystemBarsAppearance(
                if (dark) 0 else appearance,
                appearance,
            )
        }
    }

    /** Push the OS accessibility-service state to the settings UI. */
    private fun publishAccessibilityServiceState() {
        val enabled = try {
            ClipboardAccessibilityService.isEnabled(this)
        } catch (e: Exception) {
            Log.w(TAG, "could not read accessibility service state: ${e.message}")
            false
        }
        webView.evaluateJavascript(
            "window.__airbridgeNativeAccessibilityState && window.__airbridgeNativeAccessibilityState($enabled)",
            null,
        )
    }

    /** Match the system bars to the web app's light/dark theme. */
    fun setDarkTheme(enabled: Boolean): Boolean {
        runOnUiThread {
            darkTheme = enabled
            applySystemBarColors(enabled)
            applySystemBarAppearance(enabled)
        }
        return true
    }

    // ------------------------------------------------------------------ scanner

    fun hasCamera(): Boolean = packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    fun openScanner() {
        if (!hasCamera()) {
            toast("This device has no camera — type your computer's address instead")
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            pendingScanAfterPermission = true
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
            return
        }
        if (scanner != null) return
        val view = QrScannerView(this)
        view.onCode = { payload ->
            closeScanner()
            handleScanned(payload)
        }
        view.onClose = { closeScanner() }
        view.onCameraUnavailable = {
            if (scanner === view) {
                closeScanner()
                toast("The camera is unavailable on this device — type your computer's address")
            }
        }
        scanner = view
        root.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        window.decorView.requestApplyInsets()
        view.start()
    }

    private fun closeScanner() {
        val view = scanner ?: return
        scanner = null
        view.release()
        root.removeView(view)
    }

    private fun handleScanned(payload: String) {
        val trimmed = payload.trim()
        if (trimmed.contains("/api/beam/")) {
            toast("That is a one-off file link, not a pairing code")
            openScanner()
            return
        }
        val link = PairingLink.parse(trimmed)
        if (link == null) {
            toast("That QR code is not an AirBridge pairing code")
            openScanner()
            return
        }
        applyPairing(link)
    }

    private fun pairingLinkFromIntent(intent: Intent?): PairingLink? {
        if (intent?.action != Intent.ACTION_VIEW) return null
        val data = intent.data ?: return null
        return PairingLink.parse(data.toString())
    }

    // ------------------------------------------------------------ bridge support

    fun currentLink(): PairingLink? = connectedLink ?: prefs.pairingLink()

    fun preferredAddress(): String = prefs.target

    fun currentPairCode(): String = prefs.pairCode

    fun nearbyHosts(): List<NearbyHost> = synchronized(nearby) { nearby.values.toList() }

    fun setConnectionContinuity(enabled: Boolean): Boolean {
        prefs.connectionContinuity = enabled
        if (enabled) {
            if (prefs.pairingLink() == null) {
                prefs.connectionContinuity = false
                toast("Pair with a computer before enabling connection continuity")
                return false
            }
            startConnectionService()
        } else if (transferActive) {
            startConnectionService(ConnectionService.ACTION_TRANSFER_START)
        } else {
            stopService(Intent(this, ConnectionService::class.java).setAction(ConnectionService.ACTION_STOP))
        }
        return true
    }

    /** Mirrors the WebView's live Upload/Download rate into the foreground notification. */
    fun updateTransferSpeed(payloadJson: String): Boolean =
        ConnectionService.publishTransferSpeed(payloadJson)

    /** Starts a foreground service and CPU wake lock for the active WebView transfer. */
    fun setTransferActive(active: Boolean): Boolean {
        if (transferActive == active) return true
        transferActive = active
        if (active) {
            return startConnectionService(ConnectionService.ACTION_TRANSFER_START)
        }
        if (prefs.connectionContinuity) {
            return startConnectionService(ConnectionService.ACTION_TRANSFER_STOP)
        }
        stopService(Intent(this, ConnectionService::class.java).setAction(ConnectionService.ACTION_STOP))
        return true
    }

    private fun startConnectionService(action: String = ConnectionService.ACTION_START): Boolean {
        val intent = Intent(this, ConnectionService::class.java).setAction(action)
        return try {
            if (action == ConnectionService.ACTION_TRANSFER_STOP) {
                // The foreground service is already running; use a regular
                // start so Android does not treat this background stop/update
                // as a fresh foreground-service launch.
                startService(intent)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            true
        } catch (e: Exception) {
            if (action == ConnectionService.ACTION_START) prefs.connectionContinuity = false
            Log.w(TAG, "could not start connection/transfer service: ${e.message}")
            if (action == ConnectionService.ACTION_START) toast("Could not enable background connection")
            false
        }
    }

    /** Validates a typed/scanned address; returns an error message or null. */
    fun connectToAddress(address: String): String? {
        val link = PairingLink.parse(address)
            ?: return "Enter your computer's address, e.g. 192.168.1.5:3411"
        runOnUiThread { applyPairing(link) }
        return null
    }

    fun forgetComputer() {
        prefs.connectionContinuity = false
        transferActive = false
        stopService(Intent(this, ConnectionService::class.java).setAction(ConnectionService.ACTION_STOP))
        prefs.forget()
        relay?.stop()
        relay = null
        connectedLink = null
        webView.stopLoading()
        webView.clearHistory()
        showConnectScreen()
    }

    fun onFileSaved(name: String, location: String) {
        toast(if (location.isEmpty()) "Saved $name" else "Saved $name to $location")
    }

    // ----------------------------------------------------------------- discovery

    private fun startDiscovery() {
        val found = ServerDiscovery(
            this,
            onFound = { url, name ->
                val link = PairingLink.parse(url)
                if (link != null) {
                    // mDNS does not say whether the desktop serves TLS; the relay
                    // tries TLS first and falls back, so advertise the https form.
                    val address = link.copy(scheme = "https").baseUrl
                    synchronized(nearby) { nearby[address] = NearbyHost(name, address) }
                }
            },
            onLost = { name ->
                synchronized(nearby) { nearby.entries.removeAll { it.value.name == name } }
            },
        )
        discovery = found
        found.start()
    }

    private fun toast(message: String) {
        runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_SHORT).show() }
    }

    companion object {
        private const val TAG = "AirBridgeMain"
        private const val BRIDGE_NAME = "AirBridgeAndroid"
        private const val CONNECT_ASSET = "shell/connect.html"
        private const val CONNECT_HOST = "shell.airbridge.local"
        private const val CONNECT_ORIGIN = "https://$CONNECT_HOST/"
        private const val REQ_PICK = 41
        private const val REQ_CAMERA = 42

        @Volatile
        private var webViewRef: WeakReference<WebView>? = null

        fun attachWebView(view: WebView?) {
            webViewRef = view?.let { WeakReference(it) }
        }

        /** Push a system-clipboard change from the foreground service into the WebView. */
        fun publishLocalClipboard(text: String) {
            Handler(Looper.getMainLooper()).post {
                val view = webViewRef?.get() ?: return@post
                val safe = JSONObject.quote(text)
                view.evaluateJavascript(
                    "window.__airbridgeNativeClipboard && window.__airbridgeNativeClipboard($safe)",
                    null,
                )
            }
        }

        private val FALLBACK_HTML = """
            <!doctype html><html><body style="font:14px/1.5 sans-serif;padding:24px">
            <h1 style="font-size:22px">Connect to your computer</h1>
            <p>Start AirBridge on your computer, then reopen this app to scan its QR code.</p>
            </body></html>
        """.trimIndent()
    }
}
