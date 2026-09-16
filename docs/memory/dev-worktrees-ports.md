---
name: dev-worktrees-ports
description: Worktree + port-isolated dev setup (scripts/worktree.ts, scripts/dev.ts) —
  stale root .env.local poisons bun-spawned convex (process env beats app/.env.local),
  vite binds 127.0.0.1, port slots, shared/forked .convex storage, post-merge hook
metadata:
  type: project
---

Dev-environment facts (2026-09-16). Full docs: `docs/dev-environment.md`.

- `bun run dev` = `scripts/dev.ts` orchestrator (convex dev + vite, per-checkout
  ports); `bun run dev:plain` is the old `convex dev --start 'vite dev'`.
  Worktrees: `bun run worktree add <slug>` → `.worktrees/<slug>`, state in
  `.worktrees/registry.json` (gitignored). Port slots: main = convex 3212/3213 +
  vite 5173; worktree slot _n_ = vite 5180+10(n−1), convex ports from config.
- Worktrees symlink root `.env.local` + all `node_modules` (when `bun.lock`
  hashes match) and share `app/.convex` with main; `--fork` gives fresh storage.
  If main's backend is already running, a second checkout ATTACHES (vite only)
  instead of starting another backend.
- Cleanup on merge: post-merge hook at `.githooks/`, wired via
  `git config core.hooksPath .githooks` — `bun run setup` (per clone). Squash
  merges don't auto-clean (not ancestors); `bun run worktree clean` handles.
- **Gotcha: the repo-root `.env.local` is stale** (still has
  `CONVEX_DEPLOYMENT=dev:different-elk-353` cloud values + PROD deploy key
  comment from before local deployments). Bun auto-loads it into every
  `bun`-spawned process env, and a process-env `CONVEX_DEPLOYMENT` overrides
  the checkout's `app/.env.local`, steering `convex dev` at the CLOUD
  deployment instead of starting a local backend. The orchestrator therefore
  scrubs `CONVEX_DEPLOYMENT` and pins `--env-file .env.local` (cwd=app).
  If "Provisioned a dev deployment" appears in convex output, the pin failed.
  Consider trimming the stale root file someday.
- Vite is spawned with `--host 127.0.0.1`: vite 8 otherwise binds IPv6-only
  (`[::1]`), which portless (IPv4 proxy target) can't reach.
- Side effect from testing 2026-09-16: the worktree code (== HEAD) got pushed
  twice to cloud dev deployment `different-elk-353` (team caden-young,
  project json-data-manager) before the env bug was found — cloud dev now has
  HEAD pushed, harmless.
- Devcontainers: `.devcontainer/` (oven/bun image, volume-mounts shadow
  node_modules + app/.convex). Apple `container` works via VS Code
  experimental `dev.containers.experimentalAppleContainerSupport`
  (macOS 26+); `@devcontainers/cli` doesn't support it yet
  (devcontainers/cli#1263).
