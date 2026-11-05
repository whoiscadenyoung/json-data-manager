---
name: prod-ssr-build-invariants
description: Prod SSR build invariants after #243 — react ships external + materialized, one service chunk, nitro codeSplitting beats user chunk options, guard fails the build
metadata:
  type: project
---

The prod SSR image (nitro `bun` preset, `.output` ships alone) holds three
invariants, all guarded — established 2026-11-05 fixing #243 (every route
served ResolveMessage JSON):

1. **react-family stays EXTERNAL end to end and ships as real packages.**
   `vite.config.ts` pins `nitro.rolldownConfig.external` =
   `/^react(-dom)?($|\/)/, /^scheduler$/`; `app/scripts/finalize-ssr-output.ts`
   (wired into `bun run build`) copies react/react-dom/scheduler into
   `.output/server/node_modules` and then FAILS the build on any bare
   external that isn't a node builtin or shipped there. Never "optimize"
   react back into the SSR bundle: rolldown's interop flavor for an external
   react (ESM import vs bare `__require("react")` shim) differs per PLATFORM
   build, and an inlined-copy arrangement silently depends on it — the linux
   container lost the copy that mac kept. One instance per process = the
   shipped node_modules copy.
2. **The whole vite-service output folds into ONE server chunk** (a group in
   `nitro.rolldownConfig.output.codeSplitting.groups` with
   `test: /\.nitro[/\\]vite[/\\]services[/\\]/`). Nitro's default splitting
   could slice the service mass into mutually-importing chunks whose
   evaluation order handed out `require_shim` before assignment
   (`require_shim is not a function` at SSR boot — deterministic in linux,
   latent on mac). One chunk cannot self-cycle.
3. **A vite-level `advancedChunks`/route-tree pin NEVER applies to the nitro
   build**: nitro's own inline `codeSplitting.groups` default precedes user
   config in the defu chain (user groups may be APPENDED via
   `nitro({ rolldownConfig })` — defu concatenates arrays — but never
   replace). The 2026-11-05 route-tree pin was placebo from day one; it was
   removed in PR #246. Chunk-shape claims must be verified against the built
   output (`ls .output/server/_chunks _ssr _libs`), never against config.

Also: `app/vitest.config.ts` runs with `fileParallelism: false` (PR #248)
— but the int-test "flake"'s REAL root cause was CI step ORDER (PR #250):
the `ci` job applied migrations BEFORE booting storage-api, and the bare
`supabase/postgres:15.19.0.016` image initializes WITHOUT a storage
schema — 0004/0006's storage sections silently skip (their
`to_regclass` guards), storage-api's boot then creates `storage.objects`
with ZERO policies and no buckets, and every storage INSERT is denied.
The migration-apply step must ALWAYS follow a storage-api boot (the
store job's order; the compose stack's order too). Run-to-run variance
in such failures = a race between the tests' storage probe and the
boot, not flaky tests. CI green end to end on main @ fd43ff5
(run 42075309635, 2026-11-05).

Related: [[self-hosting-stack-2026-11-05]], [[closeout-train-2026-11-05]],
[[supabase-stage1-sql-gotchas]].
