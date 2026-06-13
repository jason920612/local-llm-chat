import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

const SANDBOX_ROOT = path.join(process.cwd(), "data", "sandboxes");

export interface SandboxFile {
  name: string;
  size: number;
  isText: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  files: SandboxFile[];
  error?: string;
}

/** Confine a conversation id to a safe directory name. */
function workspaceDir(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return path.join(SANDBOX_ROOT, safe || "default");
}

/** Delete sandbox workspaces older than the TTL. */
function cleanupOld(): void {
  try {
    if (!fs.existsSync(SANDBOX_ROOT)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(SANDBOX_ROOT)) {
      const p = path.join(SANDBOX_ROOT, name);
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

/** Remove a conversation's sandbox (called when the conversation is deleted). */
export function deleteSandbox(conversationId: string): void {
  try {
    fs.rmSync(workspaceDir(conversationId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function looksTextual(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return false; // null byte → binary
    return true;
  } catch {
    return false;
  }
}

function listFiles(dir: string, since: number): SandboxFile[] {
  const out: SandboxFile[] = [];
  const walk = (d: string, prefix: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith("__script_")) continue;
      const full = path.join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        const st = fs.statSync(full);
        if (st.mtimeMs >= since - 50) {
          out.push({ name: rel, size: st.size, isText: looksTextual(full) });
        }
      }
    }
  };
  try {
    walk(dir, "");
  } catch {
    /* ignore */
  }
  return out.slice(0, 50);
}

function resolveCmd(language: "python" | "bash"): {
  cmd: string;
  ext: string;
} | null {
  if (language === "python") {
    return { cmd: process.platform === "win32" ? "python" : "python3", ext: "py" };
  }
  return { cmd: "bash", ext: "sh" };
}

/** Execute model-written code in the conversation's sandbox workspace. */
export async function runCode(
  conversationId: string,
  language: "python" | "bash",
  code: string,
): Promise<RunResult> {
  cleanupOld();
  const dir = workspaceDir(conversationId);
  fs.mkdirSync(dir, { recursive: true });

  const resolved = resolveCmd(language);
  if (!resolved) {
    return emptyResult({ error: `Unsupported language: ${language}` });
  }
  const scriptPath = path.join(dir, `__script_${Date.now()}.${resolved.ext}`);
  fs.writeFileSync(scriptPath, code, "utf-8");

  const start = Date.now();
  const result = await new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(resolved.cmd, [scriptPath], {
        cwd: dir,
        windowsHide: true,
      });
    } catch {
      resolve(emptyResult({ error: `${resolved.cmd} not found` }));
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
              ? `${resolved.cmd} not found on this machine`
              : String(err),
        }),
      );
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.sandbox.timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      try {
        fs.rmSync(scriptPath, { force: true });
      } catch {
        /* ignore */
      }
      resolve({
        stdout: stdout.slice(0, cap),
        stderr: stderr.slice(0, cap),
        exitCode,
        durationMs: Date.now() - start,
        timedOut,
        files: listFiles(dir, start),
      });
    });
  });

  return result;
}

function emptyResult(extra: Partial<RunResult>): RunResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    files: [],
    ...extra,
  };
}

/** Read a file from a conversation's sandbox (with path-traversal guard). */
export function readSandboxFile(
  conversationId: string,
  name: string,
): { buffer: Buffer; isText: boolean } | null {
  const dir = workspaceDir(conversationId);
  const target = path.resolve(dir, name);
  if (!target.startsWith(path.resolve(dir))) return null; // traversal guard
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return { buffer: fs.readFileSync(target), isText: looksTextual(target) };
}
