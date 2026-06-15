import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import {
  type SandboxDriver,
  type RunResult,
  type CloneResult,
  safeConvId,
  normalizeRepoUrl,
  repoDirName,
} from "./driver";
import { listFiles, emptyResult, cloneTree } from "./fsutil";

/**
 * Cap how many microVMs boot at once across all conversations (each VM costs a
 * vCPU + RAM). A tiny in-process semaphore queues the rest. Single Next.js
 * process, so module-level state is the whole picture.
 */
let vmActive = 0;
const vmQueue: Array<() => void> = [];
async function acquireVmSlot(max: number): Promise<void> {
  if (vmActive < max) {
    vmActive++;
    return;
  }
  await new Promise<void>((resolve) => vmQueue.push(resolve));
  vmActive++;
}
function releaseVmSlot(): void {
  vmActive--;
  vmQueue.shift()?.();
}

let lastCleanup = 0;

/**
 * Serialize run_code per conversation: overlapping requests for the same
 * conversation share `.run/{in,out}.json`, so a second stage must wait for the
 * first run to finish before overwriting them.
 */
const convChain = new Map<string, Promise<unknown>>();
function withConvLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = convChain.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of a prior run's outcome
  convChain.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

/**
 * MicroVMDriver — true per-conversation isolation. Each run_code boots a
 * Cloud Hypervisor microVM (its own Linux kernel) inside WSL2, with the
 * conversation's persistent workspace mounted over virtio-fs at /workspace.
 *
 * The Node process lives on Windows; it reaches the WSL2 side two ways:
 *   - file I/O on the workspace via the UNC path `\\wsl.localhost\<distro>\...`
 *     (the dir is native ext4 in WSL2, so the file-explorer APIs just work);
 *   - execution by invoking the bridge script with `wsl.exe`, which boots the VM
 *     and returns when it powers off. Code/results pass through .run/{in,out}.json.
 */
export class MicroVMDriver implements SandboxDriver {
  readonly name = "microvm" as const;

  private get cfg() {
    return config.sandbox.microvm;
  }

  /** Convert a WSL absolute path to a Windows UNC path. */
  private toUnc(wslPath: string): string {
    const rel = wslPath.replace(/^\/+/, "").replace(/\//g, "\\");
    return `\\\\wsl.localhost\\${this.cfg.wslDistro}\\${rel}`;
  }

  sandboxRootHostPath(): string {
    return this.toUnc(this.cfg.wslSandboxRoot);
  }

  /** Per-conversation dir holding both the shared `ws/` and the `sys.img` disk. */
  private convDirHostPath(conversationId: string): string {
    return path.win32.join(this.sandboxRootHostPath(), safeConvId(conversationId));
  }

  workspaceHostPath(conversationId: string): string {
    // The virtio-fs-shared workspace is a `ws/` subdir so the per-conversation
    // system disk image (sys.img, a sibling) stays OUT of the share.
    return path.win32.join(this.convDirHostPath(conversationId), "ws");
  }

  prepareWorkspace(conversationId: string): string {
    const dir = this.workspaceHostPath(conversationId);
    fs.mkdirSync(path.win32.join(dir, ".run"), { recursive: true });
    this.cleanupOld();
    return dir;
  }

  /**
   * Delete conversation workspaces older than the TTL. Throttled (≤ once/10 min)
   * since it scans the share over UNC. Guarded: only ever removes direct
   * children of the sandbox root.
   */
  private cleanupOld(): void {
    const now = Date.now();
    if (now - lastCleanup < 10 * 60 * 1000) return;
    lastCleanup = now;
    const root = path.win32.resolve(this.sandboxRootHostPath());
    try {
      if (!fs.existsSync(root)) return;
      for (const name of fs.readdirSync(root)) {
        const p = path.win32.resolve(root, name);
        if (!p.startsWith(root + path.win32.sep)) continue; // guard
        try {
          const st = fs.statSync(p);
          if (st.isDirectory() && now - st.mtimeMs > config.sandbox.ttlMs) {
            fs.rmSync(p, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  deleteSandbox(conversationId: string): void {
    const root = path.win32.resolve(this.sandboxRootHostPath());
    // remove the whole per-conversation dir (ws/ + sys.img)
    const dir = path.win32.resolve(this.convDirHostPath(conversationId));
    // guard: only ever delete inside the sandbox root
    if (!dir.startsWith(root + path.win32.sep) || dir === root) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  runCode(
    conversationId: string,
    language: "python" | "bash",
    code: string,
  ): Promise<RunResult> {
    return withConvLock(safeConvId(conversationId), () =>
      this.runCodeInner(conversationId, language, code),
    );
  }

  private async runCodeInner(
    conversationId: string,
    language: "python" | "bash",
    code: string,
  ): Promise<RunResult> {
    const dir = this.prepareWorkspace(conversationId);
    const runDir = path.win32.join(dir, ".run");
    // The VM may keep running in the background after the foreground window, so
    // give it the long ceiling; the 10s foreground cutoff is handled by the
    // caller (grok/responses.ts), not here.
    const timeoutMs = this.cfg.maxRunMs;
    const cap = config.sandbox.maxOutputChars;

    // hand the job to the guest
    try {
      fs.writeFileSync(
        path.win32.join(runDir, "in.json"),
        JSON.stringify({ language, code, timeoutMs, maxOutputChars: cap }),
      );
      fs.rmSync(path.win32.join(runDir, "out.json"), { force: true });
    } catch (e) {
      return emptyResult({ error: `failed to stage job: ${String(e)}` });
    }

    const start = Date.now();
    await acquireVmSlot(this.cfg.maxConcurrent);
    let boot: { error?: string; timedOut: boolean };
    try {
      boot = await this.bootVM(conversationId, timeoutMs);
    } finally {
      releaseVmSlot();
    }
    if (boot.error) return emptyResult({ error: boot.error });

    // read the guest's result
    let out: {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      durationMs?: number;
      timedOut?: boolean;
    };
    try {
      out = JSON.parse(
        fs.readFileSync(path.win32.join(runDir, "out.json"), "utf-8"),
      );
    } catch {
      const serial = this.tail(path.win32.join(runDir, "serial.log"), 800);
      return emptyResult({
        error: `microVM produced no result${serial ? ` — serial tail:\n${serial}` : ""}`,
        timedOut: boot.timedOut,
        durationMs: Date.now() - start,
      });
    }

    return {
      stdout: (out.stdout ?? "").slice(0, cap),
      stderr: (out.stderr ?? "").slice(0, cap),
      exitCode: out.exitCode ?? null,
      durationMs: out.durationMs ?? Date.now() - start,
      timedOut: Boolean(out.timedOut) || boot.timedOut,
      files: listFiles(dir, start),
    };
  }

  async cloneRepo(
    conversationId: string,
    repoUrl: string,
  ): Promise<CloneResult> {
    const url = normalizeRepoUrl(repoUrl);
    if (!url) {
      return { ok: false, dir: "", tree: "", error: `invalid repo: ${repoUrl}` };
    }
    const base = repoDirName(url);
    // clone inside the VM (it has NAT egress); shell-quote the URL safely.
    const q = `'${url.replace(/'/g, "'\\''")}'`;
    const script = `rm -rf ${base} && git clone --depth 1 ${q} ${base} 2>&1`;
    const r = await this.runCode(conversationId, "bash", script);
    if ((r.exitCode ?? 1) !== 0) {
      return {
        ok: false,
        dir: base,
        tree: "",
        error: (r.stdout || r.stderr || r.error || "git clone failed").slice(-600),
      };
    }
    const dest = path.win32.join(this.workspaceHostPath(conversationId), base);
    return { ok: true, dir: base, tree: cloneTree(dest, base) };
  }

  /** Invoke the WSL bridge to boot one microVM run; resolves when it exits. */
  private bootVM(
    conversationId: string,
    timeoutMs: number,
  ): Promise<{ error?: string; timedOut: boolean }> {
    const timeoutSec = Math.ceil(timeoutMs / 1000);
    // Invoke the ROOT-OWNED bridge via a single scoped sudo rule (install.sh
    // installs /usr/local/sbin/llm-vm-run and grants NOPASSWD for only it), so
    // no bare privileged commands are exposed to the unprivileged user.
    const args = [
      "-d",
      this.cfg.wslDistro,
      "--",
      "sudo",
      "-n",
      "/usr/local/sbin/llm-vm-run",
      safeConvId(conversationId),
      String(this.cfg.vcpus),
      String(this.cfg.memMiB),
      String(timeoutSec),
      String(this.cfg.systemDiskGiB),
    ];
    // hard wall-clock cap on the bridge itself (guest timeout + boot/teardown margin)
    const hardMs = timeoutMs + 40000;

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn("wsl.exe", args, { windowsHide: true });
      } catch (e) {
        resolve({ error: `failed to launch WSL: ${String(e)}`, timedOut: false });
        return;
      }
      let stderr = "";
      child.stderr?.on("data", (d) => {
        if (stderr.length < 4000) stderr += d.toString();
      });
      child.on("error", (err) => {
        resolve({
          error:
            err instanceof Error && "code" in err && err.code === "ENOENT"
              ? "wsl.exe not found — is WSL2 installed?"
              : String(err),
          timedOut: false,
        });
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        resolve({
          error: "microVM run exceeded hard time limit (killed)",
          timedOut: true,
        });
      }, hardMs);
      child.on("close", () => {
        clearTimeout(timer);
        resolve({ timedOut: false });
      });
    });
  }

  private tail(file: string, chars: number): string {
    try {
      const s = fs.readFileSync(file, "utf-8");
      return s.slice(-chars);
    } catch {
      return "";
    }
  }
}
