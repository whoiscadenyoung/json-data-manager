---
name: project-layers-0020-lessons
description: #257/0020 gotchas — DROP TABLE takes RLS enablement with it (recreated tables ship policies-inert), publication detach on drop, INSERT .select() discriminates as a select in the test stub, branded Convex ids in plain-string maps
metadata:
  type: project
---

2026-11-06, #257 (0020_layers_project_maps, PR #265, ADR 0019). Four
hard-won facts, each caught live:

- **DROP TABLE takes RLS enablement with it — a recreated table ships with
  RLS OFF and its new policies are inert decoration.** 0020 dropped and
  recreated `map_layers` (the placement retarget) and wrote four fresh
  policies without re-running `enable row level security`; every
  authenticated user passed every check until the int test caught a VIEWER
  updating a placement. Rule: after any CREATE TABLE in a migration that
  replaces a dropped one, `enable row level security` is part of the table
  definition, not the policy set. (An INSERT raise still worked for the
  viewer because `maps` — altered, not recreated — kept its enablement,
  which made the hole look partial and confusing.)

- **DROP TABLE also detaches publication members.** The recreated
  `map_layers` silently left `supabase_realtime` (0013 had added it); 0020
  must re-add every recreated table explicitly. `layer_styles` (dropped)
  was removed from the publication in the same DO block. The pg-publication
  catalog check in the int suite pins the full membership set now.

- **An INSERT's `.select(...)` returning records as a `select` op in the
  test-support stub** — a responder that discriminates on "has select"
  routes INSERTs to the read branch and hands the store an empty array
  (the queryRow answers null and the test sees a denial). Discriminate on
  the INSERT first. This bit three separate responders in layers.test.ts.

- **Convex-branded ids (`Id<"derivedDatasets">`) leak through the archived
  pipeline types** (`pgDerivedToDerivedSummary` returns a FunctionReturnType
  shape): flatten with `String(id)` before keying a plain-string Map, and
  never `as`-cast the branded type (the repo bans casts; `String()` is the
  honest conversion). Also: `project_artifacts` has NO created_at column —
  order membership lists by id.

Related: [[project-membership-0018-lessons]], [[project-catalog-0019-lessons]],
[[supabase-stage1-sql-gotchas]].
