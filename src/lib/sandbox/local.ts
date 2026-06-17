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
import { listFiles, emptyResult, cloneTree, pybootEnv } from "./fsutil";

/**
 * LocalProcessDriver — the original backend. Runs python/bash directly on the
 * host with the server's permissions, confined only to a per-conversation cwd.
 * This is workspace isolation + TTL, NOT a security boundary.
 */
export class LocalProcessDriver implements SandboxDriver {
  readonly name = "local" as const;
  private readonly root = path.join(process.cwd(), "data", "sandboxes");

  sandboxRootHostPath(): string {
    return this.root;
  }

  workspaceHostPath(conversationId: string): string {
    return path.join(this.root, safeConvId(conversationId));
  }

  prepareWorkspace(conversationId: string): string {
    this.cleanupOld();
    const dir = this.workspaceHostPath(conversationId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  deleteSandbox(conversationId: string): void {
    try {
      fs.rmSync(this.workspaceHostPath(conversationId), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ignore */
    }
  }

  /** Delete sandbox workspaces older than the TTL. */
  private cleanupOld(): void {
    try {
      if (!fs.existsSync(this.root)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(this.root)) {
        const p = path.join(this.root, name);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs > config.sandbox.ttlMs) {
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

  async runCode(
    conversationId: string,
    language: "python" | "bash",
    code: string,
    opts?: { timeoutMs?: number; jobId?: string },
  ): Promise<RunResult> {
    this.cleanupOld();
    const dir = this.workspaceHostPath(conversationId);
    fs.mkdirSync(dir, { recursive: true });

    const cmd =
      language === "python"
        ? process.platform === "win32"
          ? "python"
          : "python3"
        : "bash";
    const start = Date.now();
    const env = language === "python" ? pybootEnv() : { ...process.env };

    return new Promise<RunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let child;
      try {
        // Pass the program on stdin (python/bash both read it). Avoids writing a
        // script file and the Windows->WSL path issues that break file-path bash.
        child = spawn(cmd, [], { cwd: dir, windowsHide: true, env });
      } catch {
        resolve(emptyResult({ error: `${cmd} not found` }));
        return;
      }

      const cap = config.sandbox.maxOutputChars;
      child.stdout.on("data", (d) => {
        if (stdout.length < cap) stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < cap) stderr += d.toString();
      });
      child.on("error", (err) => {
        resolve(
          emptyResult({
            error:
              err instanceof Error && "code" in err && err.code === "ENOENT"
                ? `${cmd} not found on this machine`
                : String(err),
          }),
        );
      });

      try {
        child.stdin.write(code);
        child.stdin.end();
      } catch {
        /* child may have failed to spawn; error handler covers it */
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts?.timeoutMs ?? config.sandbox.timeoutMs);

      child.on("close", async (exitCode) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, cap),
          stderr: stderr.slice(0, cap),
          exitCode,
          durationMs: Date.now() - start,
          timedOut,
          files: await listFiles(dir, start),
        });
      });
    });
  }

  async cloneRepo(
    conversationId: string,
    repoUrl: string,
  ): Promise<CloneResult> {
    this.cleanupOld();
    const url = normalizeRepoUrl(repoUrl);
    if (!url) {
      return { ok: false, dir: "", tree: "", error: `invalid repo: ${repoUrl}` };
    }
    const dir = this.workspaceHostPath(conversationId);
    fs.mkdirSync(dir, { recursive: true });

    const base = repoDirName(url);
    const dest = path.join(dir, base);
    // Re-clone fresh to avoid stale state / "already exists" errors.
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    return new Promise<CloneResult>((resolve) => {
      let stderr = "";
      let child;
      try {
        child = spawn("git", ["clone", "--depth", "1", url, base], {
          cwd: dir,
          windowsHide: true,
        });
      } catch {
        resolve({ ok: false, dir: base, tree: "", error: "git not found" });
        return;
      }
      child.stderr.on("data", (d) => {
        if (stderr.length < 8000) stderr += d.toString();
      });
      child.on("error", (err) => {
        resolve({
          ok: false,
          dir: base,
          tree: "",
          error:
            err instanceof Error && "code" in err && err.code === "ENOENT"
              ? "git not found on this machine"
              : String(err),
        });
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
      child.on("close", async (exitCode) => {
        clearTimeout(timer);
        if (exitCode !== 0) {
          resolve({
            ok: false,
            dir: base,
            tree: "",
            error: stderr.slice(-600) || `git clone exited ${exitCode}`,
          });
          return;
        }
        resolve({ ok: true, dir: base, tree: await cloneTree(dest, base) });
      });
    });
  }
}
