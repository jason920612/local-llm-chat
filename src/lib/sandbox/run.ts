import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import {
  type SandboxDriver,
  type SandboxFile,
  type RunResult,
  type CloneResult,
} from "./driver";
import { LocalProcessDriver } from "./local";
import { MicroVMDriver } from "./microvm";
import { listFiles, looksTextual, pybootEnv } from "./fsutil";

// Re-export the shared types so existing callers keep importing them from here.
export type { SandboxFile, RunResult, CloneResult };

const SKILLS_ROOT = path.join(process.cwd(), "skills");

/**
 * Active sandbox backend, selected by `config.sandbox.driver`. Cached on the
 * global so it survives Next.js hot reloads. The MicroVMDriver is imported
 * lazily so the `local` path never pulls in WSL-specific code.
 */
const globalForDriver = globalThis as unknown as {
  __llmSandboxDriver?: SandboxDriver;
};

function getDriver(): SandboxDriver {
  if (globalForDriver.__llmSandboxDriver) return globalForDriver.__llmSandboxDriver;
  const driver: SandboxDriver =
    config.sandbox.driver === "microvm"
      ? new MicroVMDriver()
      : new LocalProcessDriver();
  globalForDriver.__llmSandboxDriver = driver;
  return driver;
}

/** Host-side path to a conversation's workspace (driver-dependent). */
function workspaceDir(conversationId: string): string {
  return getDriver().workspaceHostPath(conversationId);
}

// --- Execution (delegated to the active driver) ----------------------------

/** Execute model-written code in the conversation's sandbox workspace. */
export function runCode(
  conversationId: string,
  language: "python" | "bash",
  code: string,
): Promise<RunResult> {
  return getDriver().runCode(conversationId, language, code);
}

/** Shallow-clone a git repo into the conversation sandbox; return its tree. */
export function cloneRepo(
  conversationId: string,
  repoUrl: string,
): Promise<CloneResult> {
  return getDriver().cloneRepo(conversationId, repoUrl);
}

/** Ensure a conversation's sandbox workspace exists; return its absolute path. */
export function prepareWorkspace(conversationId: string): string {
  return getDriver().prepareWorkspace(conversationId);
}

/** Remove a conversation's sandbox (called when the conversation is deleted). */
export function deleteSandbox(conversationId: string): void {
  getDriver().deleteSandbox(conversationId);
}

/** process.env with our pyboot dir on PYTHONPATH (used by host-run background jobs). */
export function sandboxEnv(): NodeJS.ProcessEnv {
  return pybootEnv();
}

// --- Host-side file operations (act on the workspace dir directly) ----------

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

    const dir = prepareWorkspace(conversationId);
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
  const dir = prepareWorkspace(conversationId);
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
