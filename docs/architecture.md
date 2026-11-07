# Architecture

> Last verified against the code 2026-11-07 (the project-centric train's
> closeout, #262). The pre-migration Convex architecture this page used to
> describe survives in git history and in the untouched in-tree archive
> (`app/convex/` + `packages/json-cms/src/component/`); for the reasoning
> behind major decisions, see [`docs/decisions/`](./decisions/), and for
> topic designs, the [documentation map](#documentation-map) at the end.

A geospatial JSON data manager on self-hosted Supabase. Signed-in users work
inside **projects** — the primary working context: a project's catalog holds
datasets (created in-project as owned drafts, or added by reference with
pin/float/sync), declares **relations** between datasets (key or spatial),
composes project-owned **maps** from first-class **layers**, and publishes
**apps** whose map widgets reference stored project maps. Publishing freezes
artifacts into an append-only, versioned catalog under a single visibility
ladder (`members | signed-in | link | public`) with closure preflight; a
published app serves signed-out visitors from its frozen snapshot. The
datasets/maps/apps/collections tabs are **explorers** — browsable views over
everything the viewer can see — never creation surfaces.

## Workspace layout

Bun workspace (`bun.lock` at the root; use `bun`, not node/npm):

| Path                         | What it is                                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/`                       | The application: TanStack Start (React 19, vite + nitro) frontend in `app/src` over self-hosted Supabase.                                                                                                                                                              |
| `supabase/`                  | The backend: numbered SQL migrations (`0001`–`0024`), storage buckets, seed; the Docker compose stack lives in `demo/` (kong one-origin :8000).                                                                                                                        |
| `packages/ui/`               | `@caden/ui` — source-only (ADR 0014): the shadcn base-mira primitives, niko-table, mapcn's MapLibre kit, theme tokens.                                                                                                                                                 |
| `packages/maps/`             | `@caden/maps` — source-only (ADR 0014): shared PMTiles protocol instance, OPFS tile-archive cache, rebuild scheduler, bounded fetch pool. The app-side managers + worker live in `app/src/features/maps/`.                                                             |
| `packages/layer-styles/`     | `@caden/layer-styles` — source-only (ADR 0014): stored-style validators, compile, classify, palettes, legend, SDF, style.json exchange.                                                                                                                                |
| `packages/analysis/`         | `@caden/analysis` — source-only (ADR 0014): lazy DuckDB-WASM SQL engine (lockdown + memory limit) and row caps.                                                                                                                                                        |
| `packages/geometry-archive/` | `@caden/geometry-archive` — PMTiles archive writer + tile logic for the tile pipeline (issue #58).                                                                                                                                                                     |
| `packages/data-core/`        | `@caden/data-core` — backend-free shared code: `/geojson` (types, validation, bbox, geometry validators), `/coercion`, `/reference`, `/coordinate-columns`, and the **transform engine** `/transform`.                                                                 |
| `packages/importers/`        | `@caden/importers` — browser-side tabular import parsers (JSON/JSONL, CSV, Excel) behind a pluggable registry, plus `parseDataRows`.                                                                                                                                   |
| `packages/json-cms/`         | `@caden/json-cms` — **archived Convex component** (the pre-migration backend); its `react/ui` kit (SchemaEditor, DatasetImporter, shared dialogs) is still the app's UI source for those surfaces. In-tree untouched; do not build features against its component API. |
| `packages/data-export/`      | `@caden/data-export` — durable snapshot-export component. **Built but not wired in** (no consumer; latent defects parked on #137).                                                                                                                                     |
| `.github/workflows/ci.yml`   | Root CI (see [Development](#development)).                                                                                                                                                                                                                             |
| `docs/`                      | Design docs, decision records, and project memory (see the map at the end).                                                                                                                                                                                            |

**Module boundaries (ADR 0014, amended).** The frontend is core
(`app/src/components`, `app/src/lib`, `app/src/integrations`) plus domain
features in `app/src/features/<name>/` (`datasets`, `catalog`, `maps`,
`publishing`, `versions`, `analysis`, `app-builder`, `layer-styles`).
Domain features may import each other's root entry files (`#/features/<name>`)
as long as the graph stays acyclic; optional modules (`app-builder`,
`layer-styles`) are wired only by routes; core never imports features; feature
subfolders are private. `.oxlintrc.json` enforces this with
`no-restricted-imports` + `import/no-cycle`. Every cross-feature read of data
goes through the **store modules** in `app/src/lib/store/` (core seams, one
per PG domain) — features never talk to `supabase-js` directly.

## Runtime topology

```
Browser ── TanStack Start (vite + nitro; SSR shell + SPA)
   │  auth: Better Auth on the SSR side (@supabase/ssr cookie session),
   │  data: supabase-js v2 — PostgREST (REST + RPC), Realtime, Storage
   │  client-side compute: import parsing, transform execution, publish
   │  chunking, DuckDB-WASM analysis (web worker), PMTiles rebuild (worker)
   ▼
Supabase (self-hosted Docker stack, one kong origin :8000)
   ├── Postgres 15 + PostGIS — all tables, RLS on everything (§ data model)
   ├── PostgREST — the only data API; RPCs for search/import/publish/relations
   ├── GoTrue — auth (signup closed; seeded accounts)
   ├── Realtime — postgres_changes publication (0013, extended per phase)
   └── Storage — source-files, tile archives, markers, sync-chunks buckets
       (frozen- path convention = the anon serving leak guard, 0024)
```

Every table is RLS-gated; the client's anon key is untrusted. Roles resolve
through `project_members` (ADR 0017); visibility rungs widen reads
(ADR 0022); anon SELECT policies exist only on frozen version rows and the
`frozen-` storage path convention (ADR 0023) — live tables have no anon
policies. SECURITY DEFINER helpers back the policy subqueries (policy
subqueries evaluate under the invoking role and would read zero anon rows).

## Data model (Postgres)

| Domain         | Tables                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Identity       | `profiles` (trigger-maintained from auth; ADR 0009's creator chip resolves here)                                     |
| Catalog core   | `datasets`, `entries`, `geometries`, `imports`, `entry_references`                                                   |
| Organization   | `collections`, `collection_datasets`, `groups`                                                                       |
| Versions       | `dataset_versions`, `version_entries`, `tags`, `consumer_references`, `version_policies`                             |
| Derived        | `derived_datasets` (registry rows; transform specs)                                                                  |
| Projects       | `projects`, `project_members` (owner/editor/viewer), `project_artifacts` (owned/linked × manual/auto, kinds `dataset | derived | layer | app`) |
| Layers & maps  | `layers`, `layer_children`, `layer_versions`, `maps`, `map_layers` (placements)                                      |
| Relations      | `dataset_relations` (key/spatial; catalog-level per D3) + the bounded `dataset_relation_records` RPC                 |
| Apps           | `apps` (project-owned; pages/widgets jsonb; map widgets carry `mapId`), `app_versions` (frozen snapshots)            |
| Publishing     | `publish_bundles`, `publish_bundle_members`, `sync_runs`, `publish_attempts`                                         |
| Bound datasets | `remote_sources`, `dataset_bindings`, `binding_entries`, `commit_mirror` (the foreign-app PoC)                       |
| Sprites        | `marker_sprites` (uploaded point markers; ADR 0013)                                                                  |

Migrations are numbered `0001`–`0024` and sorted by name on apply; every new
migration must apply on a fresh DB. The DDL authority is
[`docs/supabase-migration-design.md`](./supabase-migration-design.md) §3;
the per-phase deltas are the train ADRs (0017–0023).

## The project-centric model

- **Datasets are global + membership** (D1): a dataset lives in the global
  catalog; projects hold it as an **owned** artifact (created in-project,
  born a member-visible draft) or a **linked** reference (pin at head, or
  float with `sync_mode auto`; sync/revert actions move the edge).
- **Layers** are the style/filter/popup unit — never touching data — so one
  dataset renders differently in many maps. **Maps** are project-owned
  compositions of layer memberships; `/maps` is an explorer only.
- **Relations** are catalog-level rows (D3): both ends' own gates are the
  RLS; any project holding both datasets may consume them. The map runtime
  highlights related records on click (bounded, index-backed RPC).
- **Apps** freeze at publish into `app_versions` snapshots (dataset pins +
  map snapshots + flattened layer versions) that render signed-out.
- **Visibility** is one ladder on every artifact (D4) with closure:
  `visibility_preflight` diffs the promotion, `visibility_apply` widens the
  graph in one transaction; the bundle press stamps + applies per rung.
- **Collections** exist in both roles (D5): standalone exploratory
  groupings, and the projection a project's publish press mints once and
  reuses (the explorer card names the minting project).

## Publish and freeze path

`publish_version` (§5.4 RPC) materializes a dataset's live rows into
`version_entries` (idempotent on `publish_key`); layers freeze into
`layer_versions`; an app publish walks its project graph (owned draft layers
publish first; published layers freeze their existing head), builds frozen
PMTiles archives for large geospatial pins (one-shot worker message, stamped
`frozen_archive`), and writes the self-contained `app_versions` snapshot.
The project bundle press is the convenience closure over per-artifact
publishes: per-member freezes with checkpoints, the promoted collection,
close. Consumption pins or floats on the version chains
(`consumer_references`; sync moves the edge, revert walks it back).

## Frontend layout (`app/src/`)

- `integrations/supabase/` — client factory, SSR client, auth provider
  (`useSession`), Better Auth mount.
- `lib/store/` — one module per PG domain (`datasets`, `entries`,
  `geometries`, `collections`, `groups`, `layers`, `maps`, `apps`,
  `projects`, `project-members`, `relations`, `versions`, `tags`,
  `publishing`, `derived`, `visibility`, `realtime`, …): TanStack Query
  options + plain table writers. Writes return affected-row counts (the
  silent-denial rule — an RLS-filtered write reads as 0 rows, not an error).
- `lib/dataset-rows-pg.ts` — the row-resolution seam (pagination budgeting,
  geometry batching) shared by the table view, maps, exports, and analysis.
- `features/<name>/` — `catalog` (browsers, cards, pickers), `datasets`
  (page, import pipeline, entries table, export), `maps` (stored-map canvas,
  layer editor, tile managers), `publishing` (project workspace, dialogs,
  transform builders, bundle press), `versions`, `analysis` (DuckDB-WASM
  panel), `app-builder` (route-only), `layer-styles` (route-only).
- Routes: `/` → `/projects`; `/projects/$projectId` (workspace: Catalog,
  Relations, Maps, Apps sections + members/settings), `/datasets`, `/maps`,
  `/apps`, `/collections` (explorers), `/apps/$appId` (the ONE public route —
  anon renders the frozen head snapshot; everything else is AuthGated).

## Development

```bash
bun install
bun run dev                  # app (vite) — picks :3001 if stale :3000 is held
bun run test                 # vitest — the app workspace only
bunx tsc --noEmit            # from app/ — the app has no typecheck script
bun run lint                 # oxlint (type-aware) at the root
bun run fmt --check          # oxfmt (the formatter)
```

The backend stack (compose, migrations, seed, env) is documented in
[`docs/memory/self-hosting-stack-2026-11-05.md`](./memory/self-hosting-stack-2026-11-05.md);
the app expects `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in
`app/.env.local` (restart vite after changing it). DB-level tests follow the
wire-client int-test pattern (they hit a live Postgres, not mocks).

**CI** (`.github/workflows/ci.yml`, one job on PRs and pushes to `main`):
oxfmt --check, lint, typecheck, app tests (incl. the Postgres int tests —
the job applies migrations before storage-api boots; see #248/#250), and the
app build. App tests whose imports reach `env.ts` must `vi.mock("#/env")`
(CI has no `.env.local`).

## Documentation map

| Doc                                                                              | Status                | What it holds                                                                                                |
| -------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`project-centric-experience-design.md`](./project-centric-experience-design.md) | implemented           | The train's authority: target model, D1–D7, the tourism scenario (§5).                                       |
| [`project-centric-train-handoff.md`](./project-centric-train-handoff.md)         | living log            | Per-phase pointers, gotchas, and the train's state.                                                          |
| [`supabase-migration-design.md`](./supabase-migration-design.md)                 | implemented           | The backend authority: schema/RLS/RPCs, stages 0–7, verification. ADR 0015.                                  |
| [`catalog-lifecycle-design.md`](./catalog-lifecycle-design.md)                   | superseded in part    | The lifecycle design; its "projects are virtual" posture was replaced by real PG projects (ADR 0017/0018).   |
| [`derived-datasets-design.md`](./derived-datasets-design.md)                     | implemented           | Transform-spec design (lookup, rollup, composition); ADR 0005.                                               |
| [`analysis-layer-design.md`](./analysis-layer-design.md)                         | implemented           | DuckDB-WASM analysis design; Parquet sidecar still deferred.                                                 |
| [`bound-datasets-design.md`](./bound-datasets-design.md)                         | implemented (PoC)     | Foreign-app read-only bound datasets + sync.                                                                 |
| [`app-builder.md`](./app-builder.md)                                             | implemented           | App builder: layout, sharing model, removal checklist; ADR 0011.                                             |
| [`layer-styles.md`](./layer-styles.md)                                           | implemented           | Layer styles history; retired as a module in [project 3] (style lives on the layer row, ADR 0019).           |
| [`gis-geometry-transport-survey.md`](./gis-geometry-transport-survey.md)         | research (2026-09-17) | Survey of how major GIS platforms transport geometry.                                                        |
| [`decisions/`](./decisions/)                                                     | living log            | Numbered decision records (ADR-style), 0001–0024; index in [`decisions/README.md`](./decisions/README.md).   |
| [`memory/`](./memory/MEMORY.md)                                                  | living log            | Project memory: durable lessons, verification gotchas, per-initiative records. Policy in the repo AGENTS.md. |

## Known gaps

- **VPS cutover** (§11a of the self-hosting design) is the remaining
  launch item — the stack runs locally; CI/CD builds and pushes the GHCR
  image but skips deploy until the VPS exists.
- **Parquet sidecar deferred** — analysis streams rows through the seam; no
  per-version Parquet artifact exists.
- **`@caden/data-export` is unwired** — the backup story exists as a package
  but nothing registers or calls it; its latent defects are parked on #137.
- **#82** records a pre-migration architecture review as reference-only —
  much of it was overtaken by the Supabase rewrite; nothing there is
  approved work.
- **Live-map app widgets** (referencing the live map instead of the frozen
  snapshot) are a noted future per-widget toggle (umbrella #254's parked
  list), not built.
