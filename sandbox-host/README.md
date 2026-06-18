# microVM sandbox host setup (WSL2)

Provisioning and runtime scripts for the **microVM** code-execution backend
(`SANDBOX_DRIVER=microvm`). Each conversation gets one long-lived Cloud
Hypervisor microVM (own Linux kernel) inside WSL2, with the conversation's
persistent workspace mounted over virtio-fs at `/workspace`. The guest runs a
daemon, so multiple `run_code` and `start_background` jobs can run concurrently
inside the same conversation VM.

These scripts run **inside a WSL2 Ubuntu distro**, not on Windows. By default
everything lives under `~/llm-sandbox/` in WSL; the Next.js app on Windows
reaches the workspace over the UNC path
`\\wsl.localhost\<distro>\srv\llm-sandboxes\...` and boots VMs by invoking the
root-owned bridge through `wsl.exe`. Copy this folder's contents into
`~/llm-sandbox/` in WSL, keeping the `build/` and `guest/` layout, before
running setup.

## Requirements

- Windows 11 + WSL2 with nested virtualization (`/dev/kvm` present, CPU
  `vmx`/`svm`).
- A WSL2 Ubuntu distro (tested on 24.04/26.04).

## One-Time Setup

Run inside WSL:

```bash
cd ~/llm-sandbox
bash build/stage1.sh        # cloud-hypervisor + ch-remote + virtiofsd + nftables, /srv/llm-sandboxes
bash build/stage2.sh        # install a guest kernel (linux-image-virtual)
bash build/stage2b.sh       # copy kernel + smoke-test it boots under CH
bash build/stage3.sh        # build base ext4 rootfs (ubuntu-base + python/pip/git/busybox)
bash build/stage3b.sh       # add kmod + depmod (so guest can modprobe virtiofs/overlay)
bash build/stage3c.sh       # add iproute2/curl + net-test init
bash build/stage3d-computer.sh # (optional) bake the GUI stack: Xvfb/openbox/Chromium/xdotool/scrot/wmctrl/xterm
bash build/stage3e-browser.sh  # (optional) bake Playwright Chromium for the browser_* tools
bash build/stage3f-ocr.sh      # (optional) bake standalone CPython 3.12 + PaddleOCR PP-OCRv6 for OCR
bash build/stage3g-video.sh    # (optional) bake ffmpeg + yt-dlp + pulseaudio for the watch_video tool
bash build/stage4-inject.sh # inject guest files into base.img via debugfs
bash install-sudoers.sh     # scoped passwordless sudo for the per-session bridge
```

The `stage3d/3e/3f/3g` bakes are optional but required for computer-use, browser
tools, OCR, and the `watch_video` tool respectively. `base.img` needs headroom
for them — grow it first
if tight (`truncate -s 6G images/base.img && e2fsck -fy images/base.img && resize2fs images/base.img`).

Artifacts produced (git-ignored, not committed): `bin/cloud-hypervisor`,
`kernel/vmlinuz`, `images/base.img`.

## Files

- `build/stage*.sh`: one-time provisioning steps.
- `vm-run.sh`: the per-conversation bridge the app invokes as
  `vm-run.sh <convId> <vcpus> <memMiB> <sessionTimeoutSec> <sysGiB>`. It sets up
  bridge+NAT, allocates a tap/IP slot, starts virtiofsd, boots the VM, and
  returns when the VM powers off. Also supports `vm-run.sh stop <convId>`, which
  the app calls to tear a VM down: it kills only that conversation's
  cloud-hypervisor (matched by its `sys.img` path) and frees its tap/IP slot —
  killing the `wsl.exe` relay alone does **not** stop the Linux VM.
- `install-sudoers.sh`: installs a root-owned copy of the bridge at
  `/usr/local/sbin/llm-vm-run` and grants passwordless sudo for only that
  script. Re-run it after editing `vm-run.sh`.
- `guest/llm-init`: PID 1. It mounts a writable overlay over the read-only base
  root, with the upper layer on the per-conversation sparse system disk
  `/dev/vdb`, then hands off to `/llm-init-real`.
- `guest/llm-init-real`: mounts `/workspace`, configures networking, runs the
  daemon, and powers off when the daemon exits.
- `guest/llm-runner.py`: daemon that watches
  `/workspace/.run/jobs/<job-id>/request.json`, starts each job as root inside
  the VM, streams logs into that job directory, and writes `result.json`. Also
  runs the live VM Console capture loop (writes `.run/computer/screen-stream.jpg`
  while the server keeps `.run/computer/stream.on` fresh).
- `guest/ocr-worker.py`: PP-OCRv6 OCR worker, run under the baked CPython 3.12;
  the daemon talks to it over pipes and keeps it warm.

## Notes

- The guest payload runs as root inside the VM. `virtiofsd` maps guest root to
  the host user so workspace files stay host-owned.
- The per-conversation system disk is `<conv>/sys.img`. It is attached as
  `/dev/vdb`, holds the writable system overlay, persists across VM sessions,
  and is mounted by only that conversation VM.
- `SANDBOX_VM_MAX_CONCURRENT` caps how many conversation VMs can be alive at
  once. It does not cap job count inside a conversation VM.
- `SANDBOX_VM_SESSION_MAX_MS` is the hard ceiling for one VM session.
  `SANDBOX_VM_IDLE_MS` controls when an idle guest daemon exits and powers off.
- Updating the guest daemon: after editing `sandbox-host/guest/llm-runner.py`
  (or `ocr-worker.py`), re-bake them into the base image with
  `sandbox-host/update-guest-runner.sh`. No VM may be running during the inject.
