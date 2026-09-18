# Bound datasets — rendering foreign Convex data with json-cms

Design for integrating a second Convex app's preexisting data with this app's
geospatial rendering, without copying or restructuring that data. Captured
2026-09-18; a working proof of concept ships in this repo (see §9).

## 1. Context and goal

A second Convex app owns data we want to render geospatially: some of it is
geospatial (today as lat/lng number pairs), some is not. That app keeps its
own tables, and eventually the two apps merge. Constraints and desires:

- Preexisting tables stay exactly where and as they are, at least until the
  merge.
- A **live view** of the foreign data should be easily accessible in this
  app's map/browser UI.
- The foreign app versions its data like git: **changes** are commits
  (usually a field or two differing), **snapshots** are tags — full
  point-in-time states ("like tagging a branch on GitHub"). The map view
  should capture both: browsable snapshots/tags and the commit history.
- The foreign app's snapshot mechanism "can take any data shape needed," so
  we get to specify the transport.

## 2. Decisions recorded

- **json-cms mirrors; it never becomes a second versioning system.** The
  foreign app owns the version graph (commits, tags). json-cms stores
  projections of it.
- **Bound datasets are read-only here** — both the live dataset and tag
  versions. Enforcement is a gate in the entry/geometry mutations (the same
  gate protects tag versions from edits). Plain imported datasets remain
  fully editable. If editing on the map side is ever wanted, the clean
  escalation is emitting commits back to the foreign app (Placemark's
  inverse-patch Moments is the precedent) — out of scope for v1.
- **Projection, not virtual tables.** Foreign rows are materialized into the
  component's `entries`/`geometries` (keyed by the foreign `_id`), never
  queried live through the read path. Every existing query — pagination,
  detail, references, denormalized `featureCount`/`boundingBox`, the tile
  archive pipeline, entryId-in-tiles click-through — then works unchanged.
  Live-proxy rendering (rebuild per map open from remote pages) is rejected:
  it re-pays cross-source paging and archive-scale rebuilds per map open.
- **Tags materialize; commits don't.** A tag becomes a frozen version
  dataset with its own tile archive. Commits are stored as small patch
  records and rendered as GeoJSON overlays. Materializing a state per commit
  would cost an archive rebuild per commit (~22 MB class at FY22 scale) —
  the git analogy holds: diffs are cheap, trees exist only at refs.
- **Hosting-model-agnostic core.** The binding, sync writer, version
  freezing, and lineage are identical whether the sources end up co-deployed
  (code merged into one app) or remote (side-by-side deployments). Only the
  transport (internal query vs. HTTP/ConvexHttpClient reader) differs, and
  it sits behind a small source interface.

## 3. Concept mapping

| Foreign app concept | json-cms artifact | Rendered as |
| --- | --- | --- |
| Current head ("main") | The **bound live dataset** — a `schemas` doc carrying a source binding | Tile/row path, normal dataset page, layerable in maps |
| Tag / snapshot | A frozen **version dataset** (`schemas` doc + lineage fields, own entries/geometries/archive) | Normal dataset; a layer pointed at it is pinned in time |
| Commit / change | A **patch record** in a `commits` table (small: field-level before/after, op per entry) | GeoJSON overlay on the base map + field-diff panel |
| Tag ↔ tag diff | Derived **delta record** (same ops shape), computed at tag ingest | "Compare" overlay: adds/removes/modifies between two versions |

## 4. Data model (increment on the component schema)

- **Binding** (lives on the live dataset's `schemas` doc once promoted into
  the component; the PoC keeps it app-side in `datasetBindings`):
  `{ source, schemaMapping, lastSyncedAt, cursor, lastAppliedCommitId }`.
  `source` names the table/reader; `schemaMapping` declares the field →
  entry-data projection and the geometry mapping (geometry field, or
  lat/lng pair → Point; WKT would need a parser).
- **Lineage** on version datasets:
  `{ sourceSchemaId, versionLabel, snapshotRef, frozenAt }`; immutability
  gate keyed off its presence.
- **`commits`** table: per bound dataset, an ordered log of
  `{ foreignCommitId, seq, at, message, ops }` where each op is
  `{ entryKey, op: "add"|"update"|"delete", fields: [[name, before, after]],
  geometryChanged }`. Geometry-valued patches are the one size risk: inline
  below a cap, storage blob above, with a GeoLibre-style budget/trim policy
  for retention.

## 5. Sync (the "live" dataset)

- **Primary path: commit-tail apply.** Page the source's commit feed since
  `lastAppliedCommitId`; apply ops through the component's internal entry
  primitives (`insertEntryInternal` / `patchEntryInternal` /
  `deleteEntryInternal` — they already exist for the conversion and
  simplification workflows). Deletes come free (a delete is a commit op) —
  this dissolves the hardest part of a state-diff sync. Idempotent and
  resumable; runs as a durable workflow modeled on `importWorkflow`, batched
  under the 16 MiB / 1 MiB platform limits.
- **Fallback: full reconcile.** Periodically diff projected entry keys
  against a source id listing to correct drift (missed commits, out-of-band
  edits).
- Every geometry write already bumps `mapTileCacheVersion` and maintains
  `featureCount`/`boundingBox`, so archive invalidation and the client's
  staleness/rebuild loop need zero new code.

## 6. Tag ingest and compare

- A tag's full state arrives via the foreign app's snapshot files (JSONL, same
  shape as a `convex export` / `@caden/data-export` snapshot). Freezing a
  version = the existing import pipeline (chunked upload → `startImport` →
  `insertChunkFromStorage` → `handleImportComplete` → archive rebuild) plus
  the binding's schema mapping. Point-in-time correctness is by construction
  — the snapshot file is the state — with no sync-then-freeze race.
- At ingest, diff the new version against the previous tag into the commits'
  ops shape and store the delta; the compare view renders it as an overlay
  on either base.
- Auto-versioning: the foreign app pushes on snapshot creation (small
  authenticated action: "ingest snapshot S as version X"), and/or the host
  pulls a snapshot listing and ingests missing ones (idempotent, self-heals
  after outages). Build pull; add push as a convenience.

## 7. Rendering

- **Tags** need nothing new: each version dataset renders from its own
  archive; maps can mix "live" and pinned-version layers, which is the
  "this map shows the September snapshot" feature.
- **Commits** render as a separate GeoJSON overlay source — never touching
  the tile source (Placemark's split-source render-sync lesson). A history
  rail (git log for geodata) lists commits; selecting one highlights the
  affected features (adds/deletes/modifies) beside a field-level before/after
  panel. Affected geometries come from the projected entries (current
  position) or the patch's stored geometry.
- Retention/storage: tags duplicate entries + geometries + archive per
  version (~22 MB archive class at FY22 scale), so pin/unpin or keep-N,
  ideally tied to the foreign snapshots' own retention. Commits add small
  rows.

## 8. Adapter contract for the foreign app

With remote deployment, the foreign app exposes (auth via shared secret; the
pattern mirrors `exportReader` in `@caden/data-export`):

1. A paginated **state reader** — `listPage(cursor)` / `get(id)` — for
   reconcile and projections (Convex has no cross-deployment table access;
   some exposed function is unavoidable).
2. An ordered **commit feed** — `commitsSince(cursor)` with stable
   `foreignCommitId`s and a monotonic `seq` (or timestamp + tiebreak); ops
   name the changed entry by its stable foreign `_id` and carry field-level
   before/after.
3. A **tag listing** — label, pinned commit, and the snapshot file reference
   (its existing snapshot export).

Co-deployed, all three collapse to internal queries against the local
tables — the core machinery is untouched.

**Open hosting fork (decide before building the remote transport):** which
app hosts the merged result. If this app hosts, foreign tables port in as
plain schema tables and bindings point at them internally. If the other app
hosts, json-cms installs there as a component (its tables join untouched)
and the UI screens must be package-ified or ported. Both are cheap today —
this app's schema is nearly empty and its backend is one `app.use()` — but
they pull in opposite directions.

## 9. Proof of concept (shipped in this repo)

`app/convex/schema.ts` models the foreign domain as first-class host tables
cohabiting with the component's tables — the cohabitation itself is the
first thing the PoC proves:

- `restaurants` (non-geospatial), `locations` (lat/lng pairs),
  `restaurantLocations` (many-to-many; Red Lobster → 3 locations is the
  running example), and `datasetBindings` (the binding registry, app-side
  for now).
- `app/convex/seed.ts` — `seedRestaurants`, idempotent internalMutation
  (upserts by natural keys; 5 restaurants / 16 locations / 16 links across
  Hampton Roads + Richmond). Runs on any deployment:
  `bunx convex run seed:seedRestaurants` (from `app/`).
- `app/convex/bindings.ts` — `syncRestaurantLocations` finds-or-creates the
  "External demo" collection, the geospatial Point dataset, and the binding
  row, then rebuilds the projection (v1 clear-then-reload) via direct
  component calls (`createSchema`, `deleteEntriesBySchema`,
  `createEntriesBulk` with geometry as a JSON string). `status` reports the
  binding + dataset state. Verified end-to-end on the local dev deployment:
  16 features, correct bbox, `mapTileCacheVersion` bumped, and the dataset
  page/map render the points with zero frontend changes.

What the PoC does not cover yet: commit-tail sync (v1 is full rebuild),
tag/version freezing, the commits table, overlay rendering, and
remote-source transport.

**Read-only marking (phase 1, shipped 2026-09-18):** the component's
`schemas` table carries `source: { name }` (set via `createSchema`), marking
a dataset as a read-only projection of a connected source. The app surfaces
it as a "Synced" badge in `DatasetTypeTags` (all list views), a Source row in
the dataset page details card, and hides the write actions (Edit / Make
geospatial / Bulk Upload / Create Entry / Simplify geometry). Enforcement
lives in the app's `auth` choke point (`app/convex/auth.ts`): entry-targeted
writes, schema-targeted creates, and schema deletes are rejected for bound
datasets, while metadata edits and collection/group organization stay
allowed — the sync bypasses the gate by calling the component directly.
**Sync state + history (shipped 2026-09-18, same phase):** the app-side
`datasetActivity` table records one row per sync — a diff of the projection
against its previous state (keyed by location label; per-sync granularity
until the commit-level feed lands). `bindings.getBySchema` powers the dataset
page's last-synced time and "Out of date" badge (title + Source row;
`sourceUpdatedAt` vs `lastSyncedAt`, shared `isSyncStale` helper), and a
**History** tab (`?view=history`, bound datasets only) renders the sync log
with added/removed/updated counts and field-level before→after detail. The
dashboard sync card uses the same signals. This tab is the seed of phase 4's
commit log: when the foreign commit feed lands, these per-sync rows upgrade
to per-commit rows with author/message.

Remaining for full phase 1: component-level enforcement (needs real auth —
with anonymous access, any client could claim a sync exemption), gating
`startSimplification`/`startGeospatialConversion` (indistinguishable from
organization ops in the current `auth` operation shape), and an
unbind-then-delete flow.

## 10. Phased roadmap (candidate sub-issues, in order)

1. **Read-only bound datasets** — DONE 2026-09-18 for the app-side half:
   `source` marker on the component's `schemas` doc, Synced badge + hidden
   write actions in the UI, and the read-only gate in the app's `auth`
   choke point. Remaining: component-level enforcement + the two
   conversion/simplification ops (see §9).
2. **Source interface + co-deployed sync** — formalize the source descriptor
   (state reader + geometry mapping) and the durable sync workflow with
   reconcile; UI "synced N minutes ago" + Sync button.
3. **Tag ingest + lineage** — freeze versions from snapshot files via the
   import pipeline; lineage fields; versions surfaced in browser/maps;
   auto-ingest (pull + push hook).
4. **Commits + overlay rendering** — `commits` table, commit feed apply as
   the primary sync path, history rail, diff overlay, tag-compare view.
5. **Remote transport (if side-by-side)** — reader/commit-feed/tag adapter
   on the foreign app + cross-deployment auth; retires at the merge.
