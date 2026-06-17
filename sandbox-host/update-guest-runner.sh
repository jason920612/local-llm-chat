#!/usr/bin/env bash
# Redeploy the guest runner into the microVM base image after editing
# sandbox-host/guest/llm-runner.py. Copies the repo copy into ~/llm-sandbox and
# re-injects it into base.img. Aborts safely if a VM is running.
set -uo pipefail

REPO_GUEST="/mnt/c/Users/jason/Desktop/local-llm-chat/sandbox-host/guest/llm-runner.py"
LSB="$HOME/llm-sandbox"

# The install lays stage4-inject.sh either at the top level or under build/.
INJECT="$LSB/stage4-inject.sh"
[ -f "$INJECT" ] || INJECT="$LSB/build/stage4-inject.sh"

echo "=== preflight ==="
[ -f "$REPO_GUEST" ] || { echo "ERR: repo runner missing: $REPO_GUEST"; exit 1; }
[ -f "$INJECT" ] || { echo "ERR: stage4-inject.sh not found in ~/llm-sandbox"; exit 1; }
[ -f "$LSB/images/base.img" ] || { echo "ERR: base.img missing"; exit 1; }
if pgrep -af cloud-hypervisor >/dev/null 2>&1; then
  echo "ERR: a microVM is running — stop it first (no run_code in flight)"; exit 1
fi
command -v debugfs >/dev/null || { echo "ERR: debugfs missing (apt install e2fsprogs)"; exit 1; }

echo "=== copy updated guest files -> ~/llm-sandbox/guest ==="
REPO_GUEST_DIR="/mnt/c/Users/jason/Desktop/local-llm-chat/sandbox-host/guest"
cp "$REPO_GUEST" "$LSB/guest/llm-runner.py"
cp "$REPO_GUEST_DIR/llm-init" "$LSB/guest/llm-init"
cp "$REPO_GUEST_DIR/llm-init-real" "$LSB/guest/llm-init-real"
cp "$REPO_GUEST_DIR/ocr-worker.py" "$LSB/guest/ocr-worker.py"

echo "=== inject into base.img ==="
cd "$LSB"
bash "$INJECT"
