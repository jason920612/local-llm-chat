package com.coderyo.chat;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;

/**
 * Stores the user's mTLS client certificate (a PKCS#12 / .p12) so the WebView
 * can present it to Cloudflare during the TLS handshake.
 *
 * The raw .p12 lives in app-private internal storage ({@code filesDir}); the
 * password that unlocks it is kept in {@link EncryptedSharedPreferences}, which
 * is encrypted at rest with an AndroidKeyStore master key. Nothing is bundled in
 * the APK — the cert is imported on first launch.
 */
public final class CertStore {
    private static final String P12_FILE = "client.p12";
    private static final String PREFS = "coderyo_cert_prefs";
    private static final String KEY_PASSWORD = "p12_password";
    private static final String KEY_HAS_CERT = "has_cert";

    private CertStore() {}

    private static SharedPreferences prefs(Context ctx) throws Exception {
        MasterKey masterKey = new MasterKey.Builder(ctx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
        return EncryptedSharedPreferences.create(
                ctx,
                PREFS,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    /** True only when a validated .p12 plus its password are both stored. */
    public static boolean hasCert(Context ctx) {
        File f = new File(ctx.getFilesDir(), P12_FILE);
        if (!f.exists()) return false;
        try {
            return prefs(ctx).getBoolean(KEY_HAS_CERT, false);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Validate a PKCS#12 with the given password and persist it. Throws if the
     * password is wrong or the file carries no private key entry.
     */
    public static void importP12(Context ctx, byte[] p12Bytes, String password) throws Exception {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(new ByteArrayInputStream(p12Bytes), password.toCharArray());
        if (findKeyAlias(ks) == null) {
            throw new IllegalArgumentException("這個 .p12 沒有私鑰 (client key)");
        }

        File f = new File(ctx.getFilesDir(), P12_FILE);
        try (FileOutputStream fos = new FileOutputStream(f)) {
            fos.write(p12Bytes);
        }
        prefs(ctx).edit()
                .putString(KEY_PASSWORD, password)
                .putBoolean(KEY_HAS_CERT, true)
                .apply();
    }

    /** Forget the stored certificate (used if it stops working). */
    public static void clear(Context ctx) {
        //noinspection ResultOfMethodCallIgnored
        new File(ctx.getFilesDir(), P12_FILE).delete();
        try {
            prefs(ctx).edit().clear().apply();
        } catch (Exception ignored) {
        }
    }

    /** Private key + chain, ready to hand to {@code ClientCertRequest.proceed}. */
    public static final class Material {
        public final PrivateKey privateKey;
        public final X509Certificate[] chain;

        Material(PrivateKey key, X509Certificate[] chain) {
            this.privateKey = key;
            this.chain = chain;
        }
    }

    /** Load the stored cert material, or null if nothing usable is stored. */
    public static Material load(Context ctx) throws Exception {
        File f = new File(ctx.getFilesDir(), P12_FILE);
        if (!f.exists()) return null;
        String password = prefs(ctx).getString(KEY_PASSWORD, null);
        if (password == null) return null;

        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(new ByteArrayInputStream(readFile(f)), password.toCharArray());
        String alias = findKeyAlias(ks);
        if (alias == null) return null;

        PrivateKey key = (PrivateKey) ks.getKey(alias, password.toCharArray());
        Certificate[] raw = ks.getCertificateChain(alias);
        List<X509Certificate> chain = new ArrayList<>();
        if (raw != null) {
            for (Certificate c : raw) {
                if (c instanceof X509Certificate) chain.add((X509Certificate) c);
            }
        }
        return new Material(key, chain.toArray(new X509Certificate[0]));
    }

    private static String findKeyAlias(KeyStore ks) throws Exception {
        Enumeration<String> aliases = ks.aliases();
        while (aliases.hasMoreElements()) {
            String a = aliases.nextElement();
            if (ks.isKeyEntry(a)) return a;
        }
        return null;
    }

    private static byte[] readFile(File f) throws Exception {
        byte[] data = new byte[(int) f.length()];
        try (FileInputStream fis = new FileInputStream(f)) {
            int off = 0, n;
            while (off < data.length && (n = fis.read(data, off, data.length - off)) > 0) {
                off += n;
            }
        }
        return data;
    }
}
