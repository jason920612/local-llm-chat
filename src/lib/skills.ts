import fs from "node:fs";
import path from "node:path";

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
