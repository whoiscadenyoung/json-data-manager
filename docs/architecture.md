# Architecture

> Last verified against the code 2026-09-30 (post data-platform roadmap, #88).
> For the reasoning behind major decisions, see [`docs/decisions/`](./decisions/);
> for topic designs, the [documentation map](#documentation-map) at the end.

A geospatial JSON data manager: define datasets (JSON Schema), import rows
(JSON/CSV/XLSX/GeoJSON), browse and edit them in tables and on maps, organize
them into collections/groups, and compose saved map views. On top of that
catalog sits a **data platform** layer: signed-in users draft work in
**projects**, derive datasets with declarative transform specs (lookup,
rollup, SQL), and **publish** drafts into an append-only, versioned catalog
that consumers pin or float. It also renders data owned by a _different_
Convex app as read-only "bound datasets" with git-style commits and tag
versions.

The core data layer is not in the app — it is a reusable Convex component,
[`@caden/json-cms`](../packages/json-cms/), which owns the dataset/entry/
geometry/organization tables. The app (`app/`) is a TanStack Start frontend
plus a Convex host that re-exports the component's API through an auth choke
point and adds everything app-specific: Better Auth, bound-datasets sync, the
derived-dataset registry, projects, publish, bundles, and versioned
consumption. **The component never learns projects exist** — nothing
published knows how it was drafted (ADR 0008).

## Workspace layout

Bun workspace (`bun.lock` at the root; use `bun`, not node/npm):

| Path                         | What it is                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/`                       | The application: TanStack Start (React 19) frontend in `app/src`, Convex host functions in `app/convex`.                                                                                                                                                                                                                                                                                                    |
| `packages/json-cms/`         | `@caden/json-cms` — the CMS Convex component (`src/component`), a typed client facade with `exposeApi` (`src/client`), React hooks + prop-driven UI (`src/react`), backend-free shared code (`src/shared`: geojson, references, **coercion** utilities, **transform engine** `src/shared/transform`, exported React-free as `@caden/json-cms/transform`). Keeps its own `example/` app as dev/codegen host. |
| `packages/geometry-archive/` | `@caden/geometry-archive` — PMTiles archive writer + tile logic used by the map tile pipeline (issue #58).                                                                                                                                                                                                                                                                                                  |
| `packages/data-export/`      | `@caden/data-export` — durable snapshot-export component. **Built but not wired in**: no consumer, not registered in `app/convex/convex.config.ts`, not run in CI. Decision pending: wire in as the backup story or archive it.                                                                                                                                                                             |
| `.github/workflows/ci.yml`   | Root CI (see [Development](#development)).                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/`                      | Design docs, decision records, and project memory (see the map at the end).                                                                                                                                                                                                                                                                                                                                 |

## Runtime topology

```
Browser ── TanStack Start (Vite + nitro, bun preset; SSR shell + SPA)
   │  /api/auth/* proxied same-origin to the Convex Better Auth routes
   │  uses @convex-dev/react-query bridge; light queries persist to
   │  sessionStorage for instant re-opens (app/src/integrations/tanstack-query)
   │  client-side compute: transform execution, publish chunking, exports,
   │  DuckDB-WASM analysis (web worker), PMTiles rebuild (web worker)
   ▼
Convex backend (cloud dev when available; local backend is the current
   │  fallback — see "Development")
   ├── component tables  (json-cms: datasets, entries, geometries, org, maps)
   ├── betterAuth component (Better Auth's own user/session/jwks tables)
   ├── host tables       (users mirror, bound-datasets sync state, derived
   │                      registry, projects, publish/bundle checkpoints,
   │                      version references; + foreign-domain stand-ins)
   └── file storage      (source files, geometry blobs, publish chunk blobs,
                          tile archives, snapshot JSONL — served with
                          range-request support)
        ▲
        └── rebuild worker: in-browser worker builds a dataset's PMTiles
            archive (geometry-archive) and installs it via tile_archives.install
```

The app registers two components (`app/convex/convex.config.ts`): `jsonCms`
and `betterAuth`. Component tables are namespace-isolated by Convex, so
component and host tables never collide and need no prefixes. Consequence
everywhere below: host tables reference component rows by **plain-string ids**
(component tables are absent from the host's generated data model), and each
side asks its own tables in turn.

## Data model

Two schemas, deliberately separate.

### Component tables (`packages/json-cms/src/component/schema.ts`)

- **Content** — `schemas` (a dataset: JSON Schema doc, `kind` standard/
  geospatial, denormalized summaries, tile-cache bookkeeping, optional
  `source`/`lineage` read-only markers, `createdBy`, `lifecycle`,
  `publishedVisibility`), `entries` (one row of `data`),
  `geometries` (1:1 with entries that have geometry; JSON-text payload either
  inline under ~1 MiB or as a storage blob — never nested Convex arrays,
  which cap at 8192 elements), `references` (denormalized index of entry-to-
  entry references for reverse lookup), `imports` (batched import tracking).
- **Organization** — `collections` and `groups` (groups may float outside a
  collection; a dataset is in many collections via `schemaCollections` and at
  most one group via `schemas.groupId`).
- **Map views** — `maps`, `mapLayers` (a layer targets a whole collection,
  group, or dataset; collection/group layers expand live at read time),
  `mapLayerOverrides` (per-child visibility, sparse rows).

`schemas` carries three groups of denormalized fields maintained
incrementally by entry/geometry mutations, never recomputed by scan:
`entryCount`/`featureCount` (exact), `boundingBox` (monotonically
non-shrinking — fine for viewports, not exact), and the tile-cache fields
(`mapTileCacheVersion` bumps on every geometry write; `mapTileArchive*` point
at the installed archive and the version it was built from).

Fields added by the data-platform roadmap, all optional/additive (absent =
pre-roadmap behavior) and **written only by host flows** — the `exposeApi`
wrappers deliberately omit them:

| Field                   | Meaning                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createdBy`             | Better Auth user id (`users.authId`), stamped from the auth hook's return as `actorId` (ADR 0007).                                                                                                                                                                                                                |
| `lifecycle`             | `"draft"` or `"published"` (absent = published). Drafts are invisible to catalog reads (filtered server-side) and creator-only.                                                                                                                                                                                   |
| `publishedVisibility`   | `"everyone"` (default) or `"author"`; narrows catalog reads to the creator. Set by `schemas.setVisibility` (creator-only).                                                                                                                                                                                        |
| `lineage` (generalized) | Frozen-version marker: `versionLabel`, `frozenAt`, `snapshotRef` (global "a ref never freezes twice" key), `sourceSchemaId` (draft/bound chain anchor) **or** `sourceKey` (host registry-row chain anchor), `recipe` (the executed spec), `sourceVersions` (`{datasetId, ref?, frozenAt?}` per source at freeze). |

### Host tables (`app/convex/schema.ts`)

Three concerns, currently one schema (segmentation is tracked in #82):

**Identity and data platform**

| Table                            | Purpose                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                          | App mirror of the Better Auth user, keyed `by_authId`/`by_email`; written only by the component's user triggers (`auth.ts`).                                                                                                                |
| `derivedDatasets`                | Derived-dataset registry: one row = one stored transform spec (`spec` is `v.any()`), `dependsOn` edges, `status` draft (builder autosave) / saved. Stores specs only — no rows.                                                             |
| `consumerReferences`             | One version reference a consumer holds on a source: `consumerKind` derived/map/fork, `mode` pin/float, pin identity (`pinnedRef` + `pinnedSchemaId`).                                                                                       |
| `versionPolicies`                | Keep-N and pinned refs for **publish** chains, keyed by chain anchor; absence = defaults. (Bound chains keep theirs on `datasetBindings`.)                                                                                                  |
| `publishAttempts`                | One materialized-publish attempt (syncRuns-pattern durability): uploaded chunk ids, `publishKey` idempotency key, planned schema/kind, executed spec, `importId`, status uploading/importing/completed/failed. `createdBy` = ownership key. |
| `projects`, `projectArtifacts`   | The working container and its membership rows (`artifactKind` dataset/derived/map, plain-string `artifactId`). `projects.artifactCount` is maintained in lockstep.                                                                          |
| `bundleRuns`, `bundleRunMembers` | One bundle press and its per-member checkpoints (status pending/publishing/published/referenced/linked/failed); `bundleRuns.collectionId` is the project→collection link.                                                                   |

**Bound-datasets infrastructure** — `datasetBindings` (registry: source key
→ projected dataset, sync cursor, retention settings), `bindingEntries`
(foreign key → entry map; makes sync idempotent and delete detection
possible), `syncRuns` (checkpointed durable runs), `datasetActivity`
(per-sync history), `commits` (mirror of the applied foreign commit tail),
`tagDeltas` (stored deltas between consecutive frozen versions; publish chains
record theirs here too via `consumption.afterPublishCompleted`).

**Foreign-domain stand-in** — the PoC's "other app": `restaurants`,
`locations`, `restaurantLocations` (join), `sourceCommits` (its git-like
feed), `restaurantSnapshots` (its tag snapshots as JSONL in storage). This
is scaffolding for the real integration; phase 5 (#78, remote transport) is
blocked on the hosting-fork decision — see
[`docs/bound-datasets-design.md`](./bound-datasets-design.md) §8.

Better Auth's own tables live inside the `betterAuth` component and never
appear in either schema.

## Auth and trust model

- **Better Auth inside Convex** (ADR 0006): `app/convex/auth.ts` builds the
  instance (`createAuth`, email + password provider); routes are registered
  lazily in `http.ts` under `/api/auth` and proxied same-origin by
  `app/src/routes/api/auth/$.tsx` → `app/src/lib/auth-server.ts`. Convex
  verifies the component's JWTs via `auth.config.ts` (must stay in sync with
  the `convex()` plugin, or everything reads as signed out). Env per
  deployment: `BETTER_AUTH_SECRET`, `SITE_URL`. Sign-up is open (gating is
  #136). Standalone `ConvexClient`s (the row-resolution seam's client, tile
  and analysis workers) authenticate via `fetchConvexToken`
  (`app/src/lib/convex-auth-token.ts`).
- **`auth(ctx, operation?)` is the single choke point.** Every `exposeApi`
  wrapper and every host function calls it (ADR 0007: the hook receives `fn`
  - CRUD `type` + target ids; its return is the `actorId`/`viewerId` the
    component stamps/filters by — never taken from arguments):
  1. **Sign-in gate** — signed-out callers are rejected with a `ConvexError`.
     The one exception is `users.me`, the app's auth-state probe (returns null
     signed out).
  2. **Visibility** — every dataset an operation names (by schema, entry, or
     import id) must be visible to the caller; denial reads as "not found".
     Enumeration reads carry no ids and are scoped inside the component by
     `viewerId`; batch-id reads filter component-side instead of denying.
  3. **Read-only gate** — writes to bound datasets (`datasetBindings` row) and
     frozen versions (`lineage`) are rejected. The component enforces the
     same rule itself via the host-only `boundWrite` attestation
     (`assertDataWritable`), so this is defense-in-depth.
- **Trust model** ([ADR 0009](./decisions/0009-trusted-collaborator-catalog.md)):
  signed-in users are trusted collaborators. **Published datasets, maps,
  collections and groups are co-editable by any signed-in user by design** —
  there is deliberately no creator check on them. **Drafts
  (`lifecycle: "draft"`) and `publishedVisibility: "author"` rows are
  creator-only.** Opt-in locking of published artifacts is planned in #124.
- **Creator-private host state** (stage 8, #104): projects, project
  membership, bundle runs, publish attempts, and registry drafts answer only
  to their `createdBy`; saved registry rows are catalog-visible. Consumer
  reference and chain-policy mutations are owner-checked, with two recorded
  exceptions — map edges stay signed-in-writable (the component's `maps`
  table carries no creator stamp) and bound-chain policy keeps the tag path's
  signed-in-wide semantics. Foreign rows always read as missing, never as
  forbidden.

## Users and profiles

- `users` mirrors Better Auth users (triggers insert/patch/delete; nothing
  else writes it). Queries in `users.ts`: `me` (own row or null),
  `profileByAuthId` (incl. email), `listProfiles` (authId/name/image only —
  the broadest surface carries no email), `profile` (a user's row plus the
  datasets they created, viewer-scoped so restricted rows stay hidden).
- `schemas.createdBy` = `users.authId`, so "Created by" chips deep-link to
  `/users/$userId` with no resolution hop. Filtering by creator is host-side
  over the component's summaries projection. Pre-auth datasets have no
  `createdBy` (UI hides the chip).

## Backend layout (`app/convex/`)

- **API shims** — `schemas.ts`, `entries.ts`, `collections.ts`, `groups.ts`,
  `maps.ts`, `geometries.ts`, `imports.ts` are thin `exposeApi` re-exports of
  component functions under short names (`api.entries.listPage`, …). The
  module/function names are load-bearing: client call sites, the TanStack
  Query persist allowlist (`app/src/integrations/tanstack-query/light-namespaces.ts`),
  and saved query hashes all key on them. Every shim passes the host `auth`.
  `schemas.ts` also adds `listDraftSummaries` (opt-in creator-scoped drafts
  read), `setVisibility`, and `maxTileCacheVersion`.
- **Identity** — `auth.ts`, `auth.config.ts`, `http.ts`, `users.ts` (above).
- **Platform layer** — `derivedDatasets.ts`/`derivedSpec.ts` (registry),
  `projects.ts`, `publish.ts`, `bundles.ts`, `consumption.ts`,
  `versioning.ts` (sections below).
- **Bound-datasets layer** — `sources.ts` (the `BoundSource` descriptor
  interface + registry: adding a source = one entry), `sync.ts` (durable
  engine: collect → chunked apply, keyed and idempotent via `bindingEntries`;
  commit-tail is the primary path, full pass falls back or reconciles),
  `tags.ts` (snapshot ingest: freeze foreign snapshots into read-only
  lineage datasets via `versioning.ts`, version compare, keep-N/pin
  retention), `bindings.ts` (binding status/unbind queries for the UI).
  Weekly reconcile cron in `crons.ts`.
- **Foreign-domain CRUD** — `dashboard.ts` (restaurants/locations/links CRUD
  for `/dashboard`; every write only stamps staleness on the binding) and
  `seed.ts`.
- **Tile install** — `tile_archives.ts` — deliberately NOT an exposeApi
  export: `install` is a host wrapper around the component's
  `setMapTileArchive` so only the rebuild worker (standalone ConvexClient)
  can install archives; the expectedVersion guard makes an edit-raced
  rebuild self-discard. `schemas.maxTileCacheVersion` is the one-number cache
  buster for persisted client state.

## Projects and the draft layer

- A **project** is the virtual working layer (ADR 0008): imports, transform
  specs and map arrangements are drafted in it, then crossed into the catalog
  by publish. Membership is `projectArtifacts` rows naming plain-string ids —
  references, never copies or containment. Publish is per-artifact; a project
  itself has no lifecycle state.
- **Drafts** are ordinary component datasets with `lifecycle: "draft"`.
  `projects.createDraftDataset` creates the draft (host-only flag) and the
  membership row in one transaction; the existing import flow
  (`imports.generateUploadUrl`/`startImport`) then fills it unchanged. Drafts
  are filtered from catalog reads server-side (`listSchemaSummaries`,
  `maxTileCacheVersion`); `schemas.listDraftSummaries` is the opt-in,
  creator-scoped read behind the datasets browser's drafts toggle.
- **Fork** = add to project: `projects.addArtifact` mints a `fork`
  `consumerReferences` float edge per dataset membership (`removeArtifact`
  deletes it); `projects.forkAsSpec` creates a saved identity-transform
  registry row over a source and adds it as a member.
- Surfaces: `/projects` (creator's list), `/projects/$projectId` (workspace:
  members, bundle press status).

## Derived datasets and the transform engine

- **Engine** (`packages/json-cms/src/shared/transform`, React-free via
  `@caden/json-cms/transform`): pure functions over generic records,
  inputs never mutated, joined through the shared coercion utilities
  (`normalizeKey`: number `42` joins string `"42"`; trimmed, case-folded,
  never numeric-normalized). Operation kinds form a discriminated union on
  `TransformSpec.operations`:

  | Kind     | Function      | Notes                                                                                                                                            |
  | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `lookup` | `applyLookup` | Left/inner join on a key; duplicate-key policy first/last/error; match-rate diagnostics; optional `geometrySource` (spec field).                 |
  | `rollup` | `applyRollup` | Group-by + measures; keyless rows dropped and counted; chains with a follow-up lookup to join back.                                              |
  | `sql`    | `applySql`    | Async; takes an injected `SqlEngine` (DuckDB-WASM in the app); single-statement gate, typed columns from declared structure; reports truncation. |

- **Registry** (`derivedDatasets.ts`, `derivedSpec.ts`): stores specs only.
  `validateSpecShape` (structural, additive so new kinds need no migration),
  save-time cycle rejection over the persisted `dependsOn` edges (DAGs of
  derived-of-derived allowed), and `specStatus` health computed on read
  (`ready` / `stale` / `orphaned` — there is no completion hook to mark
  staleness). Catalog-level, never map-level (ADR 0005); a derived dataset is
  virtual — no entries/geometries rows, no boundingBox.
- **Execution is client-side** (Convex only stores specs): the Transform tab
  on the dataset page (`transform-builder.tsx`, `transform-preview.tsx` with
  match-rate stats), export enrichment ("include joined fields" in
  `lib/export.ts`), popup enrichment at seam point reads, and publish
  (`lib/publish-spec.ts`). Anything virtual becomes real only by
  [publishing](#publish-and-freeze-path).

## Row-resolution seam

`app/src/lib/dataset-rows.ts` (React-free, shared with the tile worker) and
`dataset-rows-react.tsx` (hooks) are the one client-side interface for
"resolve this dataset's rows". No surface paginates on its own: cursor
chaining, page-size constants, and completeness semantics live here.

- **Two row shapes** — entries (`entries.listPage`, cursor-chained) and
  geometry (`geometries.list`, byte-budget pages; the budget is a
  server-side clamp inside the component).
- **Consumers** — the dataset table, export dialogs, map layers, popup/entry
  reads, version diff overlays, `TransformPreview`, the tile-archive worker,
  the publish orchestrator, and the analysis worker.
- **Spec application** — point reads run the lookup-spec fold
  (`applyEntryRowSpec`, the popup executor: never throws, never drops a
  popup). The **bulk** step inside the seam (`applyEntryRowSpecs`) is still
  identity; bulk enrichment is applied by the callers that want it (export,
  transform preview, publish execution) over rows the seam fetched.
- `src/lib/version-rows.ts` holds the natural-key rule shared with the
  server's version-delta code so diff ops and overlay rows line up.

## Publish and freeze path

Publish materializes a draft dataset or a saved derived spec into an ordinary
frozen, versioned dataset through the existing ingest machinery. Append-only:
a republish is a new attempt and a new immutable row (vN+1); nothing merges
back.

1. **`publish.start`** resolves the target (caller's own saved registry row
   or draft dataset), mints the `publishKey` once per attempt, and
   joins-or-revives an active attempt (stale after 2 min of no progress).
2. **Client executes** (`app/src/lib/publish.ts`, `publish-spec.ts`): rows via
   the seam, spec applied once (lookup → rollup → sql; `geometrySource`
   pairing preserved), chunked with `chunkRowsForImport`, each chunk uploaded
   and registered on the attempt (`registerChunk`), so a resumed browser
   uploads only missing chunks.
3. **`publish.freeze`** is one transaction: re-check `publishKey` globally,
   refuse an orphaned/stale spec (`specStatus`), call the shared
   `versioning.createFrozenVersion` (frozen row born `lifecycle: "published"`
   with generalized `lineage`, inheriting the draft's `publishedVisibility`),
   and start the component import workflow with the publish flow's
   `boundWrite` attestation. After that, durability is the workflow's;
   `pollImport` mirrors the outcome onto the attempt, and
   `consumption.afterPublishCompleted` runs retention and records the chain
   delta.

- **`versioning.ts`** is the generalized frozen-version machinery extracted
  from the tag path (no behavior change): `createFrozenVersion`,
  `freezeVersion` (tag ingest), keep-N retention (`DEFAULT_KEEP_VERSIONS` =
  10, pinned refs never auto-retire), sequential version deltas. Tag ingest
  and publish share one implementation.
- Frozen rows are read-only by `lineage` (component `assertDataWritable`).

## Versioned consumption

`consumption.ts` (ADR 0008; lifecycle design §7) — the consumer contract on
top of frozen chains.

- **Chain anchors**: a draft-published chain anchors on a component row
  (`lineage.sourceSchemaId`); a derived-published chain on the registry id
  (`lineage.sourceKey`, versions = completed `publishAttempts`). Bound
  datasets' tag chains anchor on the binding. One `FrozenVersion` shape lets
  the versioning cores drive all three.
- **References**: `consumerReferences` rows, pin or float per edge. Writers:
  registry save (one float row per spec dependency), sync/revert/pin
  mutations, the bundle press's map leg, and project forks.
- **Badges**: `sourceBadges` compares a row's recorded
  `lineage.sourceVersions` with the source chain's current head
  (`current` / `drift` / `live` / `missing`); only completed attempts count as
  heads. Propagation through derived chains is transitive by construction.
- **Actions**: `syncReference` (reference consumer: repin to head; derived
  consumer: client re-runs `publishDataset`), `revertReference` (repin to the
  prior version), `setReferenceMode` (float/pin), `setChainKeep` /
  `setChainVersionPinned` (policy in `versionPolicies`), `consumedBy`
  (reverse projection; fork edges surface only to their own project's
  creator), `chainVersions`, `storedDelta` (diff via `tagDeltas`).
- **UI**: `components/dataset-consumption.tsx` (badges, sync/revert,
  consumed-by), `version-compare.tsx`.
- A pinned version that was retired resolves to nothing and map layers over
  it are suppressed rather than falling back to newer rows.

## Bundles

`bundles.ts` + `app/src/lib/bundle-publish.ts` — one project publishes as one
bundle: a collection plus its maps plus the datasets they reference.

- **`bundleClosure`** (pure) computes the plan: project memberships plus every
  dataset each map's layers reach (collection/group layers expand live),
  deduped; drafts publish only if the project holds them (a foreign draft
  found via live expansion is dropped, never frozen by someone else's press);
  already-published datasets join as members without a new version; derived
  members publish in dependency order; derived sources stay private
  (lineage-only provenance).
- **Press legs** (client-driven loop over `bundleRunMembers`): `start`
  (creates or joins the run) → per-member `publishDataset` + `recordMember` →
  `promoteCollection` (create-once/reuse component collection, file frozen
  rows, re-attach groups) → `linkMapLayers` (one float `map` reference per
  direct dataset layer target) → `completeRun`.
- Per-member atomicity: a failed member leaves the bundle partial; completed
  members keep their frozen rows. A re-press re-promotes every member (new
  versions); the bundle itself is unversioned.
- **Layer resolution**: layer targets are chain anchors; `layerResolutions`
  and `consumption.resolveSourceHead` resolve float → head, pin → pinned row,
  so maps keep their layer structure across republishes.

## Sharing and visibility model

| Artifact                                           | Visible to                     | Writable by                                  |
| -------------------------------------------------- | ------------------------------ | -------------------------------------------- |
| Draft dataset (`lifecycle: "draft"`)               | creator                        | creator                                      |
| Registry draft (builder autosave)                  | creator                        | creator                                      |
| Project, membership, bundle run, attempt           | creator                        | creator                                      |
| Published dataset, `publishedVisibility: "author"` | creator                        | creator                                      |
| Published dataset, default (`"everyone"`)          | any signed-in user             | any signed-in user (ADR 0009; locking #124)  |
| Saved registry row (derived dataset)               | any signed-in user             | creator (owner-checked)                      |
| Maps, collections, groups                          | any signed-in user             | any signed-in user (ADR 0009)                |
| Frozen versions / bound datasets                   | per their dataset's visibility | nobody (read-only; organization ops allowed) |

`publishedVisibility` is the authoring-time choice and crosses the
draft→published line with the data (the frozen row inherits it). Denials are
indistinguishable from "not found".

## Analysis layer

Client-side SQL over the same rows (`docs/analysis-layer-design.md`; stage 9).
There is no server-side analytics path.

- **An analysis is a registry row** whose spec carries a `sql` operation
  (`derivedDatasets.summaries` exposes `carriesSql`), so it saves, joins
  projects as `derived`, and publishes through the normal lifecycle with no
  new concepts.
- **Resolve-then-feed**: `consumption.analysisTargets` resolves each referenced
  dataset server-side through the same `resolveSourceHead` core as map layers
  (identity / float / registry / missing), then the worker registers the
  resolved component ids. v1 authors over component datasets only (registry
  ids report `registry`).
- **Execution**: `app/src/lib/analysis.ts` (main-thread run manager, one run
  at a time, lazy worker), `analysis.worker.ts` (pages every table through the
  seam, types columns from declared structure, runs `applySql`),
  `analysis-duckdb.ts` (lazy single-threaded DuckDB-WASM with a memory limit),
  `analysis-caps.ts` (`MAX_ANALYSIS_RESULT_ROWS` = 10,000; truncation always
  reported, publish refuses truncated results). The worker authenticates via a
  token round-trip to the main thread.
- **UI**: the dataset page's **Analyze** tab (`components/analysis-panel.tsx`).
- Parquet sidecar (DuckDB range reads over a per-version artifact) is
  deferred; the registration path is shaped so it can substitute for
  streaming.

## Import, export, and the two geometry paths

Import: the client parses (CSV/XLSX/JSON/GeoJSON via json-cms react parsers),
chunks rows, uploads chunk blobs, and drives the component's workflow-driven
`imports` progress. Optional: retain the source file, simplify geometry to
6dp, or convert lat/lng columns to geometry (`geospatial-conversion-panel`).
Imports never mutate existing data; new data lands as a draft in a project or
as a plain dataset.

Reading geometry has two paths, chosen per dataset by `app/src/lib/layer-source.ts`:

- **Row path** — byte-budget pagination (`geometries.list`, ~5 MB/page,
  500-row ceiling) rendered as GeoJSON. Small datasets, always available.
- **Tile path** — for datasets with an installed PMTiles archive: the map
  requests tiles through the pmtiles protocol (`pmtiles-protocol.ts`), backed
  by HTTP range requests against storage, with a 256 MB OPFS LRU
  (`tile-archive-cache.ts`) making repeat opens fetch zero archive bytes. A
  browser worker (`tile-archive.worker.ts` + geometry-archive) rebuilds
  archives after edits; version guards discard stale builds.

The tile path exists because the 2026-09 audit measured the row path at
46.55 MB for one real dataset — see
[`docs/map-performance-audit-2026-09-16.md`](./map-performance-audit-2026-09-16.md).

Exports (`lib/export.ts`, GeoJSON/JSON/XLSX) read rows through the seam and
can fold saved transform specs in as extra columns.

## Frontend layout (`app/src/`)

- **Routes** (TanStack file-based routing): `/datasets` (+ per-dataset
  detail/edit/bulk-upload/entry; detail tabs Overview, Entries, History
  (bound only), Structure, Transform, Analyze), `/collections`, `/groups`,
  `/maps`, `/projects` (+ `$projectId`), `/users/$userId`, `/signin`,
  `/dashboard` (the foreign-domain CRUD surface), `/api/auth/$` (Better Auth
  proxy). The sign-in gate is server-side; the header shows the sign-in link
  and project pages render a signed-out state.
- **`components/ui/map.tsx`** — the app's MapLibre kit (~15 components: Map,
  Marker/Popup, Controls, GeoJSON/VectorTiles/Arc/Cluster layers). Per-page
  map components (`entries-map`, `group-map`, `layers-map`, `datasets-map`,
  `diff-overlay-map`) compose it; they share orchestration that is a known
  duplication target (#82).
- **`components/niko-table/`** — vendored third-party table library
  (niko-table), ~11.7k lines, consumed only by `entries-table.tsx`.
  Vendor-boundary cleanup tracked in #82.
- **State** — Convex via the `@convex-dev/react-query` bridge; no global
  store. Light query namespaces persist for instant re-opens; persisted state
  is invalidated by `maxTileCacheVersion`.

## Development

```bash
bun install
bun --filter=app run dev     # app (vite + convex dev)
bun run test                # vitest — the app workspace only
bunx tsc --noEmit           # from app/ — the app has no typecheck script
bun run lint                # oxlint (type-aware) at the root
```

Component-package changes need a rebuild before the app picks them up:
`bun run build` inside `packages/json-cms` (the app consumes `dist`).
json-cms develops against its own `example/` host (`bun run dev` there runs
backend + example + codegen watch) and carries its own vitest suite.

**CI** (`.github/workflows/ci.yml`, one job on PRs and pushes to `main`):
build json-cms and geometry-archive dists, then lint, typecheck (json-cms,
geometry-archive, app), and test (json-cms, geometry-archive, app). Not
gated: `oxfmt --check` (pre-existing unformatted files), `data-export`
tests, deploys. App tests whose imports reach `env.ts` must `vi.mock("#/env")`
(CI has no `.env.local`).

Deployment has been volatile — the cloud dev deployment was disabled on
free-plan limits (2026-09-19) and the app currently runs against a local
Convex backend; the working env-file recipe and the warnings (plain
`convex dev` from `app/` can re-select cloud and rewrite `.env.local`) live
in project memory (`docs/memory/`) rather than here, because this section
ages fast.

## Documentation map

| Doc                                                                            | Status                | What it holds                                                                                                                          |
| ------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`bound-datasets-design.md`](./bound-datasets-design.md)                       | current               | The full bound-datasets design: concept mapping, data model, sync, tag ingest, adapter contract, PoC status, phased roadmap (#72–#78). |
| [`derived-datasets-design.md`](./derived-datasets-design.md)                   | implemented           | Transform-spec design (lookup, rollup, composition); ADR 0005.                                                                         |
| [`catalog-lifecycle-design.md`](./catalog-lifecycle-design.md)                 | implemented           | Projects, draft→publish, versioned consumption, bundles; ADR 0008.                                                                     |
| [`analysis-layer-design.md`](./analysis-layer-design.md)                       | implemented           | DuckDB-WASM analysis design; Parquet sidecar still deferred.                                                                           |
| [`data-platform-roadmap.md`](./data-platform-roadmap.md)                       | complete (2026-09-29) | Phase 0 + stages 1–9 (umbrella #88).                                                                                                   |
| [`code-review-2026-09-30.md`](./code-review-2026-09-30.md)                     | historical record     | Post-roadmap full-repo review; known defects tracked under umbrella #123.                                                              |
| [`map-performance-audit-2026-09-16.md`](./map-performance-audit-2026-09-16.md) | historical record     | The audit that produced #48–#55; method + measurements still cited by the geometry path.                                               |
| [`gis-geometry-transport-survey.md`](./gis-geometry-transport-survey.md)       | research (2026-09-17) | Survey of how major GIS platforms transport geometry; rationale companion to the tile path.                                            |
| [`decisions/`](./decisions/)                                                   | living log            | Numbered decision records (ADR-style), 0001–0009.                                                                                      |
| [`memory/`](./memory/MEMORY.md)                                                | living log            | Project memory: durable lessons, verification gotchas, per-initiative records. Policy in the repo `AGENTS.md`.                         |

## Known gaps

- **Known defects** are catalogued in
  [`code-review-2026-09-30.md`](./code-review-2026-09-30.md) and tracked
  under umbrella issue **#123** (children #124–#139) — including the
  storage-id authorization chain, derived-chain retention after retirement,
  PMTiles run dedupe, DuckDB lockdown, and sync caps. Not repeated here.
- **Published artifacts are co-editable** by design (ADR 0009); opt-in
  locking is #124, and sign-up gating is #136.
- **Parquet sidecar deferred** — analysis streams rows through the seam; no
  per-version Parquet artifact exists.
- **#78 remote transport blocked** — bound datasets sync only from the local
  foreign-domain stand-in until the hosting-fork decision lands.
- **#71 tile verification debt** — cloud range-request parity unverified,
  one undiagnosed worker error, multi-tab rebuild convergence covered only by
  unit tests.
- **`@caden/data-export` is unwired** — the backup story exists as a package
  but nothing registers or calls it, and CI does not run its tests.
- **#82** records a full architecture review (monolith splits, vendor
  boundary, host-schema segmentation) as reference-only; nothing there is
  approved work.
