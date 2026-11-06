---
name: project-relations-0021-lessons
description: "#258 gotchas — $projectId.tsx Outlet-masking killed its children on main, migration-session auth.uid() NULL vs the 0009 stamp trigger, NULL-vacuous CHECK constraints, page-cut-inside-window paging, the is_geospatial/bbox fixture flags, in-test ANALYZE churns shared stats"
metadata:
  type: project
---

2026-11-06, #258 (0021_dataset_relations, ADR 0020). Six hard-won facts:

- **A parent route file WITHOUT `<Outlet/>` silently masks its children —
  `$projectId.tsx` (full workspace component, no Outlet) made
  `/projects/$projectId/create` and `/projects/$projectId/maps/$mapId`
  render the WORKSPACE at their own URLs on main b165729.** The editor was
  unreachable by URL and by the post-create navigate; #257's verification
  missed it. Fix (this branch): `projects/$projectId/route.tsx` = layout
  holding the Convex-archive gate + `<Outlet/>`; the workspace moved to
  `projects/$projectId/index.tsx`; `$projectId.tsx` deleted. Rule: a
  directory with child routes gets `route.tsx` (layout) + `index.tsx`
  (content) — the `datasets/$schemaId/` tree works only because it has NO
  parent `.tsx` at all (implicit layout). Symptom to recognize: the parent's
  h1 at the child's URL.

- **Migration sessions have `auth.uid() = NULL`, and the 0009
  `stamp_created_by` trigger OVERWRITES an explicit created_by with it** —
  0020's per-creator map backfill died on `projects.created_by NOT NULL`
  the first time it met real legacy data (the compose demo stack; CI's
  fresh DBs never see it). Fix: `set_config('request.jwt.claims'/'claim.sub',
owner)` PER ITERATION around each birth-INSERT (and clear after). Same
  applies to ANY migration-seeded row on a table carrying the stamp trigger
  (projects/entries/geometries/imports/layers/dataset_relations).

- **A CHECK constraint on a jsonb key probe is NULL-vacuous**:
  `jsonb_typeof(config->'fromKey') = 'string'` evaluates NULL when the key
  is missing, and a NULL CHECK result PASSES. COALESCE-guard every probe
  (`coalesce(jsonb_typeof(...), '') = 'string'`).

- **Keyset+window paging: the page cut must be the INNERMOST query level.**
  Windows (`row_number`, `count(*) over ()`) evaluate BEFORE offset/limit
  at the same level, so an `rn` beside the cut numbers the GLOBAL order and
  every offset > 0 page comes back empty. Shape: inner subquery
  `... offset $o limit $n+1` → middle `row_number()` + `count(*) over ()`
  → outer `where rn <= $n` + `page_size = $n+1 as has_more`.

- **Fixture datasets seeded via raw SQL need `is_geospatial = true`,
  `geometry_type`, and a `bbox` envelope (`st_makeenvelope` — the column is
  a PostGIS geometry, not an array) or the map renders NOTHING**: the tile
  decision drops non-geospatial ids (`continue` in splitSchemaIdsByDecision)
  and a bbox-less dataset opens the default world view. Symptom: editor map
  container empty, no "Loading features…" chip (the vacuous-every() path),
  no canvas.

- **An in-test `ANALYZE` of bulk rows churns the SHARED sequential int-test
  DB's planner stats** — pg-stage5's 5201-row clamp test pivots from ~0.8 s
  to ~7 s on ambient stats and blew its 5 s default. The #258 perf test
  seeds committed rows + ANALYZEs (its plan evidence needs them), then
  vacuum-analyzes in `finally`; the clamp test carries a documented 30 s
  bound. Rule for int tests: anything that mutates shared planner state
  repairs it before the next file runs (files are serialized,
  fileParallelism:false).

Related: [[project-layers-0020-lessons]], [[project-catalog-0019-lessons]],
[[supabase-stage1-sql-gotchas]], [[iab-browser-testing-gotchas]].
