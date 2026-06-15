#!/usr/bin/env bash
# Install a SCOPED, permanent passwordless-sudo rule for the microVM sandbox's
# privileged steps, so the feature keeps working after the temporary blanket
# NOPASSWD (/etc/sudoers.d/llm-sandbox-temp) is removed.
set -euo pipefail
U=$(whoami)
CHBIN="$HOME/llm-sandbox/bin/cloud-hypervisor"
TMP=$(mktemp)

# This sudo build rejects wildcards in command arguments, so we list bare
# command paths (any args allowed) — still scoped to just these binaries.
cat >"$TMP" <<EOF
# microVM sandbox (local-llm-chat): allow $U to run only these privileged
# commands without a password (used by ~/llm-sandbox/vm-run.sh).
Cmnd_Alias LLM_VM = /usr/sbin/ip, /usr/sbin/nft, /usr/sbin/sysctl, /usr/libexec/virtiofsd, /usr/bin/kill, /bin/kill, /usr/bin/timeout
$U ALL=(root) NOPASSWD: LLM_VM
EOF

echo "=== proposed /etc/sudoers.d/llm-sandbox ==="
cat "$TMP"
echo "=== visudo syntax check ==="
sudo visudo -cf "$TMP"
sudo install -m 0440 -o root -g root "$TMP" /etc/sudoers.d/llm-sandbox
rm -f "$TMP"
echo "=== installed. effective rules for $U mentioning LLM_VM: ==="
sudo -l -U "$U" 2>/dev/null | grep -iE 'llm|virtiofsd|cloud-hyper|timeout' || true
echo "=== DONE ==="
