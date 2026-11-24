---
name: gh-push-workflow-scope
description: RESOLVED 2026-11-24 — gh token now carries `workflow` scope; plain HTTPS push works for .github/workflows changes, no SSH alias needed
metadata:
  type: project
---

**RESOLVED 2026-11-24:** the gh keyring token was re-authenticated with the
`workflow` scope (verified via `gh auth status`: `gist, read:org, repo,
workflow`, git protocol https). Pushing commits that touch
`.github/workflows/` over plain HTTPS origin now just works — no SSH host
alias, no re-tracking dance.

**Why it mattered:** from 2026-09-23 to 2026-11-24 the token was repo-only,
and GitHub refuses workflow-file writes to OAuth tokens without `workflow`
scope, so those pushes failed outright and had to detour through the
`github.com-whoiscadenyoung` SSH alias.

**How to apply:** just `git push origin <branch>`. If the error
`refusing to allow an OAuth App to create or update workflow ... without
workflow scope` ever reappears, the token lost the scope — fix with
`gh auth refresh -h github.com -s workflow` rather than reaching for the
old alias. Related: [[roadmap-kickoff-run]], [[ci-disabled-2026-11-24]].
