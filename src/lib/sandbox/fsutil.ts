import fs from "node:fs";
import path from "node:path";
import type { RunResult, SandboxFile } from "./driver";

/** Heuristic: a file is "text" if its first 4KB contains no null byte. */
export function looksTextual(file: string): boolean {
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

/** List user-facing files in a workspace, newest-modified since `since` first. */
export function listFiles(dir: string, since: number): SandboxFile[] {
  const out: SandboxFile[] = [];
  const walk = (d: string, prefix: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith("__script_")) continue;
      if (entry.name === ".skills") continue; // mounted skill bundles, not user files
      if (entry.name === ".convert") continue; // cached format conversions
      if (entry.name === ".run") continue; // microVM control-channel dir
      if (entry.name === ".venv") continue; // persistent pip venv
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

export function emptyResult(extra: Partial<RunResult>): RunResult {
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

/** Build a compact top-level tree (2 levels) of a freshly cloned repo. */
export function cloneTree(repoDir: string, base: string): string {
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

/** process.env with our pyboot dir on PYTHONPATH (CJK font auto-embed for python). */
export function pybootEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const bootDir = path.join(process.cwd(), "src", "lib", "sandbox", "pyboot");
  env.PYTHONPATH = env.PYTHONPATH
    ? `${bootDir}${path.delimiter}${env.PYTHONPATH}`
    : bootDir;
  return env;
}
