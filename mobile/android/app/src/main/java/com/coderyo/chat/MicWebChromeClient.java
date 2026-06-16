package com.coderyo.chat;

import android.webkit.PermissionRequest;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Grants the remote page WebView access to the microphone so the existing
 * browser-based voice features (getUserMedia → streaming STT / Whisper) work
 * inside the app. The OS-level RECORD_AUDIO permission is requested separately
 * in {@link MainActivity}.
 */
public class MicWebChromeClient extends BridgeWebChromeClient {
    public MicWebChromeClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                return;
            }
        }
        super.onPermissionRequest(request);
    }
}
