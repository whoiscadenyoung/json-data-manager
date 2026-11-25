---
name: pg-naming-cleanup-2026-11-24
description: 2026-11-24 sweep dropped all migration-era pg-/Pg/pg:/Postgres naming from app/src and collapsed the transitional convex-shaped row layer onto store shapes
metadata:
  type: project
---

2026-11-24, branch `chore/drop-pg-naming`: the Supabase migration's naming
artifacts are gone from `app/src`. Convention now: **one version of every
file, store-native names** — the store modules' shapes (`EntryRow`,
`GeometryRow`, `DatasetSummaryRow`) ARE the app pipeline's shapes.

What changed, for future greps:

- ~100 files renamed (`pg-*` → bare; `dataset-rows-pg.ts` merged into
  `dataset-rows.ts`; `server/views/pg-types.ts` → `types.ts`; int tests keep
  the `.int.test.ts` suffix, e.g. `relations.int.test.ts`). `maps/lib`
  tile files are now `tile-archive-state.ts` (+ `-react`) vs the rebuild
  manager `tile-archive.ts`.
- `~150 pg/Pg/Postgres`-prefixed symbols stripped (`PgDatasetPage` →
  `DatasetPage`, `PgSession` → `WireSession` for the SCRAM wire client,
  `PgBrowserItem` → `CatalogItem` — catalog-tree already owned `BrowserItem`).
- Query keys de-namespaced: `["pg:<table>", …]` → `["<table>", …]`;
  `light-namespaces.ts` updated; `PERSIST_BUSTER` bumped `pg-v1` → `v2`
  (old persisted entries drop by design).
- The transitional layer is DEAD: `layer-rows.ts` adapters deleted —
  loaders build `ResolvedGeometryRow` (`GeometryRow & {geometryResolved?}`,
  ADR 0025 hand-off) inline; `resolvedGeometryOf()` in `map-layers.ts` is
  the ONE `Geometry` narrowing at the map boundary (never-writes-
  GeometryCollection posture). `useResolvedGeometries` (json-cms, convex-
  shaped `_id`/`geometryJson` contract) no longer used by the app; `extentBounds()`
  replaces `boundingBox` tuple lifting.
- Route params renamed `datasets/$schemaId` → `datasets/$datasetId`
  (+ projects twin); every `schemaId`-named identifier became `datasetId`.
  `schema` meaning the dataset's JSON Schema (schema-visualizer,
  schemaNodeOf) is UNRELATED and untouched.
- Dead convex config removed: vite `ssr.noExternal @convex-dev/better-auth`,
  `#convex/*` aliases (package.json/tsconfig/vitest). `app/convex/` +
  `packages/*` + their deps (convex, @convex-dev/*, convex-test) UNTOUCHED.
  `prepare-fixture.ts` now ships its own `national-parks.ts` data.

**Why:** the backend is Postgres-only; convex-era naming implied two
competing implementations that no longer exist.

**How to apply:** new store queries key `["<table>", <fn>, args]`; no new
`pg` prefixes anywhere in app naming; if a bare name collides with a
preserved-package export, prefix with the domain (`CatalogItem` precedent).
GOTCHAS hit during the sweep: (1) renames of IMPORTED names from preserved
packages must be reverted — `wiredSchemaIds` comes from `@caden/maps` (2)
zsh `echo "…\\b…"` emits literal backspaces — generate perl/sed rules via
heredocs, never echo (3) `git ls-files` is cwd-relative — run from the repo
root or filters silently match nothing (4) `relations.int.test.ts`'s "views
can be link ends" test fails with `created_by null` under the dedicated-db
recipe — verified PRE-EXISTING on main (same 1 failed / 8 passed), claims-GUC
class, not this sweep (5) `stage7-bindings.int.test.ts` lacked the
`describe.skipIf(!dbUp())` gating every other int file has — added, so a
foreign postgres on :54322 skips instead of failing.
