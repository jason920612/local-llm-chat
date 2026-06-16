package com.coderyo.chat;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Lets the remote page use the microphone for the voice / STT features.
 *
 * "Could not start audio source" happens when the WebView grants the page-level
 * audio permission but the app lacks the OS-level RECORD_AUDIO grant — Chromium
 * then fails to open the mic. So we only grant the page once the OS permission
 * is actually held, requesting it on demand (and deferring the grant until the
 * system dialog resolves) the first time the page asks.
 */
public class MicWebChromeClient extends BridgeWebChromeClient {
    private final MainActivity activity;
    private PermissionRequest pendingAudioRequest;

    public MicWebChromeClient(Bridge bridge, MainActivity activity) {
        super(bridge);
        this.activity = activity;
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        boolean wantsAudio = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                wantsAudio = true;
                break;
            }
        }
        if (!wantsAudio) {
            super.onPermissionRequest(request);
            return;
        }

        if (hasOsMicPermission()) {
            grant(request);
        } else {
            // Defer the page grant until the RECORD_AUDIO dialog resolves.
            pendingAudioRequest = request;
            activity.requestMicPermission();
        }
    }

    private boolean hasOsMicPermission() {
        return ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void grant(PermissionRequest request) {
        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
    }

    /** Called by MainActivity once the RECORD_AUDIO system dialog resolves. */
    void onOsMicPermissionResult(boolean granted) {
        if (pendingAudioRequest == null) {
            return;
        }
        PermissionRequest req = pendingAudioRequest;
        pendingAudioRequest = null;
        if (granted) {
            grant(req);
        } else {
            req.deny();
        }
    }
}
