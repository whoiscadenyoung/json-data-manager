---
name: code-review-2026-09-30
description: 2026-09-30 post-roadmap full-repo review → umbrella #123 (children #124–#139); trusted-collaborator model (ADR 0009); how agents should pick up the fixes
metadata:
  type: project
---

On 2026-09-30, after roadmap umbrella #88 was complete, a full-repo code review ran at `537549e`.

- **Method:** six parallel Sonnet reviewers, then a verify workflow of four adversarial Sonnet skeptics that re-checked the 21 top claims (19 confirmed, 2 plausible, 0 refuted).
- **Record:** `docs/code-review-2026-09-30.md`. Every finding is filed under umbrella **#123**, children **#124–#139**, all labelled `code-review-2026-09`.
- **Why the fixes need care:** each issue carries _Preserve_ and acceptance sections, because the user's priority is **keeping all shipped functionality**. Agents take one issue per branch/PR, and land #138's characterization tests for untested code (sync, tags, sources, freezeVersion) before or with the fix.
- **Top verified defects:**
  - #125 PMTiles run-length dedupe covers id gaps, so maps render with holes.
  - #126 chain retention retries retired versions, so tagDeltas and retention silently stop.
  - #127 sync: `.take(1000)` reads then sweep deletes live rows, >500 commits skipped, stuck `collecting` runs.
- **Trust model decided with the user 2026-09-30:** all signed-in users are trusted, and published datasets, maps, collections and groups are **co-editable by design** ([ADR 0009](../decisions/0009-trusted-collaborator-catalog.md)).
  - Don't "fix" cross-user writes ad hoc. Opt-in private/locked datasets are #124.
  - Signup gating (#136) is what keeps the trust assumption true.
  - Read-only guarantees for frozen and bound datasets are NOT trust-based, so any bypass is a bug.
- **Disclosure choice:** the repo is PUBLIC, and the user chose fix-focused public issues (no exploit recipes) for security items.
- **Gates at review:** lint, tsc and 683 tests green; `fmt:check` fails on 61 files, which CI deliberately omits (#139).
- **Path fix:** the Convex guidelines path in CLAUDE.md / AGENTS.md was `apps/web/...` and is now fixed to `app/convex/_generated/ai/guidelines.md`, which exists and is tracked. Those lines sit inside the `convex-ai-start` managed block, so re-running `npx convex ai-files install` may revert the path. Re-check after any reinstall.
- **Subagents work now.** Spawning Sonnet agents and the Workflow tool both succeeded this session (the older "subagent spawning unavailable" note was removed).
