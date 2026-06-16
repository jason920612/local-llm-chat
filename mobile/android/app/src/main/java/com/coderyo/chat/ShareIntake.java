package com.coderyo.chat;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Receives files shared into the app (ACTION_SEND / SEND_MULTIPLE) and hands
 * them to the remote web page, which exposes a small bridge:
 *
 *   window.__coderyoShareReady   – true once the chat UI has mounted
 *   window.__coderyoSharedQueue  – array of JSON payloads pushed by native
 *   window.__coderyoDrainShared()– processes the queue into the upload flow
 *
 * Because the page is remote we can't call a Capacitor plugin directly, so the
 * payload is base64'd and injected with evaluateJavascript once the page signals
 * it is ready.
 */
final class ShareIntake {
    private static final long MAX_BYTES = 25L * 1024 * 1024; // matches server upload cap

    private ShareIntake() {}

    static boolean isShare(Intent intent) {
        if (intent == null) return false;
        String a = intent.getAction();
        return Intent.ACTION_SEND.equals(a) || Intent.ACTION_SEND_MULTIPLE.equals(a);
    }

    static List<Uri> extractUris(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        if (intent == null) return uris;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) {
                for (Uri u : list) {
                    if (u != null) uris.add(u);
                }
            }
        }
        return uris;
    }

    /** Read + base64 the Uris off the UI thread, then inject on the UI thread. */
    static void deliver(final WebView webView, final ContentResolver resolver, final List<Uri> uris) {
        new Thread(() -> {
            try {
                JSONArray arr = new JSONArray();
                for (Uri uri : uris) {
                    byte[] bytes = read(resolver, uri);
                    if (bytes == null || bytes.length == 0) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", displayName(resolver, uri));
                    String mime = resolver.getType(uri);
                    o.put("mime", mime != null ? mime : "application/octet-stream");
                    o.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    arr.put(o);
                }
                if (arr.length() == 0) return;
                final String literal = JSONObject.quote(arr.toString());
                final String js =
                        "(window.__coderyoSharedQueue=window.__coderyoSharedQueue||[]).push("
                        + literal + ");"
                        + "if(window.__coderyoDrainShared)window.__coderyoDrainShared();";
                webView.post(() -> webView.evaluateJavascript(js, null));
            } catch (Exception ignored) {
                // a failed share shouldn't crash the app
            }
        }).start();
    }

    private static byte[] read(ContentResolver resolver, Uri uri) {
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) return null; // skip oversized files
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        String name = null;
        try (Cursor c = resolver.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        } catch (Exception ignored) {
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null) name = "shared";
        return name;
    }
}
