#!/usr/bin/env bash
# Build the Coderyo Chat Android APK inside WSL2, fully in user space (no sudo).
#
# It provisions a JDK + Android SDK under ~/android-tools on first run, copies
# the mobile/ project off the slow /mnt/c mount into the WSL native filesystem,
# then runs the Gradle build. Re-running skips anything already downloaded.
#
#   wsl -d Ubuntu -- bash /mnt/c/Users/jason/Desktop/local-llm-chat/mobile/scripts/wsl-build.sh
#
set -euo pipefail

WIN_PROJECT="/mnt/c/Users/jason/Desktop/local-llm-chat/mobile"
TOOLS="$HOME/android-tools"
WORK="$HOME/coderyo-mobile"
JDK_DIR="$TOOLS/jdk17"
SDK_DIR="$TOOLS/sdk"
CMDLINE_ZIP_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
JDK_URL="https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

mkdir -p "$TOOLS"

# --- JDK 17 -----------------------------------------------------------------
if [ ! -x "$JDK_DIR/bin/javac" ]; then
  log "Downloading JDK 17 (Temurin)…"
  curl -fSL "$JDK_URL" -o "$TOOLS/jdk17.tar.gz"
  rm -rf "$JDK_DIR" && mkdir -p "$JDK_DIR"
  tar -xzf "$TOOLS/jdk17.tar.gz" -C "$JDK_DIR" --strip-components=1
  rm -f "$TOOLS/jdk17.tar.gz"
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"
log "Java: $(java -version 2>&1 | head -1)"

# --- Android SDK command-line tools -----------------------------------------
if [ ! -f "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]; then
  log "Downloading Android command-line tools…"
  curl -fSL "$CMDLINE_ZIP_URL" -o "$TOOLS/cmdline-tools.zip"
  rm -rf "$SDK_DIR/cmdline-tools"
  mkdir -p "$SDK_DIR/cmdline-tools"
  # Extract with the JDK's jar tool so we need no `unzip` package.
  ( cd "$SDK_DIR/cmdline-tools" && "$JAVA_HOME/bin/jar" xf "$TOOLS/cmdline-tools.zip" )
  mv "$SDK_DIR/cmdline-tools/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
  rm -f "$TOOLS/cmdline-tools.zip"
fi
# jar extraction drops the executable bit; restore it for the CLI scripts.
chmod -R +x "$SDK_DIR/cmdline-tools/latest/bin"
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"
export PATH="$SDK_DIR/cmdline-tools/latest/bin:$SDK_DIR/platform-tools:$PATH"

# --- SDK packages + licenses ------------------------------------------------
if [ ! -d "$SDK_DIR/platforms/android-34" ]; then
  log "Installing SDK packages (platform 34, build-tools 34)…"
  # `yes` is killed by SIGPIPE once sdkmanager stops reading; don't let pipefail
  # turn that into a fatal exit.
  set +o pipefail
  yes | sdkmanager --licenses >/dev/null 2>&1 || true
  set -o pipefail
  sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
fi

# --- Sync project off /mnt/c ------------------------------------------------
log "Syncing project into WSL filesystem ($WORK)…"
mkdir -p "$WORK"
# node_modules is needed (Gradle references ../node_modules/@capacitor/android).
cp -r "$WIN_PROJECT/android" "$WIN_PROJECT/node_modules" "$WIN_PROJECT/capacitor.config.json" "$WORK/" 2>/dev/null || {
  rm -rf "$WORK"; mkdir -p "$WORK"
  cp -r "$WIN_PROJECT/android" "$WORK/"
  cp -r "$WIN_PROJECT/node_modules" "$WORK/"
  cp "$WIN_PROJECT/capacitor.config.json" "$WORK/"
}

cd "$WORK/android"
# Strip CRLF from the wrapper script (Windows checkout) so bash can run it.
sed -i 's/\r$//' gradlew
chmod +x gradlew

# Point the SDK location explicitly for this build.
printf 'sdk.dir=%s\n' "$SDK_DIR" > local.properties

log "Running Gradle assembleDebug… (first run downloads Gradle + deps, be patient)"
./gradlew --no-daemon assembleDebug

APK="$WORK/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  mkdir -p "$WIN_PROJECT/dist"
  cp "$APK" "$WIN_PROJECT/dist/coderyo-chat-debug.apk"
  log "BUILD OK → mobile/dist/coderyo-chat-debug.apk"
else
  log "Build finished but APK not found at expected path:"
  echo "$APK"
  exit 1
fi
