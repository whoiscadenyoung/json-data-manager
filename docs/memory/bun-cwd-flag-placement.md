---
name: bun-cwd-flag-placement
description: bun 1.3.5 silently ignores `bun --cwd <dir> run <script>` (prints
  help, exits 0, runs nothing) — use `bun run --cwd <dir> <script>` or
  `cd <dir> && bun run <script>`
metadata:
  type: project
---

Observed 2026-11-03 (stage-2 worktree kickoff, bun 1.3.5):

- `bun --cwd <dir> run <script>` (flag BEFORE the `run` subcommand) does NOT
  run the script: it prints the `bun run` help menu plus the package.json
  script list and exits 0. Verified with a nonexistent script name — no
  "Script not found" error, so the script name is dropped before resolution.
- `bun run --cwd <dir> <script>` (flag AFTER `run`) parses correctly and
  reaches script/binary resolution; `cd <dir> && bun run <script>` works too.
- Consequence: any exit-code baseline recorded from the first form is the
  help printer's exit 0, not the check's result (the stage-2 kickoff's
  literal `bun --cwd … run fmt:check` / `bun --cwd … run lint` commands were
  affected). If a bun invocation prints a help menu, nothing ran — rerun
  before recording the code.

Related: [[stage-3-ci-tree-lessons]], [[local-dev-verification]].
