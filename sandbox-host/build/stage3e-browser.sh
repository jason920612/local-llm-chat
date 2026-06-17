#!/usr/bin/env bash
# Phase 0 - stage 3e: bake Python Playwright + bundled Chromium into base.img.
set -uo pipefail
LSB="$HOME/llm-sandbox"
BUILD="$LSB/rootfs-build"
IMG="$LSB/images/base.img"
case "$BUILD" in "$HOME/llm-sandbox/"*) : ;; *) echo "REFUSE: $BUILD"; exit 1;; esac

cleanup() {
  for m in "$BUILD/dev/pts" "$BUILD/dev" "$BUILD/proc" "$BUILD/sys"; do
    mountpoint -q "$m" 2>/dev/null && sudo umount -l "$m" 2>/dev/null
  done
  mountpoint -q "$BUILD" 2>/dev/null && sudo umount "$BUILD" 2>/dev/null
}
trap cleanup EXIT

sudo mount -o loop "$IMG" "$BUILD"
sudo cp /etc/resolv.conf "$BUILD/etc/resolv.conf"
sudo mount --bind /dev "$BUILD/dev"
sudo mount --bind /proc "$BUILD/proc"
sudo mount --bind /sys "$BUILD/sys"

sudo chroot "$BUILD" /bin/bash -c "
  export DEBIAN_FRONTEND=noninteractive
  export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libasound2t64 libxdamage1 libatspi2.0-0 2>&1 | tail -8
  python3 -m pip install --break-system-packages --no-cache-dir playwright
  python3 -m playwright install chromium
  python3 - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    print('chromium executable:', p.chromium.executable_path)
PY
  apt-get clean
  rm -rf /var/lib/apt/lists/*
"

echo 'nameserver 1.1.1.1' | sudo tee "$BUILD/etc/resolv.conf" >/dev/null

cleanup
trap - EXIT
du -h "$IMG" | cut -f1
echo "=== DONE stage3e-browser ==="
