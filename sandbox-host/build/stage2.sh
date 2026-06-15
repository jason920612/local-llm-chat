#!/usr/bin/env bash
# Phase 0 - stage 2: install a VM guest kernel + report config flags. No destructive ops.
set -uo pipefail
LSB=~/llm-sandbox
mkdir -p "$LSB/kernel"

echo "=== installing linux-image-virtual ==="
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq linux-image-virtual 2>&1 | tail -3
echo "apt exit=${PIPESTATUS[0]}"

echo "=== locate vmlinuz / config / modules ==="
ls -l /boot/vmlinuz* /boot/config* 2>&1
echo "--- modules dirs ---"
ls -d /usr/lib/modules/*/ /lib/modules/*/ 2>&1 | sort -u

KVER=$(ls /boot/vmlinuz-* 2>/dev/null | sed 's#.*/vmlinuz-##' | sort -V | tail -1)
echo "KVER=$KVER"
CFG="/boot/config-$KVER"

echo "=== relevant kernel config (y = built-in, m = module) ==="
if [ -f "$CFG" ]; then
  grep -E 'CONFIG_(VIRTIO|VIRTIO_PCI|VIRTIO_MMIO|VIRTIO_BLK|VIRTIO_NET|VIRTIO_FS|FUSE_FS|EXT4_FS|BLK_DEV_INITRD|DEVTMPFS)=' "$CFG" | sort
else
  echo "config not found at $CFG"
fi

echo "=== copy vmlinuz into build area ==="
if [ -n "$KVER" ]; then
  cp "/boot/vmlinuz-$KVER" "$LSB/kernel/vmlinuz-$KVER"
  ls -l "$LSB/kernel/"
  file "$LSB/kernel/vmlinuz-$KVER"
fi
echo "=== DONE stage2 ==="
