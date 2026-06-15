#!/usr/bin/env bash
# Phase 0 - stage 3b: add kmod + depmod so modprobe virtiofs works in guest.
set -uo pipefail
LSB="$HOME/llm-sandbox"
BUILD="$LSB/rootfs-build"
IMG="$LSB/images/base.img"
KVER=$(ls /boot/vmlinuz-* 2>/dev/null | sed 's#.*/vmlinuz-##' | sort -V | tail -1)
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
  apt-get install -y -qq --no-install-recommends kmod 2>&1 | tail -3
  which depmod modprobe
  depmod $KVER
  apt-get clean
"
echo "=== modules.dep has virtiofs? ==="
sudo grep -m1 virtiofs "$BUILD/usr/lib/modules/$KVER/modules.dep" 2>&1 || echo "NOT FOUND in modules.dep"
# restore static resolv.conf
echo 'nameserver 1.1.1.1' | sudo tee "$BUILD/etc/resolv.conf" >/dev/null

cleanup
trap - EXIT
echo "=== DONE stage3b ==="
