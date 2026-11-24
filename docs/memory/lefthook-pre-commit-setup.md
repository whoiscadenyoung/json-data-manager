---
name: lefthook-pre-commit-setup
description: 2026-11-24 lefthook v2 pre-commit gate on staged files (oxfmt write + stage_fixed, oxlint blocks); dangling core.hooksPath=.githooks was unset; hooks self-install via the root prepare script
metadata:
  type: project
---

2026-11-24: lefthook v2.2.2 set up as the project-local commit gate
(`lefthook.yml` + root `"prepare": "lefthook install"` + devDependency). No
global install; the binary ships in node_modules. Scope agreed with the owner:
**pre-commit only** (no pre-push hook) — staged files get **linted**
(`oxlint --type-aware --type-check` — blocks, deliberately NO lint auto-fix)
**then auto-formatted** (`oxfmt` writes in place, `stage_fixed: true`
re-stages). `scripts/local-gate.sh` stays the full gate; see
[[ci-disabled-2026-11-24]].

**Why:** Actions is disabled, so the only standing enforcement is local; the
owner wanted a per-commit lint/format gate on staged files (oxfmt had already
let an unformatted memory file land on main once — the 0018-lessons note).

**How to apply / gotchas:**

- **`core.hooksPath` was set to `.githooks`, a directory that did not
  exist** — no hooks ran at all, and modern lefthook REFUSES to `install`
  while a hooksPath is configured (deliberate protection, PR #1292). Unset it
  (`git config --unset core.hooksPath`) before installing; if the setting
  ever reappears, `lefthook install` will warn and hooks will silently not
  sync.
- Hooks self-install for fresh clones via the root `prepare` script (runs on
  every `bun install`). lefthook v2's own postinstall ALSO auto-installs and
  auto-creates an example `lefthook.yml` if the file is missing — bun runs
  trusted postinstalls, so expect that file to reappear if deleted.
- The lefthook `exclude` lists mirror `.oxlintrc.json`/`.oxfmtrc.json`
  ignorePatterns (`**/_generated/**`, `**/routeTree.gen.ts`, niko-table +
  registry UI, `app/src/lib/supabase/database.types.ts`) because explicit
  file args may bypass tool-side ignore patterns.
- **Globs must be `**/*.{...}`, NOT `*.{...}`** — lefthook matches globs
  against the relative PATH, so a bare `*` never matches nested files (the
  first cut silently skipped everything outside the repo root; caught
  because oxfmt reported "1 files" when 3 were staged). `glob_matcher:
doublestar` is set so `**` also matches zero dirs (root-level files).
- **lefthook executes commands ALPHABETICALLY, not in config order**
  (confirmed in source: `internal/config/command.go` sorts jobs by
  `priority`, then leading number, then name) — `fmt` ran before `lint`
  until each command got an explicit `priority:`. `piped: true` adds
  fail-fast: a lint failure skips formatting entirely.
- Both commands carry `--no-error-on-unmatched-pattern` as defense for
  empty state (owner request). The primary mechanism is lefthook itself:
  when the glob-filtered file list is empty — nothing staged, config-only
  commit (yaml/toml/etc.), or deletion-only — the command is skipped with
  "no files for inspection" and exits 0.
- Escape hatches: `git commit --no-verify` or env `LEFTHOOK=0`. Standalone
  run: `bunx lefthook run pre-commit`.
- Measured per-commit cost ~0.4–1.1s (type-aware lint dominates). Type-aware
  lint can phantom-fail on stale package dists — rebuild dists before
  trusting weird hook errors ([[stage-3-ci-tree-lessons]]).
