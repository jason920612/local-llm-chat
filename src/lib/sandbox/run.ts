import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import {
  type SandboxDriver,
  type SandboxFile,
  type RunResult,
  type CloneResult,
  type ActionSequence,
  type ActionSequenceResult,
  type ComputerObservation,
  type BrowserActionResult,
  type BrowserObservation,
  type WatchVideoOptions,
  type WatchVideoResult,
  type InspectVideoMomentsOptions,
  type InspectVideoMomentsResult,
  type LookCloserOptions,
  type LookCloserResult,
} from "./driver";
import { LocalProcessDriver } from "./local";
import { MicroVMDriver } from "./microvm";
import { listFiles, pybootEnv } from "./fsutil";

// Re-export the shared types so existing callers keep importing them from here.
export type {
  SandboxFile,
  RunResult,
  CloneResult,
  ActionSequence,
  ActionSequenceResult,
  ComputerObservation,
  BrowserActionResult,
  BrowserObservation,
  WatchVideoOptions,
  WatchVideoResult,
  InspectVideoMomentsOptions,
  InspectVideoMomentsResult,
  LookCloserOptions,
  LookCloserResult,
};

const fsp = fs.promises;
const SKILLS_ROOT = path.join(process.cwd(), "skills");

/** Text heuristic straight off a buffer (no extra fs read): no null in first 4KB. */
function bufferLooksTextual(buf: Buffer): boolean {
  return !buf.subarray(0, 4096).includes(0);
}

/** Async path-exists check (the workspace may live on a slow WSL UNC share). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

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
  opts?: { timeoutMs?: number; jobId?: string },
): Promise<RunResult> {
  return getDriver().runCode(conversationId, language, code, opts);
}

/** Force-stop the run currently executing for a conversation (VM bg kill). */
export function killSandboxRun(conversationId: string, jobId?: string): boolean {
  return getDriver().killRun?.(conversationId, jobId) ?? false;
}

/** Host-side path to a conversation's workspace (for tailing a bg job log). */
export function sandboxWorkspacePath(conversationId: string): string {
  return workspaceDir(conversationId);
}

/** True when the active sandbox backend runs each job in its own microVM. */
export function isMicrovmSandbox(): boolean {
  return getDriver().name === "microvm";
}

/** Observe the isolated virtual display for this conversation's microVM. */
export function computerObserve(
  conversationId: string,
  opts?: {
    includeScreenshot?: boolean;
    ocr?: boolean;
    mark?: boolean;
    remark?: boolean;
    caption?: boolean;
  },
): Promise<ComputerObservation> {
  const driver = getDriver();
  if (!driver.computerObserve) {
    return Promise.resolve({
      ok: false,
      windows: [],
      elements: [],
      error: "computer use requires the microVM sandbox driver",
    });
  }
  return driver.computerObserve(conversationId, opts);
}

/** Run a GUI action program (step sequence) on the isolated virtual display. */
export function computerAction(
  conversationId: string,
  seq: ActionSequence,
): Promise<ActionSequenceResult> {
  const driver = getDriver();
  if (!driver.computerAction) {
    return Promise.resolve({
      ok: false,
      steps: [],
      error: "computer use requires the microVM sandbox driver",
    });
  }
  return driver.computerAction(conversationId, seq);
}

export function browserOpenUrl(
  conversationId: string,
  url: string,
): Promise<BrowserActionResult> {
  const driver = getDriver();
  if (!driver.browserOpenUrl) {
    return Promise.resolve({
      ok: false,
      action: "browser_open_url",
      durationMs: 0,
      error: "browser computer use requires the microVM sandbox driver",
    });
  }
  return driver.browserOpenUrl(conversationId, url);
}

export function browserObserve(
  conversationId: string,
  opts?: {
    includeScreenshot?: boolean;
    mark?: boolean;
    remark?: boolean;
    caption?: boolean;
  },
): Promise<BrowserObservation> {
  const driver = getDriver();
  if (!driver.browserObserve) {
    return Promise.resolve({
      ok: false,
      windows: [],
      elements: [],
      error: "browser computer use requires the microVM sandbox driver",
    });
  }
  return driver.browserObserve(conversationId, opts);
}

export function lookCloser(
  conversationId: string,
  opts: LookCloserOptions,
): Promise<LookCloserResult> {
  const driver = getDriver();
  if (!driver.lookCloser) {
    return Promise.resolve({
      ok: false,
      error: "look_closer requires the microVM sandbox driver",
    });
  }
  return driver.lookCloser(conversationId, opts);
}

export function watchVideo(
  conversationId: string,
  opts: WatchVideoOptions,
): Promise<WatchVideoResult> {
  const driver = getDriver();
  if (!driver.watchVideo) {
    return Promise.resolve({
      ok: false,
      frames: [],
      error: "watch_video requires the microVM sandbox driver",
    });
  }
  return driver.watchVideo(conversationId, opts);
}

export function inspectVideoMoments(
  conversationId: string,
  opts: InspectVideoMomentsOptions,
): Promise<InspectVideoMomentsResult> {
  const driver = getDriver();
  if (!driver.inspectVideoMoments) {
    return Promise.resolve({
      ok: false,
      frames: [],
      error: "inspect_video_moments requires the microVM sandbox driver",
    });
  }
  return driver.inspectVideoMoments(conversationId, opts);
}

export function browserAction(
  conversationId: string,
  seq: ActionSequence,
): Promise<ActionSequenceResult> {
  const driver = getDriver();
  if (!driver.browserAction) {
    return Promise.resolve({
      ok: false,
      steps: [],
      error: "browser computer use requires the microVM sandbox driver",
    });
  }
  return driver.browserAction(conversationId, seq);
}

/**
 * Refresh the live VM Console heartbeat. The guest daemon's capture loop only
 * grabs frames while `.run/computer/stream.on` is fresh, so the SSE route calls
 * this each tick; when subscribers leave, the file goes stale and capture stops.
 */
export function refreshScreenStream(conversationId: string): void {
  const dir = workspaceDir(conversationId);
  const cdir = path.join(dir, ".run", "computer");
  try {
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "stream.on"), String(Date.now()));
  } catch {
    /* ignore */
  }
}

/** Read the latest live VM Console frame (downscaled JPEG), or null if none yet. */
export async function readScreenFrame(
  conversationId: string,
): Promise<Buffer | null> {
  const dir = workspaceDir(conversationId);
  const p = path.join(dir, ".run", "computer", "screen-stream.jpg");
  try {
    return await fsp.readFile(p);
  } catch {
    return null;
  }
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
export async function mountSkill(
  conversationId: string,
  name: string,
): Promise<string | null> {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return null;
  const src = path.join(SKILLS_ROOT, safe);
  try {
    const st = await fsp.stat(src).catch(() => null);
    if (!st || !st.isDirectory()) return null;
    const dir = workspaceDir(conversationId);
    const destRel = `.skills/${safe}`;
    const dest = path.join(dir, destRel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.cp(src, dest, { recursive: true });
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
  if (!src.startsWith(path.resolve(dir))) return null;
  const srcStat = await fsp.stat(src).catch(() => null);
  if (!srcStat) return null;
  const outDir = path.join(dir, ".convert");
  await fsp.mkdir(outDir, { recursive: true });
  const pdfPath = path.join(
    outDir,
    (path.basename(name).replace(/\.[^.]+$/, "") || "out") + ".pdf",
  );
  try {
    // Reuse a fresh-enough cached conversion.
    const pdfStat = await fsp.stat(pdfPath).catch(() => null);
    if (pdfStat && pdfStat.mtimeMs >= srcStat.mtimeMs) {
      return await fsp.readFile(pdfPath);
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
    child.on("close", async () => {
      clearTimeout(timer);
      try {
        resolve(await fsp.readFile(pdfPath));
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
    while (await pathExists(path.join(dir, name))) {
      name = `${baseName}_${i++}.${ext}`;
    }
    const target = path.join(dir, name);
    if (!path.resolve(target).startsWith(path.resolve(dir))) return null;
    await fsp.writeFile(target, buffer);
    return { name, size: buffer.length, isText: false };
  } catch {
    return null;
  }
}

/** Write uploaded files into a conversation's sandbox workspace. */
export async function writeSandboxFiles(
  conversationId: string,
  files: { name: string; buffer: Buffer }[],
): Promise<SandboxFile[]> {
  const dir = prepareWorkspace(conversationId);
  const out: SandboxFile[] = [];
  for (const f of files) {
    const base = (f.name.split(/[\\/]/).pop() || "file").replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    const target = path.join(dir, base);
    if (!path.resolve(target).startsWith(path.resolve(dir))) continue;
    await fsp.writeFile(target, f.buffer);
    out.push({
      name: base,
      size: f.buffer.length,
      isText: bufferLooksTextual(f.buffer),
    });
  }
  return out;
}

/** List every file currently in a conversation's sandbox workspace. */
export async function listSandboxFiles(
  conversationId: string,
): Promise<SandboxFile[]> {
  const dir = workspaceDir(conversationId);
  try {
    await fs.promises.access(dir);
  } catch {
    return []; // workspace doesn't exist yet
  }
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
export async function packTar(
  conversationId: string,
  names: string[],
): Promise<Buffer> {
  const dir = workspaceDir(conversationId);
  const root = path.resolve(dir);
  const parts: Buffer[] = [];
  for (const name of names) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(root)) continue;
    const st = await fsp.stat(target).catch(() => null);
    if (!st || !st.isFile()) continue;
    const data = await fsp.readFile(target);
    parts.push(tarHeader(name, data.length));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive: two zero blocks
  return Buffer.concat(parts);
}

/** Read a file from a conversation's sandbox (with path-traversal guard). */
export async function readSandboxFile(
  conversationId: string,
  name: string,
): Promise<{ buffer: Buffer; isText: boolean } | null> {
  const dir = workspaceDir(conversationId);
  const target = path.resolve(dir, name);
  if (!target.startsWith(path.resolve(dir))) return null; // traversal guard
  const st = await fsp.stat(target).catch(() => null);
  if (!st || !st.isFile()) return null;
  const buffer = await fsp.readFile(target);
  return { buffer, isText: bufferLooksTextual(buffer) };
}
