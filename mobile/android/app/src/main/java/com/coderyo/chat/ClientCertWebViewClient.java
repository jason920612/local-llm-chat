package com.coderyo.chat;

import android.webkit.ClientCertRequest;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Extends Capacitor's WebViewClient so the WebView can answer Cloudflare's mTLS
 * client-certificate challenge with the cert the user imported on first launch.
 * Everything else (Capacitor's navigation handling) is inherited unchanged.
 */
public class ClientCertWebViewClient extends BridgeWebViewClient {
    private final Bridge bridge;

    public ClientCertWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) {
        try {
            CertStore.Material m = CertStore.load(bridge.getContext());
            if (m != null && m.privateKey != null && m.chain != null && m.chain.length > 0) {
                request.proceed(m.privateKey, m.chain);
                return;
            }
        } catch (Exception ignored) {
            // fall through to cancel
        }
        // No usable cert — cancel rather than hang the TLS handshake. The
        // gate in MainActivity sends the user to the import screen.
        request.cancel();
    }
}
