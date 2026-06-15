#!/usr/bin/env bash
# Phase 0 - stage 3c: add iproute2 + curl to rootfs (needed for guest networking / pip / git).
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
  apt-get install -y -qq --no-install-recommends iproute2 curl iputils-ping 2>&1 | tail -3
  apt-get clean
"
echo "=== verify ==="
for b in /usr/sbin/ip /usr/bin/ip /usr/bin/curl; do
  sudo test -e "$BUILD$b" && echo "OK $b" || echo "MISS $b"
done
echo 'nameserver 1.1.1.1' | sudo tee "$BUILD/etc/resolv.conf" >/dev/null

echo "=== install net-test init ==="
sudo cp "$LSB/guest/llm-init-net" "$BUILD/llm-init-net"
sudo chmod +x "$BUILD/llm-init-net"
sudo test -x "$BUILD/llm-init-net" && echo "OK /llm-init-net"

cleanup
trap - EXIT
echo "=== DONE stage3c ==="
