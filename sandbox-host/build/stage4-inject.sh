#!/usr/bin/env bash
# Inject guest files into base.img using debugfs (NO loop mount — this WSL2
# kernel's loop module hangs on load, and VMs don't need loop anyway since
# Cloud Hypervisor attaches the image directly via virtio-blk).
set -uo pipefail
LSB="$HOME/llm-sandbox"
IMG="$LSB/images/base.img"
G="$LSB/guest"

# Sanity: image must exist and not be in use by a running VM.
[ -f "$IMG" ] || { echo "ERR base.img missing"; exit 1; }
if pgrep -f "cloud-hypervisor.*$(basename "$IMG")" >/dev/null 2>&1; then
  echo "ERR base.img is in use by a running VM — stop VMs first"; exit 1
fi

run_debugfs() { debugfs -w "$IMG" 2>&1; }

echo "=== inject via debugfs ==="
run_debugfs <<EOF
rm /llm-init
rm /llm-init-real
rm /llm-runner.py
rm /ocr-worker.py
rm /usr/local/bin/python
rm /usr/local/bin/pip
write $G/llm-init /llm-init
write $G/llm-init-real /llm-init-real
write $G/llm-runner.py /llm-runner.py
write $G/ocr-worker.py /ocr-worker.py
sif /llm-init mode 0100755
sif /llm-init-real mode 0100755
sif /llm-runner.py mode 0100755
sif /ocr-worker.py mode 0100755
symlink /usr/local/bin/python /usr/bin/python3
symlink /usr/local/bin/pip /usr/bin/pip3
EOF

echo "=== verify ==="
for f in /llm-init /llm-init-real /llm-runner.py /ocr-worker.py; do
  m=$(debugfs -R "stat $f" "$IMG" 2>/dev/null | sed -n 's/.*Mode: *\(0[0-7]*\).*/\1/p' | head -1)
  echo "$f mode=$m"
done
debugfs -R "stat /usr/local/bin/python" "$IMG" 2>/dev/null | grep -i 'Type: symlink\|Fast link dest' | head -1
echo "=== DONE inject (debugfs) ==="
