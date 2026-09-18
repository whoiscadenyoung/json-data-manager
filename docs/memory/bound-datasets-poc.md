---
name: bound-datasets-poc
description: Bound-datasets integration design + working PoC (foreign tables → json-cms projection); issue #72, design at docs/bound-datasets-design.md
metadata:
  type: project
---

2026-09-18: Integration with the user's second Convex app (git-like versioning:
commits = small field deltas, snapshots = tags) is designed in
`docs/bound-datasets-design.md`, tracked as umbrella issue #72 (sub-issues to
be spun off per phase). Core model: json-cms mirrors, never re-owns
versioning — a read-only **bound live dataset** (projection keyed by foreign
`_id`), a **frozen version dataset per tag** (own archive), **commit patch
records** rendered as GeoJSON overlays, tag deltas computed at ingest. Sync
primary path = commit-tail apply; projection beats virtual tables (every
component read path works unchanged). Hosting fork (this app hosts vs.
component-in-other-app) deliberately open until the remote-transport phase.

**Working PoC shipped** (verified end-to-end on local dev): `app/convex/schema.ts`
adds foreign-domain host tables (`restaurants`, `locations` lat/lng,
`restaurantLocations` many-to-many, `datasetBindings` registry) cohabiting
with the component's tables; `app/convex/seed.ts` `seedRestaurants`
(idempotent internalMutation; run `bunx convex run seed:seedRestaurants` from
`app/` — 5 restaurants / 16 locations / 16 links, Hampton Roads + Richmond
synthetic coords); `app/convex/bindings.ts` `syncRestaurantLocations` (public
mutation) find-or-creates the "External demo" collection + geospatial Point
dataset + binding row, then clear-and-reloads the projection; `status` query
reports state. Map rendered all 16 points with **zero frontend changes**.

Gotchas learned building it:
- Host calls component functions directly via `components.jsonCms.lib.*`
  passing plain-string component ids (component re-validates against its own
  tables) — pattern from `app/convex/tile_archives.ts`; calls join the
  caller's transaction, so a whole sync fits in one mutation.
- `createSchema` takes the JSON schema object with `title` INSIDE it (plus
  `kind: "geospatial"` + `geometryType`); `createEntriesBulk` takes geometry
  as a serialized JSON string.
- `insertEntryBatch` (both create paths) auto-maintains `featureCount`/
  `boundingBox` and bumps `mapTileCacheVersion` — server-side writes get
  archive invalidation + map viewport for free. Small datasets skip the
  archive entirely (row path; `MAP_TILE_ARCHIVE_MIN_BYTES` = 256 KB).
- oxlint: `String(componentId)` is flagged no-unnecessary-type-conversion —
  component ids are plain strings at the host boundary; `no-await-in-loop`
  warnings avoided via `Promise.all(arr.map(async ...))` (component idiom).
- `bunx convex ai-files install` (from `app/`) generates
  `app/convex/_generated/ai/guidelines.md` plus `app/AGENTS.md`,
  `app/CLAUDE.md`, `app/.agents/`, `app/.claude/`, `app/skills-lock.json` —
  left uncommitted; root AGENTS.md untouched. See [[convex-ai-guidelines-missing]].
