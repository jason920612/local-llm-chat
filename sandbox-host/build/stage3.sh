#!/usr/bin/env bash
# Phase 0 - stage 3: build base ext4 rootfs. Loop-mount + chroot. All paths under ~/llm-sandbox.
set -uo pipefail
LSB="$HOME/llm-sandbox"
DL="$LSB/dl"
IMGDIR="$LSB/images"
BUILD="$LSB/rootfs-build"          # loop mount point (under home, NEVER /mnt)
IMG="$IMGDIR/base.img"
TARBALL_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/26.04/release/ubuntu-base-26.04-base-amd64.tar.gz"
TARBALL="$DL/ubuntu-base-26.04-amd64.tar.gz"
KVER=$(ls /boot/vmlinuz-* 2>/dev/null | sed 's#.*/vmlinuz-##' | sort -V | tail -1)
mkdir -p "$DL" "$IMGDIR" "$BUILD"

# --- safety: refuse to operate outside the sandbox build tree ---
case "$BUILD" in "$HOME/llm-sandbox/"*) : ;; *) echo "REFUSE: BUILD outside sandbox: $BUILD"; exit 1;; esac

cleanup() {
  for m in "$BUILD/dev/pts" "$BUILD/dev" "$BUILD/proc" "$BUILD/sys"; do
    mountpoint -q "$m" 2>/dev/null && sudo umount -l "$m" 2>/dev/null
  done
  mountpoint -q "$BUILD" 2>/dev/null && sudo umount "$BUILD" 2>/dev/null
}
trap cleanup EXIT

echo "=== KVER=$KVER ==="
echo "=== download ubuntu-base ==="
if [ ! -s "$TARBALL" ]; then
  curl -sL --max-time 180 -o "$TARBALL" "$TARBALL_URL"
fi
ls -l "$TARBALL"

echo "=== create + format 3G ext4 image ==="
rm -f "$IMG"
truncate -s 3G "$IMG"
mkfs.ext4 -q -F "$IMG"

echo "=== loop mount ==="
sudo mount -o loop "$IMG" "$BUILD"
mountpoint "$BUILD"

echo "=== extract base rootfs ==="
sudo tar -xzf "$TARBALL" -C "$BUILD"
echo "extracted; top entries:"; ls "$BUILD" | head

echo "=== copy kernel modules for $KVER ==="
sudo mkdir -p "$BUILD/usr/lib/modules"
sudo cp -a "/usr/lib/modules/$KVER" "$BUILD/usr/lib/modules/"
# ensure /lib -> /usr/lib modules path resolvable
[ -d "$BUILD/lib/modules" ] || sudo ln -sfn /usr/lib/modules "$BUILD/lib/modules" 2>/dev/null || true

echo "=== chroot prep (binds + dns) ==="
sudo cp /etc/resolv.conf "$BUILD/etc/resolv.conf"
sudo mount --bind /dev "$BUILD/dev"
sudo mount --bind /proc "$BUILD/proc"
sudo mount --bind /sys "$BUILD/sys"

echo "=== chroot: apt install runtime ==="
sudo chroot "$BUILD" /bin/bash -c "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    python3 python3-venv python3-pip git ca-certificates busybox-static 2>&1 | tail -4
  depmod $KVER 2>&1 | tail -2
  apt-get clean
" || echo "CHROOT APT had non-zero exit (continuing to verify)"

echo "=== bake static resolv.conf + install init ==="
echo 'nameserver 1.1.1.1' | sudo tee "$BUILD/etc/resolv.conf" >/dev/null
sudo mkdir -p "$BUILD/workspace"
sudo cp "$LSB/guest/llm-init" "$BUILD/llm-init"
sudo chmod +x "$BUILD/llm-init"

echo "=== verify rootfs contents ==="
for b in /usr/bin/python3 /usr/bin/git /bin/busybox /usr/bin/busybox /llm-init; do
  if sudo test -e "$BUILD$b"; then echo "OK   $b"; else echo "MISS $b"; fi
done
echo "virtiofs module:"; sudo find "$BUILD/usr/lib/modules/$KVER" -name 'virtiofs*' 2>/dev/null | head
echo "python3 version in rootfs:"; sudo chroot "$BUILD" python3 --version 2>&1

echo "=== unmount (via trap) + sizes ==="
cleanup
trap - EXIT
du -h "$IMG" | cut -f1
echo "=== DONE stage3 ==="
