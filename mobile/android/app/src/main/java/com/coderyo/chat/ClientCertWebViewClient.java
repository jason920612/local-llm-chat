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

    // Android System WebView often fails getUserMedia audio with "Could not
    // start audio source" when echo cancellation / noise suppression can't
    // initialise (Chrome handles it, the WebView component frequently can't).
    // Patch getUserMedia to disable that processing, and surface the precise
    // error via alert() so we can diagnose without adb.
    private static final String AUDIO_FIX_JS =
            "(function(){"
            + "if(window.__gumPatched)return;window.__gumPatched=true;"
            + "var md=navigator.mediaDevices;if(!md||!md.getUserMedia)return;"
            + "var orig=md.getUserMedia.bind(md);"
            + "md.getUserMedia=function(c){try{if(c&&c.audio){"
            + "var a=(typeof c.audio==='object')?c.audio:{};"
            + "c=Object.assign({},c,{audio:Object.assign({},a,"
            + "{echoCancellation:false,noiseSuppression:false,autoGainControl:false})});"
            + "}}catch(e){}"
            + "return orig(c).catch(function(err){"
            + "try{alert('mic error: '+err.name+' / '+err.message);}catch(e){}"
            + "throw err;});};"
            + "})();";

    public ClientCertWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        if (url != null && url.contains("grok.coderyo.com")) {
            view.evaluateJavascript(AUDIO_FIX_JS, null);
        }
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
