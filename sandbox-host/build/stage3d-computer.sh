#!/usr/bin/env bash
# Phase 0 - stage 3d: bake the VM computer-use GUI stack into base.img.
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
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    xvfb openbox xdotool scrot wmctrl xterm chromium-browser \
    python3-pil fonts-noto-cjk fonts-noto-color-emoji 2>&1 | tail -8
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  command -v Xvfb openbox xdotool scrot wmctrl xterm
"

echo 'nameserver 1.1.1.1' | sudo tee "$BUILD/etc/resolv.conf" >/dev/null

cleanup
trap - EXIT
du -h "$IMG" | cut -f1
echo "=== DONE stage3d-computer ==="
