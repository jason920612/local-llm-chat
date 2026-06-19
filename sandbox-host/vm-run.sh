#!/usr/bin/env bash
# Per-conversation microVM bridge. Called by the Node MicroVMDriver as:
#   vm-run.sh <CONVID> <VCPUS> <MEM_MIB> <SESSION_TIMEOUT_SEC>
# Boots one Cloud Hypervisor microVM for the conversation with its persistent
# workspace mounted over virtio-fs at /workspace. The guest daemon accepts many
# concurrent jobs under .run/jobs/ and exits after an idle timeout.
set -uo pipefail

# Artifacts (CH binary, kernel, base rootfs) live here. The root-owned installed
# copy (/usr/local/sbin/llm-vm-run) has LLM_SANDBOX_HOME baked in by install.sh,
# so this is pinned at install time and NOT caller-controllable.
LSB="${LLM_SANDBOX_HOME:-$HOME/llm-sandbox}"
CH="$LSB/bin/cloud-hypervisor"
VIRTIOFSD=/usr/libexec/virtiofsd
# absolute paths for privileged calls (match the scoped sudoers entry exactly)
IP=/usr/sbin/ip
NFT=/usr/sbin/nft
SYSCTL=/usr/sbin/sysctl
KILL=$(ls /usr/bin/kill /bin/kill 2>/dev/null | head -1)
TIMEOUT_BIN=/usr/bin/timeout
KERNEL="$LSB/kernel/vmlinuz"
ROOTFS="$LSB/images/base.img"
ROOT="${SANDBOX_WSL_ROOT:-/srv/llm-sandboxes}"

# --- stop mode: "llm-vm-run stop <CONVID>" -----------------------------------
# Tear down a conversation's VM. Killing the Windows-side wsl.exe relay does NOT
# stop the Linux cloud-hypervisor it launched, so the Node driver calls this to
# actually terminate the VM and free its tap/slot/virtiofsd. Identifies the
# processes by this conversation's unique sys.img / workspace paths, so it never
# touches another conversation's VM. Best-effort; always exits 0.
if [ "${1:-}" = "stop" ]; then
  CONVID=$(printf '%s' "${2:-}" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)
  [ -z "$CONVID" ] && { echo "ERR bad convid"; exit 2; }
  CONVDIR="$ROOT/$CONVID"; WS="$CONVDIR/ws"
  case "$CONVDIR" in "$ROOT/"*) : ;; *) echo "ERR refuse $CONVDIR"; exit 2;; esac
  # 1) kill cloud-hypervisor + its timeout wrapper (unique by this sys.img path).
  #    When CH dies, any still-running llm-vm-run for this conv also runs its own
  #    cleanup() trap (tap/slot/virtiofsd) — we then repeat that below to be safe.
  pkill -9 -f "$CONVDIR/sys.img" 2>/dev/null || true
  # 2) kill this conversation's virtiofsd (unique by its shared workspace dir).
  pkill -9 -f -- "--shared-dir=$WS" 2>/dev/null || true
  # 3) free the tap device + IP slot (derive the slot from the guest net config).
  SLOT=$(sed -n 's#.*"ip":"[0-9.]*\.\([0-9]\{1,3\}\)/24".*#\1#p' "$WS/.run/net.json" 2>/dev/null | head -1)
  if [ -n "$SLOT" ]; then
    "$IP" link del "lt$SLOT" 2>/dev/null || true
    rm -f "$LSB/run/slots/$SLOT" 2>/dev/null || true
  fi
  rm -f "$WS/.run/vfsd.sock" 2>/dev/null || true
  echo "stopped $CONVID slot=${SLOT:-?}"
  exit 0
fi

CONVID=$(printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)
VCPUS="${2:-2}"; MEM="${3:-1024}"; TIMEOUT="${4:-30}"; SYSGB="${5:-100}"
[ -z "$CONVID" ] && { echo "ERR bad convid"; exit 2; }

CONVDIR="$ROOT/$CONVID"
WS="$CONVDIR/ws"            # virtio-fs-shared workspace (persistent files + .run)
SYSIMG="$CONVDIR/sys.img"   # sparse ext4 system disk (overlay upper + /tmp), NOT shared
# safety: paths must be strictly under the sandbox root
case "$WS" in "$ROOT/"*) : ;; *) echo "ERR refuse ws $WS"; exit 2;; esac
mkdir -p "$WS/.run"

# --- per-conversation sparse system disk (thin: only real usage hits the host) ---
if [ ! -f "$SYSIMG" ]; then
  truncate -s "${SYSGB}G" "$SYSIMG"
  # lazy init keeps the image sparse; -m0 = no reserved blocks
  mkfs.ext4 -q -F -m 0 -E lazy_itable_init=1,lazy_journal_init=1 "$SYSIMG" \
    || { echo "ERR mkfs sys.img failed"; rm -f "$SYSIMG"; exit 5; }
fi

BR=llmbr0
SUBNET=172.30.0
WAN=$(ip route show default 2>/dev/null | awk '{print $5; exit}')

# --- idempotent host net base: bridge + ip_forward + masquerade ---
if ! ip link show "$BR" >/dev/null 2>&1; then
  sudo "$IP" link add "$BR" type bridge
  sudo "$IP" addr add ${SUBNET}.1/24 dev "$BR"
  sudo "$IP" link set "$BR" up
fi
sudo "$SYSCTL" -wq net.ipv4.ip_forward=1 2>/dev/null
sudo "$NFT" add table ip llmnat 2>/dev/null || true
sudo "$NFT" 'add chain ip llmnat post { type nat hook postrouting priority 100 ; }' 2>/dev/null || true
if ! sudo "$NFT" list chain ip llmnat post 2>/dev/null | grep -q "saddr ${SUBNET}.0/24"; then
  [ -n "$WAN" ] && sudo "$NFT" add rule ip llmnat post ip saddr ${SUBNET}.0/24 oifname "$WAN" masquerade
fi

# --- allow only one VM session for the same conversation ---
exec 9>"$WS/.run/.lock"
flock 9

# --- allocate a free guest IP slot (2..250) via atomic lockfiles ---
SLOTDIR="$LSB/run/slots"; mkdir -p "$SLOTDIR"
SLOT=""
for n in $(seq 2 250); do
  if ( set -o noclobber; echo $$ >"$SLOTDIR/$n" ) 2>/dev/null; then SLOT=$n; break; fi
done
[ -z "$SLOT" ] && { echo "ERR no free vm slot"; exit 3; }
TAP="lt${SLOT}"
SOCK="$WS/.run/vfsd.sock"
VFSD=""

cleanup() {
  [ -n "$VFSD" ] && sudo "$KILL" "$VFSD" 2>/dev/null || true
  sudo "$IP" link del "$TAP" 2>/dev/null || true
  rm -f "$SOCK" "$SLOTDIR/$SLOT" 2>/dev/null || true
}
trap cleanup EXIT

# --- network config handed to the guest via control file ---
printf '{"ip":"%s.%s/24","gw":"%s.1"}' "$SUBNET" "$SLOT" "$SUBNET" >"$WS/.run/net.json"

# Delete any stale tap for this slot FIRST (a prior VM may have leaked it on a
# hard kill). Re-adding without this silently reuses the broken device, which
# fails CH with "tap offload: File descriptor in bad state".
sudo "$IP" link del "$TAP" 2>/dev/null || true
sudo "$IP" tuntap add dev "$TAP" mode tap
sudo "$IP" link set "$TAP" master "$BR"
sudo "$IP" link set "$TAP" up

# --- virtiofsd for the workspace share ---
rm -f "$SOCK"
# translate-uid/gid: the guest runs the payload as root (uid/gid 0) so the model
# has full root INSIDE the VM, but virtiofsd maps that to the host user (1000)
# so workspace files stay owned by jason on the host (readable/cleanable).
sudo "$VIRTIOFSD" --socket-path="$SOCK" --shared-dir="$WS" --sandbox none \
  --translate-uid map:0:1000:1 --translate-gid map:0:1000:1 \
  >"$WS/.run/virtiofsd.log" 2>&1 &
VFSD=$!
for i in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.05; done
[ -S "$SOCK" ] || { echo "ERR virtiofsd socket"; exit 4; }

# --- boot the microVM (outer timeout = session timeout + margin) ---
MAC=$(printf '12:34:56:%02x:%02x:%02x' "$SLOT" $((RANDOM%256)) $((RANDOM%256)))
HARD=$(( TIMEOUT + 25 ))
sudo "$TIMEOUT_BIN" "$HARD" "$CH" \
  --kernel "$KERNEL" \
  --disk path="$ROOTFS",readonly=on,image_type=raw path="$SYSIMG",readonly=off,image_type=raw \
  --fs tag=workspace,socket="$SOCK" \
  --net tap="$TAP",mac="$MAC" \
  --cmdline "console=ttyS0 root=/dev/vda ro init=/llm-init" \
  --serial file="$WS/.run/serial.log" \
  --console off \
  --cpus boot="$VCPUS" \
  --memory size="${MEM}M",shared=on \
  >"$WS/.run/ch.log" 2>&1
echo "ch_exit=$? slot=$SLOT"
