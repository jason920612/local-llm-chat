#!/usr/bin/env bash
# Verify what guest runner is actually baked into base.img + the staged source.
set -uo pipefail
LSB="$HOME/llm-sandbox"
IMG="$LSB/images/base.img"

echo "=== staged source perms/owner ==="
ls -la "$LSB/guest/llm-runner.py"

echo "=== extract /llm-runner.py from base.img via debugfs ==="
debugfs "$IMG" >/tmp/runner-from-img.py 2>/dev/null <<'EOF'
dump /llm-runner.py /tmp/runner-from-img.py
EOF
echo "--- grep injected image for the live-log + fsync lines ---"
grep -n "os.fsync\|live_path\|live.log\|buffering=0" /tmp/runner-from-img.py || echo "(none found — fsync NOT in image)"
echo "--- size ---"
wc -c /tmp/runner-from-img.py
