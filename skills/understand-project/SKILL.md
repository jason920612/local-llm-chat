---
name: understand-project
description: Build a thorough mental model of a software project / codebase — its purpose, tech stack, architecture, entry points, how to build & run it, key modules and data flow. Use when asked to understand, explain, analyze, audit, review, or onboard onto a project or repository.
---

# Understand a project

Go top-down: orient from the project's own metadata first, then drill into the
parts that matter — don't read every file. If the project is a GitHub repo, first
use the **clone-github** skill to get it locally; for all searching use the
**explore-codebase** skill (grep / git grep, targeted line reads).

## Procedure

1. **Orient (read these first):**
   ```bash
   sed -n '1,80p' README* 2>/dev/null
   cat package.json pyproject.toml setup.py go.mod Cargo.toml pom.xml build.gradle composer.json 2>/dev/null | head -120
   ls -la && find . -maxdepth 2 -type d -not -path '*/.git*' | head -60
   ```
   From these determine: purpose, language(s), framework, dependencies, scripts,
   and how to build/run/test.

2. **Find the entry points & wiring:**
   - App entry (main, index, app, cmd/, src/main, server) and routing/registration.
   - Config & env (`.env.example`, config files), and where settings are read.
   ```bash
   grep -rniE "def main|func main|if __name__|createServer|listen\(|app = |fastapi|express|next" --include=*.{py,js,ts,go,rs,java} . | head -30
   ```

3. **Map the structure:** identify the main modules/layers (e.g. api/ ui/ db/
   services/ lib/), the data model (schemas/models/migrations), and external
   integrations (APIs, DB, queues). Note tests/ and CI (.github/workflows).

4. **Trace one real flow end-to-end** (e.g. a request from route → handler →
   service → data layer, or a CLI command from arg-parse → action). This reveals
   the actual architecture better than any single file.

5. **Synthesize** a clear summary:
   - What it is & does; tech stack.
   - How to build / run / test (exact commands).
   - Architecture: main components and how they interact (a `mermaid` diagram via
     create_artifact is great here).
   - Key files/dirs (with `path:line` references) and where to change common things.
   - Notable risks / TODOs / rough edges you noticed.

## Rules
- Reply in the user's language. Be concrete: cite real files and line numbers
  (`src/x.ts:42`), don't hand-wave.
- Tree-structured search only (grep/git grep) — never read every file.
- Answer from what you actually read; if something isn't in the repo, say so.
- For a binary/compiled artifact rather than source, use the
  **reverse-engineer-binary** skill instead.
