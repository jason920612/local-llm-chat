import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Claude-style "skills" framework.
 *
 * Each skill is a folder under `skills/<name>/SKILL.md` with YAML-ish frontmatter
 * (name + description) and a Markdown playbook body. The model first sees only the
 * compact list (name + one-line description) injected into the system prompt, then
 * loads a full playbook ON DEMAND via the `use_skill` tool. This keeps context
 * small while still teaching the model how to work efficiently (tree-structured
 * search, clone-before-explore, etc.).
 */

export interface Skill {
  name: string;
  description: string;
  /** Full Markdown playbook body (frontmatter stripped). */
  body: string;
}

const SKILLS_ROOT = path.join(process.cwd(), "skills");

/** Parse `---\nkey: value\n---\nbody` frontmatter. Tolerant of missing fields. */
function parseSkill(raw: string): { name: string; description: string; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: "", description: "", body: raw.trim() };
  const [, front, body] = m;
  const fields: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    name: fields.name ?? "",
    description: fields.description ?? "",
    body: body.trim(),
  };
}

/** Load every skill from the skills/ directory (empty array if none/unreadable). */
export function loadSkills(): Skill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(SKILLS_ROOT, entry.name, "SKILL.md");
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = parseSkill(raw);
      skills.push({
        name: parsed.name || entry.name,
        description: parsed.description,
        body: parsed.body,
      });
    } catch {
      /* skip folders without a readable SKILL.md */
    }
  }
  return skills;
}

/** Return one skill's full playbook by name, or null if not found. */
export function getSkill(name: string): Skill | null {
  const target = name.trim().toLowerCase();
  return loadSkills().find((s) => s.name.toLowerCase() === target) ?? null;
}

/** Compact list (name + description) for injection into the system prompt. */
export function skillsSummary(): { name: string; description: string }[] {
  return loadSkills().map(({ name, description }) => ({ name, description }));
}

export interface InstallResult {
  installed: string[];
  error?: string;
}

/** Parse an install source into a clone URL (+ optional branch / subdir). */
function parseSource(
  source: string,
): { url: string; branch?: string; subdir?: string } | null {
  const s = source.trim();
  // GitHub "tree" URL pointing at a folder: .../tree/<branch>/<subdir>
  const tree = s.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/,
  );
  if (tree) {
    return {
      url: `https://github.com/${tree[1]}/${tree[2]}`,
      branch: tree[3],
      subdir: tree[4],
    };
  }
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s)) {
    return { url: s.replace(/\/$/, "").replace(/\.git$/, "") + ".git" };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    return { url: `https://github.com/${s}` };
  }
  return null;
}

/** Find folders that contain a SKILL.md (don't recurse into a found skill). */
function findSkillDirs(root: string, depth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, dep: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      out.push(d);
      return;
    }
    if (dep <= 0) return;
    for (const e of entries) {
      if (e.isDirectory() && e.name !== ".git") walk(path.join(d, e.name), dep - 1);
    }
  };
  walk(root, depth);
  return out;
}

/**
 * Install skill(s) from a git repo (or a GitHub subfolder URL) into the skills/
 * library. Shallow-clones to a temp dir, copies every folder containing a
 * SKILL.md, and cleans up. Returns the installed skill names.
 */
export async function installSkill(source: string): Promise<InstallResult> {
  const parsed = parseSource(source);
  if (!parsed) return { installed: [], error: `invalid source: ${source}` };

  const tmp = path.join(os.tmpdir(), `skillinstall-${process.pid}-${Date.now()}`);
  try {
    await new Promise<void>((resolve, reject) => {
      const args = ["clone", "--depth", "1"];
      if (parsed.branch) args.push("-b", parsed.branch);
      args.push(parsed.url, tmp);
      let err = "";
      let child;
      try {
        child = spawn("git", args, { windowsHide: true });
      } catch {
        reject(new Error("git not found"));
        return;
      }
      child.stderr.on("data", (d) => {
        if (err.length < 4000) err += d.toString();
      });
      child.on("error", (e) =>
        reject(
          e instanceof Error && "code" in e && e.code === "ENOENT"
            ? new Error("git not found")
            : e,
        ),
      );
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("git clone timed out"));
      }, 120000);
      child.on("close", (code) => {
        clearTimeout(t);
        if (code === 0) resolve();
        else reject(new Error(err.slice(-400) || `git clone exited ${code}`));
      });
    });

    const searchRoot = parsed.subdir ? path.join(tmp, parsed.subdir) : tmp;
    if (!fs.existsSync(searchRoot)) {
      return { installed: [], error: "subfolder not found in repo" };
    }
    const dirs = findSkillDirs(searchRoot);
    if (dirs.length === 0) {
      return { installed: [], error: "no SKILL.md found in source" };
    }
    fs.mkdirSync(SKILLS_ROOT, { recursive: true });
    const installed: string[] = [];
    for (const dir of dirs) {
      const name = path.basename(dir).replace(/[^A-Za-z0-9_-]/g, "") || "skill";
      const dest = path.join(SKILLS_ROOT, name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(dir, dest, { recursive: true });
      installed.push(name);
    }
    return { installed };
  } catch (e) {
    return {
      installed: [],
      error: e instanceof Error ? e.message : "install failed",
    };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
