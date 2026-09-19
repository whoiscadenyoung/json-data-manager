# Architecture

> Last verified against the code 2026-09-19. For the reasoning behind major
> decisions, see [`docs/decisions/`](./decisions/); for topic designs, the
> [documentation map](#documentation-map) at the end.

A geospatial JSON data manager: define datasets (JSON Schema), import rows
(JSON/CSV/XLSX/GeoJSON), browse and edit them in tables and on maps, organize
them into collections/groups, and compose saved map views. It also renders
data owned by a *different* Convex app as read-only "bound datasets" with
git-style commits and tag versions.

The core data layer is not in the app — it is a reusable Convex component,
[`@caden/json-cms`](../packages/json-cms/), which owns the dataset/entry/
geometry/organization tables. The app (`app/`) is a TanStack Start frontend
plus a thin Convex host that re-exports the component's API and adds a
bound-datasets sync layer on top.

## Workspace layout

Bun workspace (`bun.lock` at the root; use `bun`, not node/npm):

| Path | What it is |
| --- | --- |
| `app/` | The application: TanStack Start (React 19) frontend in `app/src`, Convex host functions in `app/convex`. |
| `packages/json-cms/` | `@caden/json-cms` — the CMS Convex component (`src/component`), a typed client facade with `exposeApi` (`src/client`), React hooks + prop-driven UI (`src/react`), backend-free shared geojson/reference code (`src/shared`). Keeps its own `example/` app as dev/codegen host. |
| `packages/geometry-archive/` | `@caden/geometry-archive` — PMTiles archive writer + tile logic used by the map tile pipeline (issue #58). |
| `packages/data-export/` | `@caden/data-export` — durable snapshot-export component. **Built but not wired in**: no consumer, not registered in `app/convex/convex.config.ts`. Decision pending: wire in as the backup story or archive it. |
| `docs/` | Design docs, decision records, and project memory (see the map at the end). |

## Runtime topology

```
Browser ── TanStack Start (Vite + nitro, bun preset; SSR shell + SPA)
   │  uses @convex-dev/react-query bridge; light queries persist to
   │  sessionStorage for instant re-opens (app/src/integrations/tanstack-query)
   ▼
Convex backend (cloud dev when available; local backend is the current
   │  fallback — see "Development") 
   ├── component tables  (json-cms: datasets, entries, geometries, org, maps)
   ├── host tables       (bound-datasets sync state + foreign-domain stand-ins)
   └── file storage      (source files, geometry blobs, tile archives,
                          snapshot JSONL — served with range-request support)
        ▲
        └── rebuild worker: in-browser worker builds a dataset's PMTiles
            archive (geometry-archive) and installs it via tile_archives.install
```

The app registers exactly one component (`app/convex/convex.config.ts`):
`jsonCms`. Component tables are namespace-isolated by Convex, so component
and host tables never collide and need no prefixes.

## Data model

Two schemas, deliberately separate.

### Component tables (`packages/json-cms/src/component/schema.ts`)

- **Content** — `schemas` (a dataset: JSON Schema doc, `kind` standard/
  geospatial, denormalized summaries, tile-cache bookkeeping, optional
  `source`/`lineage` read-only markers), `entries` (one row of `data`),
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

`datasets` (the `schemas` table) carries three groups of denormalized fields
maintained incrementally by entry/geometry mutations, never recomputed by
scan: `entryCount`/`featureCount` (exact), `boundingBox` (monotonically
non-shrinking — fine for viewports, not exact), and the tile-cache fields
(`mapTileCacheVersion` bumps on every geometry write; `mapTileArchive*` point
at the installed archive and the version it was built from).

### Host tables (`app/convex/schema.ts`)

Two concerns, currently one schema (segmentation is tracked in #82):

- **Bound-datasets infrastructure** — `datasetBindings` (registry: source key
  → projected dataset, sync cursor, retention settings), `bindingEntries`
  (foreign key → entry map; makes sync idempotent and delete detection
  possible), `syncRuns` (checkpointed durable runs), `datasetActivity`
  (per-sync history), `commits` (mirror of the applied foreign commit tail),
  `tagDeltas` (stored deltas between consecutive frozen versions).
- **Foreign-domain stand-in** — the PoC's "other app": `restaurants`,
  `locations`, `restaurantLocations` (join), `sourceCommits` (its git-like
  feed), `restaurantSnapshots` (its tag snapshots as JSONL in storage). This
  is scaffolding for the real integration; phase 5 (#78, remote transport) is
  blocked on the hosting-fork decision — see
  [`docs/bound-datasets-design.md`](./bound-datasets-design.md) §8.

## Backend layout (`app/convex/`)

- **API shims** — `schemas.ts`, `entries.ts`, `collections.ts`, `groups.ts`,
  `maps.ts`, `geometries.ts`, `imports.ts` are thin `exposeApi` re-exports of
  component functions under short names (`api.entries.listPage`, …). The
  module/function names are load-bearing: client call sites, the TanStack
  Query persist allowlist (`app/src/integrations/tanstack-query/light-namespaces.ts`),
  and saved query hashes all key on them. Every shim passes the host `auth`.
- **auth.ts** — the single choke point inside `exposeApi`. Identity is a
  constant `"anonymous"` (real auth is a standing TODO). It also rejects
  writes to read-only datasets (bound or frozen-version) as a friendly first
  line; the component itself enforces the same rule via its `boundWrite`
  attestation, so the gate is defense-in-depth, not the only wall.
- **Bound-datasets layer** — `sources.ts` (the `BoundSource` descriptor
  interface + registry: adding a source = one entry), `sync.ts` (durable
  engine: collect → chunked apply, keyed and idempotent via `bindingEntries`;
  commit-tail is the primary path, full pass falls back or reconciles),
  `tags.ts` (snapshot ingest: freeze foreign snapshots into read-only
  lineage datasets, version compare, keep-N/pin retention), `bindings.ts`
  (binding status/unbind queries for the UI). Weekly reconcile cron in
  `crons.ts`.
- **Foreign-domain CRUD** — `dashboard.ts` (restaurants/locations/links CRUD
  for `/dashboard`; every write only stamps staleness on the binding) and
  `seed.ts`.
- **Tile install** — `tile_archives.ts` — deliberately NOT an exposeApi
  export: `install` is a host wrapper around the component's
  `setMapTileArchive` so only the rebuild worker (standalone ConvexClient)
  can install archives; the expectedVersion guard makes an edit-raced
  rebuild self-discard. `schemas.maxTileCacheVersion` is the one-number cache
  buster for persisted client state.

## Import, export, and the two geometry paths

Import: the client parses (CSV/XLSX/JSON/GeoJSON via json-cms react parsers),
chunks rows, uploads chunk blobs, and drives the component's workflow-driven
`imports` progress. Optional: retain the source file, simplify geometry to
6dp, or convert lat/lng columns to geometry (`geospatial-conversion-panel`).

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

## Frontend layout (`app/src/`)

- **Routes** (TanStack file-based routing): `/datasets` (+ per-dataset
  detail/edit/bulk-upload/entry), `/collections`, `/groups`, `/maps`,
  `/dashboard` (the foreign-domain CRUD surface).
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
bun test                     # vitest across workspaces
bunx tsc --noEmit            # from app/ — the app has no typecheck script
bun run lint                 # oxlint (type-aware) at the root
```

Component-package changes need a rebuild before the app picks them up:
`bun run build` inside `packages/json-cms` (the app consumes `dist`).
json-cms develops against its own `example/` host (`bun run dev` there runs
backend + example + codegen watch).

Deployment has been volatile — the cloud dev deployment was disabled on
free-plan limits (2026-09-19) and the app currently runs against a local
Convex backend; the working env-file recipe and the warnings (plain
`convex dev` from `app/` can re-select cloud and rewrite `.env.local`) live
in project memory (`docs/memory/`) rather than here, because this section
ages fast.

## Documentation map

| Doc | Status | What it holds |
| --- | --- | --- |
| [`bound-datasets-design.md`](./bound-datasets-design.md) | current | The full bound-datasets design: concept mapping, data model, sync, tag ingest, adapter contract, PoC status, phased roadmap (#72–#78). |
| [`map-performance-audit-2026-09-16.md`](./map-performance-audit-2026-09-16.md) | historical record | The audit that produced #48–#55; method + measurements still cited by the geometry path. |
| [`gis-geometry-transport-survey.md`](./gis-geometry-transport-survey.md) | research (2026-09-17) | Survey of how major GIS platforms transport geometry; rationale companion to the tile path. |
| [`decisions/`](./decisions/) | living log | Numbered decision records (ADR-style). |
| [`memory/`](./memory/MEMORY.md) | living log | Project memory: durable lessons, verification gotchas, per-initiative records. Policy in the repo `AGENTS.md`. |

## Known gaps

- **No real auth** — identity is `"anonymous"` everywhere.
- **`@caden/data-export` is unwired** — the backup story exists as a package
  but nothing registers or calls it.
- **No CI** — tests and typecheck run locally only.
- **#82** records a full architecture review (monolith splits, vendor
  boundary, host-schema segmentation) as reference-only; nothing there is
  approved work.
