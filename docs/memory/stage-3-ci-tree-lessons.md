---
name: stage-3-ci-tree-lessons
description: Two gotchas from the stage 1–3 runs — app tests that touch env.ts must mock #/env for CI, and shared-tree implementer "commit everything" sweeps contaminate branches
metadata:
  type: project
---

Two durable gotchas surfaced while landing stages 1–3 (PRs #111–#114, all
merged 2026-09-28):

1. **App vitest tests vs `env.ts` in CI.** `app/src/env.ts` validates
   `VITE_CONVEX_URL`/`VITE_CONVEX_SITE_URL` strictly at import time
   (t3-oss/env-core). Local gates pass because `app/.env.local` exists; CI
   has no env file, so any test whose import chain reaches `env.ts` dies
   with "Invalid environment variables". **Why:** the module validates on
   load, not on use. **How to apply:** new app test files that transitively
   import the seam/export/etc. must `vi.mock("#/env", () => ({ env:
{ VITE_CONVEX_URL: "http://127.0.0.1:3212" } }))` — the established
   pattern in `dataset-rows.test.ts`, `export.test.ts`,
   `dataset-rows-react.test.tsx`. CI caught this twice (#113, #114) after
   locally-green gates.

2. **Sequential implementers sharing one working tree.** Dynamic-workflow
   run items that ship with "commit everything on the branch" will sweep up
   unrelated edits left in the tree by other work — stage 3's 3a commit
   absorbed in-progress 3b content, splitting stage 3 messily across PRs
   #113/#114 (overlap resolved manually at merge). **Why:** uncommitted
   edits follow branch checkouts invisibly. **How to apply:** run-item ship
   asks must say: run `git status` first, stage ONLY your own files by
   explicit path, leave unrelated modified files untouched and report them.

Also: a stale `packages/json-cms/dist` produces phantom type errors in
oxlint's type-aware pass (app reads component types from dist) — rebuild
from the branch before trusting lint diagnostics. Related:
[[roadmap-kickoff-run]], [[local-dev-verification]].
