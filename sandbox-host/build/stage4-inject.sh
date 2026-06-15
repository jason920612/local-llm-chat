#!/usr/bin/env bash
# Inject production guest files (/llm-init, /llm-runner.py) into base.img.
set -uo pipefail
LSB="$HOME/llm-sandbox"
BUILD="$LSB/rootfs-build"
IMG="$LSB/images/base.img"
case "$BUILD" in "$HOME/llm-sandbox/"*) : ;; *) echo "REFUSE $BUILD"; exit 1;; esac
mkdir -p "$BUILD"

cleanup() { mountpoint -q "$BUILD" 2>/dev/null && sudo umount "$BUILD" 2>/dev/null; }
trap cleanup EXIT

sudo mount -o loop "$IMG" "$BUILD"
sudo cp "$LSB/guest/llm-init" "$BUILD/llm-init"
sudo cp "$LSB/guest/llm-init-real" "$BUILD/llm-init-real"
sudo cp "$LSB/guest/llm-runner.py" "$BUILD/llm-runner.py"
sudo chmod +x "$BUILD/llm-init" "$BUILD/llm-init-real"
# convenience symlinks so model code can call `python` / `pip` (not just *3)
sudo ln -sf /usr/bin/python3 "$BUILD/usr/local/bin/python"
[ -e "$BUILD/usr/bin/pip3" ] && sudo ln -sf /usr/bin/pip3 "$BUILD/usr/local/bin/pip"
[ -e "$BUILD/usr/bin/pip" ] || sudo ln -sf /usr/bin/pip3 "$BUILD/usr/local/bin/pip" 2>/dev/null || true
echo "symlinks:"; sudo ls -l "$BUILD/usr/local/bin/" 2>/dev/null | grep -E 'python|pip' || echo none
echo "=== verify ==="
sudo test -x "$BUILD/llm-init" && echo "OK /llm-init"
sudo test -f "$BUILD/llm-runner.py" && echo "OK /llm-runner.py"
sudo head -1 "$BUILD/llm-init"
cleanup
trap - EXIT
echo "=== DONE inject ==="
