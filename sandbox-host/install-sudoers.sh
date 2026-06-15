#!/usr/bin/env bash
# Install the microVM bridge as a ROOT-OWNED script and grant passwordless sudo
# for ONLY that script. This avoids handing out bare commands like `timeout`/`ip`
# (which would amount to arbitrary passwordless root). The privileged work all
# happens inside the root-owned script, which the unprivileged user cannot edit.
set -euo pipefail
U=$(whoami)
SRC="$HOME/llm-sandbox/vm-run.sh"
DST=/usr/local/sbin/llm-vm-run
[ -f "$SRC" ] || { echo "ERR $SRC missing"; exit 1; }

# Build the root-owned copy with the artifacts home + sandbox root baked in, so
# the privileged script's paths are fixed at install (not caller-controllable).
TMP=$(mktemp)
{
  echo '#!/usr/bin/env bash'
  echo "export LLM_SANDBOX_HOME='$HOME/llm-sandbox'"
  echo "export SANDBOX_WSL_ROOT='${SANDBOX_WSL_ROOT:-/srv/llm-sandboxes}'"
  tail -n +2 "$SRC"   # script body minus its own shebang
} >"$TMP"
sudo install -m 0755 -o root -g root "$TMP" "$DST"
rm -f "$TMP"
echo "installed root-owned $DST"

# Scoped sudoers: ONLY the bridge script (no bare ip/nft/timeout/etc).
SUDO=$(mktemp)
cat >"$SUDO" <<EOF
# microVM sandbox (local-llm-chat): allow $U to run only the root-owned bridge
# without a password. All privileged steps live inside $DST, which $U cannot edit.
$U ALL=(root) NOPASSWD: $DST
EOF
sudo visudo -cf "$SUDO"
sudo install -m 0440 -o root -g root "$SUDO" /etc/sudoers.d/llm-sandbox
rm -f "$SUDO"
# Note: if a broad temporary rule exists from setup, remove it now:
#   sudo rm -f /etc/sudoers.d/llm-sandbox-temp

echo "=== effective rule for $U ==="
sudo -l -U "$U" 2>/dev/null | grep -i llm-vm-run || true
echo "=== DONE ==="
