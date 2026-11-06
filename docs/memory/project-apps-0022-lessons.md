---
name: project-apps-0022-lessons
description: "#259 gotchas: the project_artifacts added_by stamp overwrites auth.uid() on EVERY insert (claims GUC per app row in migration loops), version rows carry no kind (infer from dataset/frozenChildren), layer-styles left the optional-module lint list (D7), app_versions denial reads as RLS 0-rows not permission"
metadata:
  type: project
---

# Project apps (0022) — issue #259 gotchas

2026-11-06, PR #267 (branch `feat/project-apps`), ADR 0021, migration 0022.

- **`project_artifacts_stamp_added_by` overwrites `added_by` with `auth.uid()`
  on EVERY insert** (0009, security definer). A set-based membership mint in a
  migration stamps NULL and dies on the NOT NULL — loop per row with the
  claims GUCs set from the row's creator (the same lesson the 0020 backfill
  taught for `projects` inserts; artifacts are the third table to need it).
- **`layer_versions` rows carry no `kind`** — infer data-vs-group from the
  row itself: `dataset !== null → data`, else group (the writer guarantees
  exactly one of dataset/frozenChildren is set). Don't try to read the layer
  row for a linked version (foreign-project RLS).
- **`datasets` store has no imperative `get`** — only `getQueryOptions`
  factories; client-orchestration libs (the publish walk, the bundle press)
  run the factory's `queryFn` imperatively (`runStoreRead({} as never)`, the
  pg-bundle-publish shape).
- **`version_entries` is the frozen-render read path**: inline geometry at
  freeze time (storage-backed oversized rows carry none), keyedset paging by
  `ordinal`. Map version rows → `pgGeometryToLayerRow(row, row.geometry)`
  for the LayersMap shape — it is what adds `schemaId`/`geometryJson`.
- **`layer-styles` left the optional-module restricted list** (.oxlintrc.json):
  D7 makes styled stored maps load-bearing inside apps, so features build on
  it per ADR 0014's amended two-tier rule. `app-builder` stays route-only —
  the project workspace receives its create-app dialog through a
  route-level render-prop slot (`CreateAppSlot`), which must be rendered as
  a JSX element (calling a ComponentType as a function breaks hook rules).
- **app_versions is append-only via NO update/delete policies** (the
  layer_versions posture) — a denial reads as "0 rows affected
  (RLS-filtered)", not a permission error; only version_entries-style
  grant revocations produce permission denials.
- **Reference-stable callback rule applies to row loaders**: the frozen map
  canvas's `onLoaded` must be a useCallback over the stable setter (the
  useGeometriesByPgDatasets shape) or the report effect loops to OOM; an
  inline identity re-runs the effect every render.
- **Lint housekeeping**: `Promise`-returning helpers must be `async`
  (typescript/promise-function-async), `[...x].sort` → `toSorted`
  (unicorn), and a slot ComponentType passed through props needs
  `ComponentType` imported as a type (no React namespace).
- The int suite's default DB is the local stack at :54322 — seed-presence
  tests read COMMITTED rows, so they fail red until the new migration is
  applied there; verify against a throwaway `supabase/postgres` container
  (docker run, port 55432) or `supabase db reset` first.
