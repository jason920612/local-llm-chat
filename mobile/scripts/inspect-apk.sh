#!/usr/bin/env bash
# Quick sanity dump of the built APK (package, label, permissions, activities).
set -euo pipefail
AAPT="$HOME/android-tools/sdk/build-tools/34.0.0/aapt"
APK="${1:-/mnt/c/Users/jason/Desktop/local-llm-chat/mobile/dist/coderyo-chat-debug.apk}"

echo "=== badging ==="
"$AAPT" dump badging "$APK" | grep -E 'package:|application-label:|uses-permission:|launchable-activity:'

echo "=== activities ==="
"$AAPT" dump xmltree "$APK" AndroidManifest.xml | \
  grep -A4 'E: activity' | grep -E 'A: .*name' || true
