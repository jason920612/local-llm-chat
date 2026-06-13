---
name: explore-codebase
description: Efficiently explore a code/text repository in the sandbox using tree-structured search (grep/git grep) instead of reading every file. Use whenever you must find where something is defined, used, or configured across many files.
---

# Explore a codebase efficiently

You have a `run_code` tool with a bash shell (Git Bash on Windows). Tools that are
ALWAYS available: `grep`, `find`, `git`, `sed`, `awk`, `head`, `tail`, `wc`, `ls`.
`rg` (ripgrep) is NOT guaranteed — do not rely on it; use `grep -rn` instead.
NEVER read files one by one or dump whole files to find something — search first,
then read only the matching lines.

## Procedure

1. **Map the tree first — do not read files yet.**
   ```bash
   cd <repo-dir>
   ls -la
   find . -path ./.git -prune -o -type f -print | head -200   # the file list
   find . -maxdepth 2 -type d -not -path '*/.git*' | head -80  # dir layout
   ```

2. **Find by content with grep** (recursive, line numbers, the portable default):
   ```bash
   grep -rn "search_term" .                       # all matches with line numbers
   grep -rn --include='*.ts' --include='*.py' "term" .   # filter by extension
   grep -rln "term" .                             # just the file names
   grep -rn -C 3 "functionName" .                 # 3 lines of context per hit
   grep -rnE "class [A-Za-z_]+" .                 # extended regex
   grep -rn --exclude-dir=.git --exclude-dir=node_modules "term" .  # skip noise
   ```
   Inside a git repo prefer `git grep -n "term"` — it's faster and auto-skips
   .git / untracked junk. If `rg` happens to exist it's also fine, but grep is the
   safe default.

3. **Read ONLY the relevant slice**, never the whole file:
   ```bash
   sed -n '120,180p' path/to/file.ts    # lines 120-180
   grep -n "def main" -A 40 app.py       # the match plus 40 lines after
   ```

4. **Understand structure** before diving in: read the README, package.json /
   pyproject.toml / go.mod, and the entry points first.
   ```bash
   sed -n '1,60p' README* 2>/dev/null
   head -60 package.json 2>/dev/null
   ```

5. **Narrow iteratively.** Start broad (`grep -rln`), then zoom (`grep -rn -C`),
   then read exact lines (`sed -n`). To see which files have the most hits:
   `grep -rc "term" . | grep -v ':0$' | sort -t: -k2 -n`.

## Rules

- Tree-structured search ONLY. If you catch yourself about to `cat` a big file or
  read files sequentially "to look around", stop and `grep -rn` instead.
- Do NOT assume `rg` exists. Default to `grep -rn` / `git grep`.
- Quote search terms; use `grep -F` for literal strings with regex metacharacters.
- Cap output: pipe to `head`, use `-m 50` to limit matches, so you don't flood
  context.
- If the repo is on GitHub and not yet local, first use the **clone-github**
  skill to bring it into the sandbox, then explore it here.
