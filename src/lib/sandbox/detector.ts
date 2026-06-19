import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

/**
 * Lifecycle for the host-side GPU UI-detector service (WSL2). The microVM has no
 * GPU, so OmniParser YOLO runs in a persistent WSL2 CUDA process that serves all
 * VMs over the shared workspace (file transport). Florence-2-large captions are
 * either preloaded or lazy-loaded by the first caption=true request.
 *
 * This module only ENSURES the service is running (launches it on demand); the
 * service itself idle-exits to free VRAM, and a flock makes double-launch safe.
 * Detection requests/results flow guest <-> service via the virtio-fs share, so
 * Node is not on the per-request path. See docs/computer-use-v3-grounding-plan.md.
 */

const cfg = () => config.sandbox.microvm;

/** Convert a Windows path (C:\a\b) to a WSL mount path (/mnt/c/a/b). */
function toWslMount(winPath: string): string {
  const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return winPath.replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/** UNC path to a file inside the WSL distro. */
function toUnc(wslPath: string): string {
  const rel = wslPath.replace(/^\/+/, "").replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${cfg().wslDistro}\\${rel}`;
}

function aliveFileUnc(): string {
  return toUnc(`${cfg().wslHome}/detector/service.alive`);
}

/** True if the service wrote a heartbeat within the last few seconds. */
function aliveRecently(): boolean {
  try {
    const raw = fs.readFileSync(aliveFileUnc(), "utf8");
    const { ts } = JSON.parse(raw) as { ts?: number };
    return typeof ts === "number" && Date.now() - ts < 6000;
  } catch {
    return false;
  }
}

let lastSpawn = 0;

/**
 * Best-effort: make sure the detector service is up. Cheap no-op when a fresh
 * heartbeat exists. Never throws — if launch fails, marking simply falls back to
 * OCR/DOM boxes only.
 */
export function ensureDetector(): void {
  if (!cfg().detector.enabled) return;
  if (aliveRecently()) return;
  // Throttle launches; the service has a flock so a racing duplicate just exits.
  if (Date.now() - lastSpawn < 8000) return;
  lastSpawn = Date.now();

  const det = cfg().detector;
  const scriptWin = path.win32.join(
    process.cwd(),
    "sandbox-host",
    "detector-service.py",
  );
  const scriptWsl = toWslMount(scriptWin);
  const py = `${cfg().wslHome}/detector/venv/bin/python`;
  const logf = `${cfg().wslHome}/detector/service.log`;
  const captionFlag = det.caption ? "" : "--no-caption";
  // Run the service in the FOREGROUND of the wsl.exe child (exec replaces bash),
  // so wsl.exe stays alive for the service's lifetime. This avoids two traps:
  //   - `nohup … &` backgrounding: WSL often kills bg processes when the wsl.exe
  //     interop call returns, so the service died right after launch.
  //   - `detached:true`: on Windows it defeats windowsHide and flashes a console.
  // windowsHide keeps it invisible; the service idle-exits on its own (then
  // wsl.exe exits too). unref() keeps it off Node's event loop without killing it.
  const inner = `exec "${py}" "${scriptWsl}" --idle ${Math.ceil(det.idleSec)} ${captionFlag} >> "${logf}" 2>&1`;
  try {
    const child = spawn(
      "wsl.exe",
      ["-d", cfg().wslDistro, "--", "bash", "-lc", inner],
      { windowsHide: true, stdio: "ignore" },
    );
    child.unref();
  } catch {
    /* best-effort */
  }
}

/**
 * Like ensureDetector, but AWAIT until the service is reporting a fresh heartbeat
 * (model loaded, watching) — up to timeoutMs. Use before the FIRST marked observe
 * so it isn't a cold-start race: if we sent the VM job while the service was still
 * loading, that first detect request could expire and the observe would fall back
 * to OCR/DOM-only marks. Returns true if ready, false on timeout (caller proceeds
 * anyway — the guest's own detect poll may still catch a slightly-late service).
 */
export async function ensureDetectorReady(timeoutMs = 15000): Promise<boolean> {
  if (!cfg().detector.enabled) return false;
  if (aliveRecently()) return true;
  ensureDetector();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (aliveRecently()) return true;
  }
  return false;
}
