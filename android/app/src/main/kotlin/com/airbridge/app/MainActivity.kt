package com.airbridge.app

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.webkit.*
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.net.URI

/**
 * The Android app is a thin shell around the web client.
 *
 * On launch it either opens the last-used AirBridge server directly, or — when
 * the device has never been paired — shows a QR scanner so the phone can read
 * the code from the Mac. The scanner can be dismissed to reach a simple
 * connect screen (type an address or scan again). Everything else is the same
 * React UI the browser gets, loaded from the server over HTTPS.
 */
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var connectView: View
    private lateinit var urlInput: EditText
    private lateinit var statusText: TextView
    private lateinit var discovery: ServerDiscovery
    private val main = Handler(Looper.getMainLooper())

    private var state = STATE_CONNECT
    private var currentOrigin: String = ""

    private inner class WebBridge {
        @JavascriptInterface
        fun onDownloadBlob(name: String, base64: String) {
            main.post {
                try {
                    val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
                    val safe = LocalAssetServer.safeName(name)
                    FileSaver.save(this@MainActivity, safe, "", bytes)
                    Toast.makeText(this@MainActivity, "Saved $safe", Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, "Could not save file", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        LocalAssetServer.start(this)

        root = FrameLayout(this).apply { setBackgroundColor(0xFFFFFFFF.toInt()) }
        webView = createWebView()
        root.addView(webView)
        connectView = createConnectView()
        root.addView(connectView)
        setContentView(root)

        discovery = ServerDiscovery(
            this,
            onFound = { url, name -> onDiscovered(url, name) },
            onLost = { },
        )

        val existing = prefs.serverUrl
        if (existing.isNotBlank()) {
            loadServer(existing)
        } else {
            // First launch on an unpaired device: go straight to the QR scanner.
            // Closing it (or declining the camera) reveals the connect screen.
            showConnect()
            launchScanner()
        }
    }

    override fun onStart() {
        super.onStart()
        discovery.start()
    }

    override fun onStop() {
        discovery.stop()
        super.onStop()
    }

    override fun onDestroy() {
        LocalAssetServer.stop()
        discovery.stop()
        super.onDestroy()
    }

    override fun onBackPressed() {
        when (state) {
            STATE_WEB -> if (webView.canGoBack()) webView.goBack() else showConnect()
            else -> super.onBackPressed()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_SCAN) return
        val text = data?.getStringExtra(QrScannerActivity.EXTRA_RESULT)
        if (resultCode == Activity.RESULT_OK && !text.isNullOrBlank()) {
            val origin = originOf(text)
            if (origin.isNotBlank()) {
                prefs.serverUrl = origin
                loadServer(origin, initialUrl = text.trim())
            } else {
                Toast.makeText(this, "That code isn't an AirBridge address", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ---------------------------------------------------------------------
    // WebView
    // ---------------------------------------------------------------------

    private fun createWebView(): WebView = WebView(this).apply {
        visibility = View.GONE
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mediaPlaybackRequiresUserGesture = false
        settings.setSupportMultipleWindows(true)
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        webViewClient = object : PermissiveWebViewClient() {
            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (request.isForMainFrame) {
                    main.post {
                        if (state == STATE_WEB) {
                            showConnect()
                            Toast.makeText(
                                this@MainActivity,
                                "Could not reach the AirBridge server",
                                Toast.LENGTH_LONG,
                            ).show()
                        }
                    }
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url.toString()
                return if (isExternal(url)) {
                    openExternal(url)
                    true
                } else {
                    false
                }
            }

        }
        setWebChromeClient(object : WebChromeClient() {})
        setDownloadListener { url, _, contentDisposition, mimetype, _ ->
            onDownload(url, contentDisposition, mimetype)
        }
        addJavascriptInterface(WebBridge(), "AirBridgeNative")
    }

    private fun loadServer(origin: String, initialUrl: String = origin) {
        state = STATE_WEB
        currentOrigin = originOf(origin)
        (webView.webViewClient as PermissiveWebViewClient).setOrigin(currentOrigin)
        connectView.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl(initialUrl)
    }

    private fun showConnect() {
        state = STATE_CONNECT
        webView.visibility = View.GONE
        connectView.visibility = View.VISIBLE
        urlInput.setText(prefs.serverUrl)
    }

    private fun onDiscovered(url: String, name: String) {
        main.post {
            if (state != STATE_CONNECT) return@post
            if (urlInput.text.toString().isBlank()) {
                urlInput.setText(url)
                statusText.text = "Found AirBridge at $name — press Connect"
            }
        }
    }

    private fun connectFromInput() {
        val raw = urlInput.text.toString().trim()
        val origin = originOf(raw)
        if (origin.isBlank()) {
            Toast.makeText(this, "Enter a valid server address", Toast.LENGTH_SHORT).show()
            return
        }
        prefs.serverUrl = origin
        loadServer(origin)
    }

    private fun launchScanner() {
        startActivityForResult(Intent(this, QrScannerActivity::class.java), REQ_SCAN)
    }

    // ---------------------------------------------------------------------
    // Downloads
    // ---------------------------------------------------------------------

    private fun onDownload(url: String, contentDisposition: String?, mimetype: String?) {
        val name = filenameFromDisposition(contentDisposition) ?: "airbridge-file"
        when {
            url.startsWith("blob:") || url.startsWith("data:") -> downloadBlob(url, name)
            url.startsWith("http") -> downloadHttp(url, name, mimetype ?: "")
        }
    }

    /** Received files arrive as blob URLs (the web client's in-memory fallback). */
    private fun downloadBlob(url: String, name: String) {
        val js =
            "(function(u,n){fetch(u).then(function(r){return r.blob();}).then(function(b){" +
                "var fr=new FileReader();fr.onload=function(){var d=fr.result;var b64=d.split(',')[1];" +
                "if(window.AirBridgeNative)window.AirBridgeNative.onDownloadBlob(n,b64);};" +
                "fr.onerror=function(){};fr.readAsDataURL(b);}).catch(function(){});})(" +
                JSONObject.quote(url) + "," + JSONObject.quote(name) + ")"
        webView.evaluateJavascript(js, null)
    }

    private fun downloadHttp(url: String, name: String, mimetype: String) {
        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val safe = LocalAssetServer.safeName(name)
        val request = DownloadManager.Request(Uri.parse(url)).apply {
            setAllowedNetworkTypes(
                DownloadManager.Request.NETWORK_WIFI or DownloadManager.Request.NETWORK_MOBILE,
            )
            setMimeType(mimetype.ifEmpty { "application/octet-stream" })
            addRequestHeader("User-Agent", "AirBridge")
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "AirBridge/$safe")
        }
        dm.enqueue(request)
        Toast.makeText(this, "Downloading $safe", Toast.LENGTH_SHORT).show()
    }

    private fun filenameFromDisposition(cd: String?): String? {
        if (cd.isNullOrBlank()) return null
        val marker = "filename="
        val idx = cd.indexOf(marker)
        if (idx < 0) return null
        var value = cd.substring(idx + marker.length).trim()
        if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
            value = value.substring(1, value.length - 1)
        }
        return value.ifBlank { null }
    }

    // ---------------------------------------------------------------------
    // Connect screen
    // ---------------------------------------------------------------------

    private fun createConnectView(): View {
        val pad = dp(28)
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, dp(60), pad, pad)
        }

        val brand = TextView(this).apply {
            text = "AirBridge"
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(0xFF111111.toInt())
            gravity = Gravity.CENTER
        }
        container.addView(brand)

        val subtitle = TextView(this).apply {
            text = "Connect to your Mac"
            textSize = 14f
            setTextColor(0xFF777777.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(34))
        }
        container.addView(subtitle)

        urlInput = EditText(this).apply {
            hint = "https://192.168.x.x:3000"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
            setPadding(dp(16), dp(15), dp(16), dp(15))
            background = GradientDrawable().apply {
                cornerRadius = dp(12).toFloat()
                setColor(0xFFF1F3F5.toInt())
            }
            setTextColor(0xFF111111.toInt())
            setHintTextColor(0xFF9AA0A6.toInt())
        }
        container.addView(urlInput)

        val connectBtn = Button(this).apply {
            text = "Connect"
            setOnClickListener { connectFromInput() }
        }
        container.addView(connectBtn)

        val scanBtn = Button(this).apply {
            text = "Scan QR code"
            setOnClickListener { launchScanner() }
        }
        scanBtn.setBackgroundColor(0xFFFFFFFF.toInt())
        scanBtn.setTextColor(0xFF1A73E8.toInt())
        container.addView(scanBtn)

        statusText = TextView(this).apply {
            textSize = 12f
            setTextColor(0xFF777777.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(28), 0, 0)
        }
        container.addView(statusText)

        return container
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private fun originOf(raw: String): String {
        return try {
            val u = URI(raw)
            if (u.scheme.isBlank() || u.host.isBlank()) ""
            else {
                val port = if (u.port > 0) ":${u.port}" else ""
                "${u.scheme.lowercase()}://${u.host.lowercase()}$port"
            }
        } catch (_: Exception) {
            ""
        }
    }

    private fun isExternal(url: String): Boolean {
        return try {
            val u = URI(url)
            val scheme = u.scheme.lowercase()
            when (scheme) {
                "blob", "data", "javascript", "about" -> false
                "http", "https" -> {
                    val host = u.host?.lowercase() ?: return false
                    val originHost =
                        currentOrigin.substringAfter("://").substringBefore("/").substringBefore(":")
                    host != originHost
                }
                else -> true
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun openExternal(url: String) {
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Exception) {
            Toast.makeText(this, "No app can open $url", Toast.LENGTH_SHORT).show()
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val STATE_CONNECT = 0
        private const val STATE_WEB = 1
        private const val REQ_SCAN = 31
    }
}
