package com.coderyo.chat;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    private static final int REQ_RECORD_AUDIO = 1001;
    private static final int SHARE_POLL_MAX = 40;     // ~20s
    private static final long SHARE_POLL_MS = 500;

    private ActivityResultLauncher<Intent> certImportLauncher;
    private MicWebChromeClient micClient;
    private final List<Uri> pendingShare = new ArrayList<>();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Result launchers must be registered before the activity is STARTED,
        // i.e. before super.onCreate().
        certImportLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == Activity.RESULT_OK) {
                        // Cert is now stored — drop the cached "no cert" decision
                        // from the initial load, then reload so our client can
                        // actually present it.
                        reloadWithCert();
                    } else {
                        // User dismissed the import without a cert: nothing will
                        // load past Cloudflare's mTLS gate, so close the app.
                        finish();
                    }
                });

        super.onCreate(savedInstanceState);

        // Present the client cert for mTLS, and let the page use the mic.
        getBridge().setWebViewClient(new ClientCertWebViewClient(getBridge()));
        micClient = new MicWebChromeClient(getBridge(), this);
        getBridge().getWebView().setWebChromeClient(micClient);

        // Let the realtime voice agent's audio play without a user gesture.
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);

        if (CertStore.hasCert(this)) {
            // BridgeActivity already kicked off the initial load using the
            // default WebViewClient, whose onReceivedClientCertRequest cancels
            // and *caches* a "no cert" decision for this host. Clear it and
            // reload so our ClientCertWebViewClient can present the cert.
            reloadWithCert();
        } else {
            // First launch: collect the .p12, then reloadWithCert() runs from
            // the import result.
            certImportLauncher.launch(new Intent(this, CertImportActivity.class));
        }

        // If launched via "share to Coderyo Chat", queue the files.
        handleShareIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask: a share while the app is already running arrives here.
        setIntent(intent);
        handleShareIntent(intent);
    }

    private void handleShareIntent(Intent intent) {
        if (!ShareIntake.isShare(intent)) {
            return;
        }
        pendingShare.addAll(ShareIntake.extractUris(intent));
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            pollAndFlushShare(webView, 0);
        }
    }

    /**
     * Wait until the remote chat UI has mounted (it sets __coderyoShareReady),
     * then hand the queued files to its upload flow. Polling decouples us from
     * page-load/error events and the cert reload dance.
     */
    private void pollAndFlushShare(final WebView webView, final int attempt) {
        if (pendingShare.isEmpty() || attempt > SHARE_POLL_MAX) {
            return;
        }
        webView.evaluateJavascript(
                "(window.__coderyoShareReady===true)?'1':'0'",
                value -> {
                    if ("\"1\"".equals(value) || "1".equals(value)) {
                        List<Uri> batch = new ArrayList<>(pendingShare);
                        pendingShare.clear();
                        ShareIntake.deliver(webView, getContentResolver(), batch);
                    } else {
                        webView.postDelayed(
                                () -> pollAndFlushShare(webView, attempt + 1), SHARE_POLL_MS);
                    }
                });
    }

    /**
     * Clear WebView's persisted client-cert preferences (so it asks our client
     * again instead of replaying a cached cancel), then reload the page.
     */
    private void reloadWithCert() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        final WebView webView = getBridge().getWebView();
        WebView.clearClientCertPreferences(webView::reload);
    }

    /**
     * Ask for RECORD_AUDIO on demand (called the first time the page tries to
     * use the mic). The result is routed back to {@link MicWebChromeClient}.
     */
    void requestMicPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED) {
            if (micClient != null) micClient.onOsMicPermissionResult(true);
            return;
        }
        ActivityCompat.requestPermissions(
                this, new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_RECORD_AUDIO && micClient != null) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            micClient.onOsMicPermissionResult(granted);
        }
    }
}
