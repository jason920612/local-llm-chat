#!/usr/bin/env bash
# Phase 0 - stage 2b: copy kernel (sudo) + smoke-test that Cloud Hypervisor boots this bzImage.
set -uo pipefail
LSB=~/llm-sandbox
CH="$LSB/bin/cloud-hypervisor"
mkdir -p "$LSB/kernel" "$LSB/out"

KVER=$(ls /boot/vmlinuz-* 2>/dev/null | sed 's#.*/vmlinuz-##' | sort -V | tail -1)
echo "KVER=$KVER"
sudo cp "/boot/vmlinuz-$KVER" "$LSB/kernel/vmlinuz"
sudo cp "/boot/config-$KVER" "$LSB/kernel/config" 2>/dev/null || true
sudo chown "$USER:$USER" "$LSB/kernel/vmlinuz" "$LSB/kernel/config" 2>/dev/null || true
ls -l "$LSB/kernel/"
file "$LSB/kernel/vmlinuz"

echo "=== extra config flags ==="
grep -E 'CONFIG_(PVH|MAGIC_SYSRQ|SERIAL_8250_CONSOLE|SERIAL_8250)=' "$LSB/kernel/config" 2>/dev/null | sort || echo "no config"

echo "=== CH bzImage smoke test (no disk -> expect kernel boot then panic) ==="
LOG="$LSB/out/ksmoke.log"
: > "$LOG"
sudo timeout 20 "$CH" \
  --kernel "$LSB/kernel/vmlinuz" \
  --cmdline "console=ttyS0 panic=1 reboot=t" \
  --serial file="$LOG" \
  --console off \
  --cpus boot=1 \
  --memory size=1024M >"$LSB/out/ch-stdout.log" 2>&1
echo "CH exit=$? (124=timeout-killed, expected if it loops)"
echo "=== first 25 serial lines ==="
head -25 "$LOG" 2>&1
echo "=== serial line count ==="
wc -l "$LOG" 2>&1
echo "=== ch stdout/stderr tail ==="
tail -8 "$LSB/out/ch-stdout.log" 2>&1
echo "=== DONE stage2b ==="
