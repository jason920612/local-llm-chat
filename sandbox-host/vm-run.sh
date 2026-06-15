#!/usr/bin/env bash
# Per-run microVM bridge. Called by the Node MicroVMDriver as:
#   vm-run.sh <CONVID> <VCPUS> <MEM_MIB> <TIMEOUT_SEC>
# Boots a Cloud Hypervisor microVM with the conversation's persistent workspace
# mounted over virtio-fs at /workspace; the guest runner reads .run/in.json,
# executes, writes .run/out.json, and powers off. Returns when the VM exits.
set -uo pipefail

LSB="$HOME/llm-sandbox"
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

CONVID=$(printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)
VCPUS="${2:-2}"; MEM="${3:-1024}"; TIMEOUT="${4:-30}"
[ -z "$CONVID" ] && { echo "ERR bad convid"; exit 2; }

WS="$ROOT/$CONVID"
# safety: workspace must be strictly under the sandbox root
case "$WS" in "$ROOT/"*) : ;; *) echo "ERR refuse ws $WS"; exit 2;; esac
mkdir -p "$WS/.run"

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

# --- serialize runs for the same conversation ---
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

sudo "$IP" tuntap add dev "$TAP" mode tap 2>/dev/null || true
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

# --- boot the microVM (outer timeout = guest timeout + margin) ---
rm -f "$WS/.run/out.json"
MAC=$(printf '12:34:56:%02x:%02x:%02x' "$SLOT" $((RANDOM%256)) $((RANDOM%256)))
HARD=$(( TIMEOUT + 25 ))
sudo "$TIMEOUT_BIN" "$HARD" "$CH" \
  --kernel "$KERNEL" \
  --disk path="$ROOTFS",readonly=on \
  --fs tag=workspace,socket="$SOCK" \
  --net tap="$TAP",mac="$MAC" \
  --cmdline "console=ttyS0 root=/dev/vda ro init=/llm-init" \
  --serial file="$WS/.run/serial.log" \
  --console off \
  --cpus boot="$VCPUS" \
  --memory size="${MEM}M",shared=on \
  >"$WS/.run/ch.log" 2>&1
echo "ch_exit=$? slot=$SLOT"
