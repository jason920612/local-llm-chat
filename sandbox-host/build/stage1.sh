#!/usr/bin/env bash
# Phase 0 - stage 1: host deps + hypervisor binaries. No destructive ops.
set -uo pipefail
LSB=~/llm-sandbox
BIN="$LSB/bin"
mkdir -p "$BIN"

echo "=== apt install ==="
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  qemu-utils cpio nftables iptables python3-pip e2fsprogs \
  virtiofsd 2>&1 | tail -5
echo "apt exit=${PIPESTATUS[0]}"

echo "=== kvm group ==="
sudo usermod -aG kvm "$USER" && echo "added $USER to kvm group (effective after wsl restart; tests use sudo)"

echo "=== sandbox root dir ==="
sudo mkdir -p /srv/llm-sandboxes
sudo chown "$USER:$USER" /srv/llm-sandboxes
ls -ld /srv/llm-sandboxes

echo "=== cloud-hypervisor download ==="
CH_TAG=$(curl -s https://api.github.com/repos/cloud-hypervisor/cloud-hypervisor/releases/latest | grep -oP '"tag_name":\s*"\K[^"]+')
echo "latest CH tag: $CH_TAG"
if [ -n "$CH_TAG" ]; then
  curl -sL -o "$BIN/cloud-hypervisor" \
    "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/$CH_TAG/cloud-hypervisor-static"
  curl -sL -o "$BIN/ch-remote" \
    "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/$CH_TAG/ch-remote-static"
  chmod +x "$BIN/cloud-hypervisor" "$BIN/ch-remote"
fi

echo "=== versions ==="
file "$BIN/cloud-hypervisor" 2>&1 | head -1
"$BIN/cloud-hypervisor" --version 2>&1 | head -1
"$BIN/ch-remote" --version 2>&1 | head -1
echo "virtiofsd: $(command -v virtiofsd || echo MISSING-apt)"
/usr/lib/virtiofsd --version 2>&1 | head -1 || true
virtiofsd --version 2>&1 | head -1 || true
echo "=== DONE stage1 ==="
