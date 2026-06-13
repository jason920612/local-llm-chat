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

function resolveCmd(language: "python" | "bash"): string {
  if (language === "python") {
    return process.platform === "win32" ? "python" : "python3";
  }
  return "bash";
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

  const cmd = resolveCmd(language);
  const start = Date.now();

  return new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      // Pass the program on stdin (python/bash both read it). Avoids writing a
      // script file and the Windows->WSL path issues that breaks file-path bash.
      child = spawn(cmd, [], { cwd: dir, windowsHide: true });
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
    }, config.sandbox.timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
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
}

export interface CloneResult {
  ok: boolean;
  dir: string; // path relative to the workspace (e.g. "repo")
  tree: string; // top-level file/dir listing
  error?: string;
}

/** Normalize user-supplied repo references into a clonable git URL. */
function normalizeRepoUrl(input: string): string | null {
  const url = input.trim();
  if (!url) return null;
  // Full URL (https / git / ssh) — accept as-is.
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(url)) return url;
  // "owner/repo" shorthand → GitHub https.
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  return null;
}

/** Shallow-clone a git repo into the conversation sandbox; return its tree. */
export async function cloneRepo(
  conversationId: string,
  repoUrl: string,
): Promise<CloneResult> {
  cleanupOld();
  const url = normalizeRepoUrl(repoUrl);
  if (!url) {
    return { ok: false, dir: "", tree: "", error: `invalid repo: ${repoUrl}` };
  }
  const dir = workspaceDir(conversationId);
  fs.mkdirSync(dir, { recursive: true });

  // Derive a safe destination folder name from the repo.
  const base =
    (url.split(/[/]/).pop() || "repo")
      .replace(/\.git$/, "")
      .replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
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
      child = spawn(
        "git",
        ["clone", "--depth", "1", url, base],
        { cwd: dir, windowsHide: true },
      );
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
    // Cloning can take a while; allow up to 2 minutes.
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("close", (exitCode) => {
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
      resolve({ ok: true, dir: base, tree: cloneTree(dest, base) });
    });
  });
}

/** Build a compact top-level tree (2 levels) of a freshly cloned repo. */
function cloneTree(repoDir: string, base: string): string {
  const lines: string[] = [`${base}/`];
  const walk = (d: string, prefix: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((e) => e.name !== ".git")
      .sort((a, b) =>
        a.isDirectory() === b.isDirectory()
          ? a.name.localeCompare(b.name)
          : a.isDirectory()
            ? -1
            : 1,
      )
      .slice(0, 40);
    for (const e of entries) {
      lines.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && depth > 0) {
        walk(path.join(d, e.name), `${prefix}  `, depth - 1);
      }
    }
  };
  walk(repoDir, "  ", 1);
  return lines.slice(0, 120).join("\n");
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

/** Write uploaded files into a conversation's sandbox workspace. */
export function writeSandboxFiles(
  conversationId: string,
  files: { name: string; buffer: Buffer }[],
): SandboxFile[] {
  cleanupOld();
  const dir = workspaceDir(conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const out: SandboxFile[] = [];
  for (const f of files) {
    const base = (f.name.split(/[\\/]/).pop() || "file").replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    const target = path.join(dir, base);
    if (!path.resolve(target).startsWith(path.resolve(dir))) continue;
    fs.writeFileSync(target, f.buffer);
    out.push({
      name: base,
      size: f.buffer.length,
      isText: looksTextual(target),
    });
  }
  return out;
}

/** List every file currently in a conversation's sandbox workspace. */
export function listSandboxFiles(conversationId: string): SandboxFile[] {
  const dir = workspaceDir(conversationId);
  if (!fs.existsSync(dir)) return [];
  return listFiles(dir, 0);
}

/** Build a minimal ustar tar header (512 bytes) for one file. */
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf-8");
  h.write("0000644\0", 100); // mode
  h.write("0000000\0", 108); // uid
  h.write("0000000\0", 116); // gid
  h.write(size.toString(8).padStart(11, "0") + "\0", 124); // size (octal)
  h.write(
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + "\0",
    136,
  ); // mtime
  h.write("        ", 148); // checksum placeholder (8 spaces)
  h.write("0", 156); // typeflag: regular file
  h.write("ustar\0", 257);
  h.write("00", 263); // version
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148); // checksum
  return h;
}

/** Pack the selected sandbox files into a tar archive (Buffer). */
export function packTar(conversationId: string, names: string[]): Buffer {
  const dir = workspaceDir(conversationId);
  const root = path.resolve(dir);
  const parts: Buffer[] = [];
  for (const name of names) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(root)) continue;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
    const data = fs.readFileSync(target);
    parts.push(tarHeader(name, data.length));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive: two zero blocks
  return Buffer.concat(parts);
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
