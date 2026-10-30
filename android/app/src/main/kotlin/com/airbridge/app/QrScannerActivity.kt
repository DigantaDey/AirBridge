package com.airbridge.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/**
 * First-run pairing scanner.
 *
 * Loads the jsQR scanner page served by [LocalAssetServer]. The page uses
 * getUserMedia to open the camera and decodes frames in JS; when it reads a
 * pair code it calls [QrScannerBridge.onScan], which returns the code to the
 * connect screen via [EXTRA_RESULT]. The page's "X" button calls
 * [QrScannerBridge.onCancel] to dismiss the scanner.
 */
class QrScannerActivity : Activity() {
    companion object {
        const val REQUEST_CODE = 42
        const val EXTRA_RESULT = "airbridge.scan.result"
    }

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setTheme(android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)

        val root = FrameLayout(this)
        webView = WebView(this)
        webView.setBackgroundColor(Color.BLACK)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url?.toString() ?: return false
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    return true
                }
                return false
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (checkSelfPermission(Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    request.deny()
                }
            }
        }
        webView.addJavascriptInterface(QrScannerBridge(), "AirBridgeNative")
        root.addView(webView)
        setContentView(root)

        webView.loadUrl(LocalAssetServer.url("/scanner/index.html"))
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private inner class QrScannerBridge {
        @android.webkit.JavascriptInterface
        fun onScan(text: String) {
            val intent = Intent()
            intent.putExtra(EXTRA_RESULT, text)
            setResult(RESULT_OK, intent)
            finish()
        }

        @android.webkit.JavascriptInterface
        fun onCancel() {
            finish()
        }
    }
}
