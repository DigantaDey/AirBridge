package com.airbridge.app;

import android.webkit.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * WebViewClient that trusts all SSL certificates and handles popup windows.
 *
 * SslError and onCreateWindow are @hide in the Android SDK, so Kotlin cannot
 * reference them by name — but Java can. Subclass this in Kotlin to add
 * shouldOverrideUrlLoading / onReceivedError overrides while inheriting
 * onReceivedSslError and onCreateWindow from Java.
 */
public class PermissiveWebViewClient extends WebViewClient {
    private String origin = "";
    private WebView popupWebView;

    public void setOrigin(String origin) {
        this.origin = origin;
    }

    public WebView getPopupWebView() {
        return popupWebView;
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.proceed();
    }

    @Override
    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        if (popupWebView == null) {
            popupWebView = new WebView(view.getContext());
        }
        popupWebView.getSettings().setJavaScriptEnabled(true);
        popupWebView.getSettings().setDomStorageEnabled(true);
        popupWebView.getSettings().setSupportMultipleWindows(true);
        popupWebView.setWebViewClient(new PopupWebViewClient(origin));
        transport.setWebView(popupWebView);
        return true;
    }

    private static class PopupWebViewClient extends PermissiveWebViewClient {
        private final String origin;

        PopupWebViewClient(String origin) {
            this.origin = origin;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (isExternal(url, origin)) {
                try {
                    android.content.Context context = view.getContext();
                    android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(intent);
                } catch (Exception e) {
                    // No app can open the URL
                }
                return true;
            }
            return false;
        }

        private static boolean isExternal(String url, String origin) {
            try {
                java.net.URI u = new java.net.URI(url);
                String scheme = u.getScheme() != null ? u.getScheme().toLowerCase() : "";
                if (scheme.equals("blob") || scheme.equals("data") || scheme.equals("javascript") || scheme.equals("about")) {
                    return false;
                }
                if (scheme.equals("http") || scheme.equals("https")) {
                    String host = u.getHost() != null ? u.getHost().toLowerCase() : "";
                    String originHost = origin.contains("://")
                        ? origin.substring(origin.indexOf("://") + 3).split("/")[0].split(":")[0]
                        : "";
                    return !host.equals(originHost);
                }
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
