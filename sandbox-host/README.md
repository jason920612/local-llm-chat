# microVM sandbox host setup (WSL2)

Provisioning + runtime scripts for the **microVM** code-execution backend
(`SANDBOX_DRIVER=microvm`). Each conversation's `run_code` runs in its own
Cloud Hypervisor microVM (own Linux kernel) inside WSL2, with the conversation's
persistent workspace mounted over virtio-fs at `/workspace`.

These run **inside a WSL2 Ubuntu distro**, not on Windows. By default everything
lives under `~/llm-sandbox/` in WSL; the Next.js app (on Windows) reaches the
workspace over the UNC path `\\wsl.localhost\<distro>\srv\llm-sandboxes\...` and
boots VMs by invoking `vm-run.sh` via `wsl.exe`. Copy this folder's contents into
`~/llm-sandbox/` in WSL (keeping `build/` and `guest/` layout) before running.

## Requirements
- Windows 11 + WSL2 with nested virtualization (`/dev/kvm` present, CPU `vmx`/`svm`).
- A WSL2 Ubuntu distro (tested on 24.04/26.04).

## One-time setup (run inside WSL)
```bash
cd ~/llm-sandbox
bash build/stage1.sh        # cloud-hypervisor + ch-remote + virtiofsd + nftables, /srv/llm-sandboxes
bash build/stage2.sh        # install a guest kernel (linux-image-virtual)
bash build/stage2b.sh       # copy kernel + smoke-test it boots under CH
bash build/stage3.sh        # build base ext4 rootfs (ubuntu-base + python/pip/git/busybox)
bash build/stage3b.sh       # add kmod + depmod (so guest can modprobe virtiofs/overlay)
bash build/stage3c.sh       # add iproute2/curl + net-test init
bash build/stage4-inject.sh # inject guest/llm-init, llm-init-real, llm-runner.py + python/pip symlinks
bash install-sudoers.sh     # scoped passwordless sudo for the per-run privileged steps
```
Artifacts produced (git-ignored, not committed): `bin/cloud-hypervisor`,
`kernel/vmlinuz`, `images/base.img`.

## Files
- `build/stage*.sh` — one-time provisioning steps (idempotent-ish; safe to re-run).
- `vm-run.sh` — the per-run bridge the app invokes (`vm-run.sh <convId> <vcpus> <memMiB> <timeoutSec>`):
  sets up bridge+NAT, allocates a tap/IP slot, starts virtiofsd, boots the VM, returns on poweroff.
- `install-sudoers.sh` — installs `/etc/sudoers.d/llm-sandbox` (scoped NOPASSWD for ip/nft/sysctl/
  virtiofsd/kill/timeout) so per-run boots need no password.
- `guest/llm-init` — PID 1: mounts a tmpfs overlay over the read-only base root (writable, ephemeral),
  then `pivot_root` + `exec /llm-init-real`.
- `guest/llm-init-real` — mounts `/workspace` (virtio-fs), brings up NAT networking, runs the job, powers off.
- `guest/llm-runner.py` — reads `/workspace/.run/in.json`, runs the code **as root** in the VM
  (virtiofsd maps guest root → host user so workspace files stay host-owned), writes `.run/out.json`.

## Notes
- The guest payload runs as **root** inside the VM (safe — isolated guest kernel). Root filesystem
  is a writable tmpfs overlay (so `apt-get install` works; changes vanish at poweroff). `/workspace`
  is the only persistent layer; `pip --user` installs persist there.
- App env knobs: `SANDBOX_WSL_DISTRO`, `SANDBOX_WSL_ROOT`, `SANDBOX_WSL_HOME`, `SANDBOX_VM_VCPUS`,
  `SANDBOX_VM_MEM_MIB`, `SANDBOX_VM_MAX_CONCURRENT` (see repo `.env.example`).
