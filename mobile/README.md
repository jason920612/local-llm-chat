# Coderyo Chat — Android shell

A thin native Android app (Capacitor) that loads the Local LLM Chat web app
from your PC over the Cloudflare **mTLS** tunnel, adding the few things a plain
browser can't do well: presenting the client certificate, native microphone
access for voice, and (phase 2) receiving shared files.

The whole UI is still served by the Next.js backend on your PC — this project is
**only the native shell**, not a re-implementation. There is no offline mode by
design (the backend, RAG, sandbox, etc. all live on the PC).

## How it works

```
Android app (Capacitor WebView)
  └─ loads https://grok.coderyo.com   ← server.url in capacitor.config.json
       ├─ ClientCertWebViewClient  → answers Cloudflare's mTLS challenge
       ├─ MicWebChromeClient       → grants getUserMedia (voice/STT)
       └─ CertImportActivity       → first-launch .p12 import
```

- **Certificate**: imported on first launch, never bundled in the APK. The raw
  `.p12` is stored in app-private internal storage; its password lives in
  `EncryptedSharedPreferences` (AndroidKeyStore-backed). See `CertStore.java`.
- **Microphone**: `RECORD_AUDIO` is requested at runtime and the WebView audio
  permission is granted in `MicWebChromeClient`, so the existing browser voice
  pipeline (streaming STT / Whisper) works unchanged. The tunnel is HTTPS, so
  `getUserMedia` has a secure context.

## Build (in WSL2)

The build runs entirely in user space — no `sudo`, no Android Studio. It
provisions a JDK + Android SDK under `~/android-tools` on first run.

```powershell
wsl -d Ubuntu -- bash /mnt/c/Users/jason/Desktop/local-llm-chat/mobile/scripts/wsl-build.sh
```

First run downloads the JDK, Android SDK, Gradle and dependencies (~1–2 GB) and
takes a while; later runs are incremental. The result lands at:

```
mobile/dist/coderyo-chat-debug.apk
```

It is a debug-signed APK — fine for sideloading onto your own phone.

## Install on the phone

1. Copy `coderyo-chat-debug.apk` to the phone (USB, or `adb install`).
2. Enable "install unknown apps" for the file manager / browser if prompted.
3. Open the app → on first launch pick your `.p12` and enter its password.
4. The app reloads and the chat UI appears over the tunnel.

> The `.p12` is the same client certificate used by
> `scripts/open-grok-chrome-mtls.ps1` / the `mtls:p12` npm script in the parent
> project. Generate one with `npm run mtls:p12` if you don't have it yet.

## Configuration

The tunnel URL is fixed in `capacitor.config.json` (`server.url`). To change it,
edit that file and rebuild.

## Phase 2 — share-into-app (planned)

Receiving files shared from other apps needs a small bridge because the page is
remote: a native `SEND` intent handler reads the shared bytes and calls a
web-side receiver (e.g. `window.__coderyoReceiveSharedFile(...)`) that feeds the
existing upload path in the Next.js app. That web-side hook has to be added in
the parent project, so it is tracked separately from this shell.
