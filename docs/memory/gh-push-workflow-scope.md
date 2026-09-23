---
name: gh-push-workflow-scope
description: gh's OAuth token (repo-only) cannot push .github/workflows changes over HTTPS — use the SSH host alias github.com-whoiscadenyoung or add the workflow scope
metadata:
  type: project
---

Pushing a commit that touches `.github/workflows/` over HTTPS fails with
`refusing to allow an OAuth App to create or update workflow ... without
workflow scope` — the gh keyring token has repo-only scopes (seen
2026-09-23 pushing the CI branch).

**Why:** GitHub blocks OAuth Apps from creating workflow files unless the
token carries the `workflow` scope.

**How to apply:** Either push via the repo owner's pre-existing SSH config
alias — `git push git@github.com-whoiscadenyoung:whoiscadenyoung/json-data-manager.git <branch>`
(probe first with `ssh -T git@github.com-whoiscadenyoung` → "Hi
whoiscadenyoung!"), then `git fetch origin && git branch -u origin/<branch>`
to restore tracking — or fix it durably with `gh auth refresh -h github.com
-s workflow`. Related: [[roadmap-kickoff-run]].
