---
name: explore-codebase
description: Efficiently explore a code/text repository in the sandbox using tree-structured search (ripgrep/grep) instead of reading every file. Use whenever you must find where something is defined, used, or configured across many files.
---

# Explore a codebase efficiently

You have a `run_code` tool with a bash shell. The sandbox has `rg` (ripgrep),
`grep`, `git`, `sed`, `find`, `awk`, `head`, `tail`, `wc`. NEVER read files one by
one or dump whole files to find something — that wastes context and is slow.
Search first, then read only the matching lines.

## Procedure

1. **Map the tree first — do not read files yet.**
   ```bash
   cd <repo-dir>
   # directory layout, depth-limited, ignoring noise
   rg --files --hidden -g '!.git' | head -200
   # or a quick top-level view
   ls -la && find . -maxdepth 2 -type d -not -path '*/.git*' | head -80
   ```

2. **Find by content with ripgrep** (fast, recursive, respects .gitignore):
   ```bash
   rg -n "search_term"                 # all matches with line numbers
   rg -n -i "term" -g '*.ts' -g '*.py' # filter by file type/glob
   rg -l "term"                        # just the file names
   rg -n -C 3 "functionName"           # 3 lines of context around each hit
   rg -n "class \w+" -t py             # regex; -t selects a language
   ```
   Prefer `git grep -n "term"` when inside a git repo (it's even faster and
   scoped to tracked files).

3. **Read ONLY the relevant slice**, never the whole file:
   ```bash
   sed -n '120,180p' path/to/file.ts   # lines 120-180
   rg -n "def main" -A 40 app.py        # the match plus 40 lines after
   ```

4. **Understand structure** before diving in: read the README, package.json /
   pyproject.toml / go.mod, and the entry points first.
   ```bash
   sed -n '1,60p' README* 2>/dev/null
   cat package.json 2>/dev/null | head -60
   ```

5. **Narrow iteratively.** Start broad (`rg -l`), then zoom (`rg -n -C`), then
   read the exact lines (`sed -n`). Count first if a term is everywhere:
   `rg -c "term" | sort -t: -k2 -n` shows which files have the most hits.

## Rules

- Tree-structured search ONLY. If you catch yourself about to `cat` a big file or
  read files sequentially "to look around", stop and `rg` instead.
- Quote your search terms; escape regex metacharacters (`rg -F` for literal).
- Cap output: pipe to `head`, use `-m 50` to limit matches, so you don't flood
  context.
- If the repo is on GitHub and not yet local, first use the **clone-github**
  skill to bring it into the sandbox, then explore it here.
