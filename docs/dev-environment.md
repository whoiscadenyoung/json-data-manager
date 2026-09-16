# Dev environment: worktrees, port isolation, devcontainers

This repo's dev stack is **bun workspaces + a Convex local backend + Vite
(TanStack Start)**. This document describes the setup for running several
copies of that stack at once — one per git worktree — without port conflicts,
without duplicating node_modules or the 221 MB local Convex database, and
(optionally) inside dev containers.

Everything is driven by two scripts, both plain Bun with no dependencies:

| Script                                       | Purpose                                                        |
| -------------------------------------------- | -------------------------------------------------------------- |
| `scripts/worktree.ts` (`bun run worktree …`) | create/list/remove worktrees, share env + deps, allocate ports |
| `scripts/dev.ts` (`bun run dev`)             | run convex dev + vite with per-checkout ports                  |

State lives in `<repo>/.worktrees/` (gitignored): the worktrees themselves and
`registry.json`, the port registry.

## One-time setup

```bash
bun install          # already done if you've developed here before
bun run setup        # installs the post-merge git hook (core.hooksPath = .githooks)
npm i -g portless    # optional: named local URLs (see "Portless" below)
portless proxy start # once, keeps the portless proxy running in the background
```

## How ports are assigned

Each checkout claims a stable "slot" in `.worktrees/registry.json`:

| Checkout          | Convex backend (api / internal)                            | Vite frontend     |
| ----------------- | ---------------------------------------------------------- | ----------------- |
| main repo         | 3212 / 3213 (from `app/.convex/local/default/config.json`) | 5173              |
| worktree slot 1   | its own deployment (chosen by the Convex CLI)              | 5180              |
| worktree slot 2   | its own deployment                                         | 5190              |
| worktree slot _n_ | its own deployment                                         | 5180 + 10·(*n*−1) |

Rules the scripts enforce:

- Vite ports are verified free before use; if a slot's port is taken the
  checkout silently moves to the next free port and the registry is updated.
- The Convex backend ports come from the deployment's `config.json`. The CLI
  re-picks free ports itself if its preferred ones are busy;
  `scripts/dev.ts` reads the live config after startup and exports
  `VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL` into the Vite process, so the
  frontend always points at the backend that is actually running — even if
  ports shifted or a stale `.env.local` disagrees. `convex dev` is also
  spawned with `--env-file .env.local` and a scrubbed `CONVEX_DEPLOYMENT`
  env var: bun auto-loads the repo-root `.env.local` (which still references
  the old cloud `dev:different-elk-353` deployment) and a process-env
  `CONVEX_DEPLOYMENT` would otherwise override the checkout's
  `app/.env.local`, steering `convex dev` at a cloud deployment instead of
  the local backend. If `convex dev` ever prints "Provisioned a dev
  deployment", that's this bug in disguise.
- Vite binds `127.0.0.1` with `--strictPort` so the portless alias (which
  proxies over IPv4) always reaches it, and a busy port fails loudly instead
  of silently shifting.
- `bun run dev --dry-run` prints the resolved ports, URLs, storage mode and
  dependency plan for the current checkout without starting anything.

Because worktrees use disjoint 10-port slots (3220+, 5180+), they never
conflict with the main repo, with `packages/json-cms`'s example dev servers
(3216/3217), or with other projects on the machine that use Convex or Vite
defaults.

## Worktrees

```bash
bun run worktree add my-feature              # branch wt/my-feature
bun run worktree add my-feature feature/x    # existing branch
cd .worktrees/my-feature
bun run dev                                  # its own ports, backend + frontend
```

`add` does the following:

1. `git worktree add .worktrees/<slug> [-b wt/<slug>]`
2. Allocates a free port slot and registers the worktree.
3. **Symlinks** the root `.env.local` from the main checkout (one source of
   truth for keys). `app/.env.local` is a per-worktree _copy_ with the
   worktree's Convex URLs patched in, because the ports differ.
4. **Symlinks every `node_modules` directory** from the main checkout
   (root + `app` + `packages/*`) when `bun.lock` is identical, so a fresh
   worktree costs ~0 extra disk. If the branch's `bun.lock` differs from
   main's, it installs fresh instead — bun's global cache makes that fast and
   the packages hardlink into the same store.
5. Copies `packages/*/dist` build output (the app imports `@caden/json-cms`
   from `dist`; ~1.5 MB). Rebuild it in the worktree after touching the
   package: `bun run --filter=@caden/json-cms build`.
6. Registers a portless alias (`https://jdm-<slug>.localhost`) when portless
   is installed.

### Convex storage: shared vs. forked

By default a worktree **shares** the main checkout's local deployment:
`app/.convex` is a symlink, so the same dev data (schema, imported datasets)
is available and nothing is duplicated.

- Only **one** `convex dev` may run against shared storage. If the backend is
  already running (e.g. main's `bun run dev` is up), the second checkout
  **attaches** instead: `scripts/dev.ts` detects the live backend on the
  shared port and starts only Vite, pointing at it. Same data, no conflicts,
  no second backend.
- A worktree that needs its _own_ backend at the same time (e.g. you're
  changing `app/convex/` schema code while main is running) should use a
  forked, empty deployment:

  ```bash
  bun run worktree add schema-work --fork
  ```

  `--fork` gives the worktree its own `.convex` storage; the first
  `bun run dev` creates a fresh local deployment and pushes the schema. The
  resolved URLs are written back into the worktree's `app/.env.local`.

Use `bun run worktree list` / `bun run worktree ports` to see which checkout
holds which ports and storage mode.

### Removing worktrees

```bash
bun run worktree remove my-feature --delete-branch
bun run worktree clean --dry-run     # what would be removed?
bun run worktree clean --delete-branches
```

### Cleanup on merge (automatic)

The `post-merge` hook (installed by `bun run setup`) runs
`bun run worktree clean --quiet` after every merge: worktrees whose branch is
fully merged into the current branch are removed automatically, along with
their registry entries and portless aliases.

- Clean-ups only fire locally, after `git pull` / `git merge` on the main
  checkout — this is the "delete worktrees when PRs merge" loop.
- **Squash-merged PRs**: the branch's commits are not ancestors of `main`, so
  the hook keeps those worktrees; run `bun run worktree remove <slug>
--delete-branch` manually.
- The hook never blocks a merge (all errors ignored) and never deletes a
  worktree with unmerged commits unless you pass `--force`.

## Portless

[portless](https://github.com/vercel-labs/portless) maps local ports to stable
`*.localhost` URLs. Every checkout registers a **project-namespaced** alias
(`jdm-<slug>`, e.g. `jdm-map-fixes.localhost`), so several projects can use
portless at once without colliding.

- Alias registration is best-effort: if portless isn't installed or the proxy
  isn't running, `bun run dev` just prints the direct
  `http://localhost:<port>` URL. `--no-portless` skips it entirely.
- HTTPS is on by default; run `portless trust` once to trust the generated
  local CA. If your browser blocks `ws://` WebSocket traffic to the Convex
  backend from an HTTPS page (seen in Safari), either use the direct
  `http://localhost:<vite port>` URL, or run the proxy with
  `portless proxy start --no-tls` (plain HTTP on port 80).
- Vite's default host allow-list already accepts `*.localhost` hostnames; if
  you switch portless to another TLD (`--tld test`), add it to
  `server.allowedHosts` in `app/vite.config.ts`.

## Dev containers

`.devcontainer/` defines a container (bun + git) for developing the whole
stack. Volume mounts shadow `node_modules` and `app/.convex` inside the
container, so container installs (Linux binaries) and container dev data
never touch the host — the host's darwin `node_modules` and local Convex DB
stay intact.

- **Docker Desktop / OrbStack**: open the repo (or any
  `.worktrees/<slug>` checkout) in VS Code → "Reopen in Container". Inside,
  `bun run dev` uses the same port logic; forwarded ports (5173, 3210–3213)
  appear on `localhost` on the host, and you can `portless alias jdm-docker
5173` on the host for a named URL.
- **Apple's `container` runtime** (`https://github.com/apple/container`,
  macOS 26+ on Apple silicon) is supported by VS Code's Dev Containers
  extension behind the experimental setting
  `dev.containers.experimentalAppleContainerSupport` — install `container`,
  run `container system start`, then enable the setting and "Reopen in
  Container". The `@devcontainers/cli` command line does not support Apple
  `container` yet (open request:
  [devcontainers/cli#1263](https://github.com/devcontainers/cli/issues/1263)),
  so use VS Code (or run the image manually with `container build` /
  `container run`) until that lands.

Inside a container the `.convex` deployment is fresh, so the first
`bun run dev` re-creates a local deployment (ports 3210/3211 inside the
container) and pushes the schema — imported dev data is not carried over.
That isolation is intentional; re-import a dataset from `exports/` if you
need data in the container.

## Cheatsheet

| Task                                   | Command                                          |
| -------------------------------------- | ------------------------------------------------ |
| New worktree, shared dev data          | `bun run worktree add <slug>`                    |
| New worktree, isolated backend         | `bun run worktree add <slug> --fork`             |
| Start dev stack in any checkout        | `bun run dev`                                    |
| Inspect planned ports without starting | `bun run dev --dry-run`                          |
| See all ports                          | `bun run worktree ports`                         |
| Remove one worktree                    | `bun run worktree remove <slug> --delete-branch` |
| Auto-clean after merges                | `bun run setup` once, then just `git pull`       |
| Old behavior (convex `--start` vite)   | `bun run dev:plain`                              |
