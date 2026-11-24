---
name: turbo-setup
description: 2026-11-24 turbo 2.11 owns root build/test/typecheck/dev (bun workspaces graph); app#build REPLACES the generic task def; composite-tsc tsbuildinfo files outside dist silently skip emit after manual dist deletion
metadata:
  type: project
---

2026-11-24: turborepo 2.11.13 added as a LOCAL devDependency (no global, no
remote cache) and the root scripts rewired onto it: `build`/`test`/`typecheck`
→ `turbo run <task>`, `dev` → `turbo run dev --filter=app`. `packageManager:
bun@1.3.5` pinned for turbo's workspace detection. turbo tasks: build/test/
typecheck all `dependsOn: ["^build"]`; `dev` is persistent + uncached with the
same `^build` gate; `app#test` is `cache: false` (PG-backed); lint/fmt stay
root-wide oxlint/oxfmt (single root config; the lefthook hook gates per file —
see [[lefthook-pre-commit-setup]]). Turbo coverage is a superset of
scripts/local-gate.sh (includes demo/deploy-source typecheck+bun test, which
the gate never ran); `packages/analysis` is an empty stub (no package.json) —
not a workspace member, ignored. json-cms/data-export legacy Convex-era `dev`
scripts are excluded by the `--filter=app` on dev.

**Why:** the inter-package build order lived hardcoded in the gate script and
stale-dist breakage kept resurfacing; the dev flow now replays dependency
dists (cache hits, ~instant) before vite boots.

**How to apply / gotchas:**

- **`app#build` REPLACES the generic `build` task definition, it does not
  merge** — a bare `{"outputs": [".output/**"]}` override silently dropped
  `dependsOn: ["^build"]`; restate dependencies inside any `pkg#task` block
  (verified via `turbo run build --dry=json`).
- **Composite tsc buildinfo lives OUTSIDE dist**: json-cms →
  `.cache/tsconfig.tsbuildinfo`, data-export → `tsconfig.build.tsbuildinfo`
  (adjacent to the config, default for `-p tsconfig.build.json`). Deleting
  `dist/` alone makes tsc exit 0 WITHOUT emitting (up-to-date skip) — this
  crashed the first app build ("no output files found" warnings are the tell).
  Turbo only CAPTURES declared outputs (it does not pre-delete them on a
  cache miss), so `build.outputs` includes the buildinfo globs for cache-hit
  consistency, but a manual `rm -rf dist` still needs the buildinfo removed
  too: json-cms has `build:clean`/`build:codegen` (codegen works offline);
  data-export's `build:codegen` needs CONVEX_DEPLOYMENT (Convex-era), so just
  delete its `tsconfig.build.tsbuildinfo` then plain `build`.
- `bun run dev` boots on :3001 when :3000 is held (usual), after replaying
  the dist cache hits; Ctrl-C tears down cleanly.
- `globalPassThroughEnv` (SUPABASE_DB_URL, DATABASE_URL, JWT_SECRET,
  NODE_ENV, CI) defeats turbo 2.x strict env mode for the ambient vars the
  app suite and view runner read; extend that list before adding new env.
- json-cms' suite (`vitest run --typecheck`, 207 tests) takes ~4 min and has
  a load-flaky test on main (1 failed twice under concurrent turbo load,
  passed on immediate rerun 2026-11-24) — don't misread it as a turbo
  regression; rerun the package solo first.
- The 20k-seed perf test etc. remain gate-only concerns; `bun run test` runs
  the app suite exactly like the pre-turbo `bun --filter=app run test` did.
