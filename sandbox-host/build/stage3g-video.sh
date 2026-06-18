#!/usr/bin/env bash
# Phase 0 - stage 3g: bake the watch_video toolchain into base.img.
#   - ffmpeg/ffprobe  : frame sampling (scene detection) + audio extraction
#   - yt-dlp          : download web videos (YouTube etc.) for offline sampling
#   - pulseaudio      : virtual null sink so the browser-playback fallback can
#                       record the VM's system audio (no sound hardware needed)
# See docs/watch-video-plan.md.
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

sudo chroot "$BUILD" /bin/bash -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    ffmpeg yt-dlp pulseaudio pulseaudio-utils 2>&1 | tail -8
  # Fallback if the distro has no yt-dlp package: install the standalone binary.
  if ! command -v yt-dlp >/dev/null 2>&1; then
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && chmod 0755 /usr/local/bin/yt-dlp
  fi
  # Let PulseAudio run as root in this single-user VM (it normally refuses).
  mkdir -p /etc/pulse/daemon.conf.d
  printf "allow-exit = no\nexit-idle-time = -1\n" > /etc/pulse/daemon.conf.d/llm.conf
  echo "versions:"
  ffmpeg -version | head -1 || true
  yt-dlp --version || true
  pulseaudio --version || true
  apt-get clean
  rm -rf /var/lib/apt/lists/*
'

echo 'nameserver 1.1.1.1' | sudo tee "$BUILD/etc/resolv.conf" >/dev/null

cleanup
trap - EXIT
du -h "$IMG" | cut -f1
echo "=== DONE stage3g-video ==="
