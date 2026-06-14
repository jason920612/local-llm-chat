import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

const SANDBOX_ROOT = path.join(process.cwd(), "data", "sandboxes");
const SKILLS_ROOT = path.join(process.cwd(), "skills");

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

/**
 * Copy a skill's whole folder (SKILL.md + bundled scripts/resources) into the
 * conversation sandbox at `.skills/<name>/`, so run_code can execute its scripts.
 * Returns the relative mount path, or null if the skill folder doesn't exist.
 */
export function mountSkill(
  conversationId: string,
  name: string,
): string | null {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return null;
  const src = path.join(SKILLS_ROOT, safe);
  try {
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return null;
    const dir = workspaceDir(conversationId);
    const destRel = `.skills/${safe}`;
    const dest = path.join(dir, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    return destRel;
  } catch {
    return null;
  }
}

/** Locate the LibreOffice CLI (for converting office docs to PDF for preview). */
function sofficeBin(): string {
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/LibreOffice/program/soffice.exe",
          "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
        ]
      : ["/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice"];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "soffice"; // fall back to PATH
}

/**
 * Convert an office file (pptx/docx/xlsx/odp…) in the sandbox to PDF via
 * LibreOffice, for in-app preview. Returns the PDF bytes, or null if LibreOffice
 * isn't available / conversion failed. Result is cached under .convert/.
 */
export async function convertToPdf(
  conversationId: string,
  name: string,
): Promise<Buffer | null> {
  const dir = workspaceDir(conversationId);
  const src = path.resolve(dir, name);
  if (!src.startsWith(path.resolve(dir)) || !fs.existsSync(src)) return null;
  const outDir = path.join(dir, ".convert");
  fs.mkdirSync(outDir, { recursive: true });
  const pdfPath = path.join(
    outDir,
    (path.basename(name).replace(/\.[^.]+$/, "") || "out") + ".pdf",
  );
  try {
    // Reuse a fresh-enough cached conversion.
    if (
      fs.existsSync(pdfPath) &&
      fs.statSync(pdfPath).mtimeMs >= fs.statSync(src).mtimeMs
    ) {
      return fs.readFileSync(pdfPath);
    }
  } catch {
    /* ignore */
  }

  return new Promise<Buffer | null>((resolve) => {
    let child;
    try {
      child = spawn(
        sofficeBin(),
        ["--headless", "--convert-to", "pdf", "--outdir", outDir, src],
        { windowsHide: true },
      );
    } catch {
      resolve(null);
      return;
    }
    child.on("error", () => resolve(null));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 120000);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Ensure a conversation's sandbox workspace exists; return its absolute path. */
export function prepareWorkspace(conversationId: string): string {
  cleanupOld();
  const dir = workspaceDir(conversationId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** process.env with our pyboot dir on PYTHONPATH (CJK font auto-embed for python). */
export function sandboxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const bootDir = path.join(process.cwd(), "src", "lib", "sandbox", "pyboot");
  env.PYTHONPATH = env.PYTHONPATH
    ? `${bootDir}${path.delimiter}${env.PYTHONPATH}`
    : bootDir;
  return env;
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
      if (entry.name === ".skills") continue; // mounted skill bundles, not user files
      if (entry.name === ".convert") continue; // cached format conversions
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

  // For Python, prepend our pyboot dir to PYTHONPATH so sitecustomize.py auto-loads
  // (it transparently embeds a CJK TTF when reportlab's CID fonts are used).
  const env = { ...process.env };
  if (language === "python") {
    const bootDir = path.join(process.cwd(), "src", "lib", "sandbox", "pyboot");
    env.PYTHONPATH = env.PYTHONPATH
      ? `${bootDir}${path.delimiter}${env.PYTHONPATH}`
      : bootDir;
  }

  return new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      // Pass the program on stdin (python/bash both read it). Avoids writing a
      // script file and the Windows->WSL path issues that breaks file-path bash.
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

/** Map a MIME type to a file extension. */
function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime")) return "mov";
  return "";
}

/** Best-effort extension from a URL path (ignores query string). */
function extFromUrl(url: string): string {
  const m = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Save a generated media item (http(s) URL or data: URI) into a conversation's
 * sandbox workspace, so it shows up in the file explorer, downloads, and is usable
 * by run_code. Returns the file meta, or null on failure. `baseName` has no ext.
 */
export async function saveMediaToSandbox(
  conversationId: string,
  src: string,
  baseName: string,
  fallbackExt = "bin",
): Promise<SandboxFile | null> {
  try {
    let buffer: Buffer;
    let ext = "";
    if (src.startsWith("data:")) {
      const m = src.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
      if (!m) return null;
      buffer = Buffer.from(m[3], m[2] ? "base64" : "utf-8");
      ext = extFromMime(m[1] || "");
    } else {
      const res = await fetch(src);
      if (!res.ok) return null;
      buffer = Buffer.from(await res.arrayBuffer());
      ext = extFromMime(res.headers.get("content-type") || "") || extFromUrl(src);
    }
    if (!ext) ext = fallbackExt;

    const dir = workspaceDir(conversationId);
    fs.mkdirSync(dir, { recursive: true });
    let name = `${baseName}.${ext}`;
    let i = 1;
    while (fs.existsSync(path.join(dir, name))) name = `${baseName}_${i++}.${ext}`;
    const target = path.join(dir, name);
    if (!path.resolve(target).startsWith(path.resolve(dir))) return null;
    fs.writeFileSync(target, buffer);
    return { name, size: buffer.length, isText: false };
  } catch {
    return null;
  }
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
