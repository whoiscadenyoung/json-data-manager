---
name: ci-disabled-2026-11-24
description: 2026-11-24 Actions disabled — workflows parked at .github/docs/workflows; .zcode fully untracked; branch protection removed same day — plain merges
metadata:
  type: project
---

2026-11-24: GitHub Actions disabled by owner decision (minutes budget) —
`.github/workflows/` (ci.yml + deploy.yml) moved VERBATIM to
`.github/docs/workflows/` (merge commit of PR #369-era branch
`chore/disable-ci-zcode-cleanup`). Actions only reads `.github/workflows/`, so
nothing runs anymore: no PR fast checks, no full gate on main pushes, no GHCR
publish (VPS deploy was already skipped).

**Why:** the owner chose to disable Actions outright rather than keep the
fast-checks-only policy from 2026-11-09.

**How to apply / gotchas:**

- Re-enable = `git mv .github/docs/workflows .github/workflows` + plain
  HTTPS push — the gh token carries the `workflow` scope since 2026-11-24
  (see gh-push-workflow-scope, now marked resolved).
- Branch protection on `main` was REMOVED the same day (2026-11-24, owner
  action in repo settings — verified via the protection API returning 404
  "Branch not protected"), so the phantom-required-checks window was brief:
  plain `gh pr merge --merge` works again, no `--admin`, and direct pushes
  need no bypass.
- Until re-enabled, `scripts/local-gate.sh` is the ONLY gate — run it before
  any risky merge.
- Same branch: `.zcode/` is now ignored folder-wide and fully untracked (the
  33 skill symlinks → `.agents/skills/` copies and the Sep-20 plans file
  removed from the tree). Old commits still contain them; full erasure would
  need a filter-repo rewrite (declined for now).
