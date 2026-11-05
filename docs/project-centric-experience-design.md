# Project-centric experience: projects as the workspace, tabs as explorers

**Status:** APPROVED 2026-11-05 — decisions D1–D7 resolved (§7), issue train
filed under the umbrella issue.
Written 2026-11-05, post-Supabase closeout (main @ 2a0669f).

**Predecessor:** `docs/project-workspace-design.md` + the unmerged
`feat/project-workspace` branch (Convex-era, Oct 2026, preserved+pushed as a
spec — never a merge source after the backend rewrite). That branch designed
and shipped-locally: project members/roles (ADR 0011, needs a PG re-issue),
owned-vs-linked artifacts with pin/float/sync, first-class **layers**
(style decoupled from data), **project-owned maps** (standalone maps retired),
an in-project map editor, and a five-tab workspace. This doc ports that model
to the Postgres backend and extends it with the three things the branch never
covered: **apps in projects**, **interactive dataset relations**, and a
**unified publishing/visibility model**.

---

## 1. Goal

A project is the primary working context (SaaS-product posture, à la
Notion/Power BI), not a flat list of links. Users create a project and from
inside it: manage the project's data catalog (create/import/add existing),
relate and join datasets, build map layers, design maps, and publish apps
built from that data. The Datasets/Maps/Apps/Collections tabs become
**exploratory views** over everything published (or owned) across projects.
Cross-project reuse must be cheap: a "State Tourism" project pulls the
National Parks project's datasets in, joins them against new data, and
publishes its own map/app — without copying or disturbing the source project.

Our differentiator vs the BI tools: standalone datasets stay first-class
(Tableau "published data sources" / Power BI "semantic models" posture) while
the GIS integration (geometries, tile archives, layers, spatial relations)
stays accurate and performant — PostGIS + the existing tile-archive pipeline
are the substrate.

## 2. Where the app stands today

### 2.1 Entity interaction map (PG, migrations 0003–0017)

| Entity (table)                                                                                | References                                                                                                                | Referenced by                                                                                      | Visibility posture                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **datasets** (0003)                                                                           | group                                                                                                                     | collections (M:N), groups, map_layers, derived_datasets, versions/chains, project_artifacts, apps  | lifecycle draft\|published; edit_policy open\|locked; published_visibility everyone\|author; tile archive per dataset |
| **entries + geometries** (0003)                                                               | dataset                                                                                                                   | version_entries (frozen copies), map runtime (rows path or tiles)                                  | ride the dataset                                                                                                      |
| **collections / groups** (0007)                                                               | datasets (M:N), groups (single-group datasets)                                                                            | map_layers (as composite targets), bundle press output                                             | authenticated-open (shared catalog)                                                                                   |
| **derived_datasets** (0009)                                                                   | source dataset or derived (DAG), `spec` jsonb (lookup-join, rollup, sql analyses)                                         | map_layers (target derived), project_artifacts, versions                                           | reads authenticated; writes creator-checked                                                                           |
| **maps / map_layers / map_layer_overrides** (0005)                                            | targets: collection\|group\|dataset\|derived (ids as text, dangling tolerated)                                            | layer_styles per (map, renderId), project_artifacts                                                | authenticated-open ("maps stay open", ADR 0009)                                                                       |
| **layer_styles / marker_sprites** (0005)                                                      | (map, renderId) / storage                                                                                                 | the map runtime                                                                                    | authenticated-open                                                                                                    |
| **dataset_versions / version_entries / tags / consumer_references / version_policies** (0009) | datasets; pins as FKs                                                                                                     | bundle press, consumers (derived rows, map legs, project memberships — kinds `derived\|map\|fork`) | frozen rows immutable-by-construction; SELECT via can_view_dataset                                                    |
| **projects / project_artifacts** (0009)                                                       | artifacts: dataset\|derived\|map (flat membership)                                                                        | publish_bundles, consumer_references                                                               | **creator-private** RLS — no members/roles on PG yet                                                                  |
| **publish_bundles / members** (0009)                                                          | project; members kind dataset\|derived\|map, `layer_targets`                                                              | mint a catalog collection + frozen versions on press                                               | creator-private                                                                                                       |
| **apps** (0014)                                                                               | `dataset_ids uuid[]` refs only (no FK, dangling tolerated); `pages` jsonb (12-col widget grid: text/stat/chart/table/map) | nothing                                                                                            | reads authenticated; writes creator-only (+system guard); `sharing private\|link`                                     |
| **bound datasets** (0012)                                                                     | remote_sources / bindings / sync_runs                                                                                     | datasets.source marker                                                                             | orthogonal source type                                                                                                |

### 2.2 The seams (what the user felt)

1. **Projects are add-only.** `/projects/$id` = flat artifact list + "Add
   existing" sheet + one-press bundle publish. Nothing is created _inside_ a
   project; no maps, no apps, no members.
2. **Maps are standalone.** Project-owned maps don't exist; the map editor is
   a global surface; a project merely lists a map row.
3. **Apps are fully disconnected.** No project linkage at all — and the app
   `map` widget embeds _ad-hoc_ layers straight from `datasetIds`; it never
   references the maps domain (no saved map, no layer_styles, no saved layer
   definitions). Two parallel map stacks.
4. **Joins are materialize-only.** The transform engine (lookup-join/rollup/
   SQL) produces derived datasets; there is no interactive _relation_ — no
   "click the polygon, highlight its points, show joined counts in the popup."
5. **Grouping is collections-only**, and collections are dataset-only.
6. **Visibility is fragmented** across four vocabularies: datasets
   (`published_visibility everyone|author`), apps (`sharing private|link`),
   maps (open-to-authenticated), projects (creator-private).

### 2.3 What the preserved branch already solved (design only now)

`feat/project-workspace` (13 commits, Convex) = the workspace model: roles +
members; linked adds **pin** at head (float = auto-sync); first-class layers
(data|group, style/filter/labels/popup, never modify data, link XOR clone);
project-owned maps (map = canvas, layers placed on it; standalone maps
retired); in-project map editor; per-artifact versioned publish + project
bundle closure; dataset/style drift → `needsAttention`. Its data model maps
1:1 onto the PG machinery that now exists (consumer_references float/pin,
publish_version, bundle press) — the port is mostly new tables + RLS, not new
concepts.

## 3. How the comparables model it

| Product           | Container                              | Data                                                                | Presentation                              | Consumption artifact                             | Sharing model                                                                                                                                          |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Power BI**      | Workspace                              | Semantic models (shareable _across_ workspaces, "build" permission) | Reports in workspaces                     | **App** = curated read-only package w/ audiences | Workspace roles for builders; apps for consumers (RLS applies to consumers, not workspace members)                                                     |
| **Tableau**       | Projects (hierarchical)                | **Published data sources** (independent, reusable across workbooks) | Workbooks → views/dashboards              | Views; project-level permissions                 | Permission inheritance from project, lockable, per-item override                                                                                       |
| **ArcGIS Online** | Groups (org-level), folders (per-user) | Items: feature layers/services                                      | **Web maps** (reference layers as items)  | **Web apps** reference web maps                  | private → org → group → everyone, **per item**; an app shared publicly requires every referenced map/layer shared at a compatible level (closure rule) |
| **Notion**        | Pages tree (+ teamspaces)              | Databases                                                           | Linked views w/ independent filters/sorts | Pages                                            | Permissions inherit down the tree; linked views can never exceed the source database's permissions                                                     |
| **QGIS**          | Project file                           | External data sources                                               | Layers w/ styles (decoupled from data)    | Layouts/maps                                     | n/a (desktop) — but the style↛data decoupling is the pattern our layers port already follows                                                           |

Distilled patterns:

- **P1 — Build/consume split.** A rough, permissioned workspace where builders
  work; a frozen, curated, separately-shared artifact for consumers
  (Power BI workspace vs app; our draft/published lifecycle already embodies it).
- **P2 — Data is a global shared citizen.** Datasets live outside any
  container and are _referenced_ everywhere (Tableau published data sources,
  PBI cross-workspace models). This is what makes the Tourism-project reuse
  cheap — never copy.
- **P3 — Reference, don't copy** (Notion linked views, ArcGIS items).
  View/presentation state lives at the reference site; the source stays single.
- **P4 — Publish = freeze + closure sharing.** Sharing widens along the whole
  reference chain or not at all (ArcGIS's rule); our bundle press already
  walks the closure for _versions_ — it must learn to walk it for _visibility_.
- **P5 — Permissions inherit down a hierarchy** with per-item override and
  effective access = the minimum along the chain (Tableau/Notion).
- **P6 — Cross-highlighting is the headline interaction** of a relational
  model (Power BI cross-filter/highlight across visuals; ArcGIS related-record
  popups). Our "click polygon → highlight points → joined counts" is exactly
  this, driven by declared relations.

## 4. Target model

### 4.1 The ladder

```
Project (workspace; members with roles)
├─ Data:     datasets + derived datasets   → owned (created here) or LINKED (pinned/float)
├─ Relations: named dataset↔dataset links  (key or spatial; new)
├─ Layers:   dataset ref + style/filter/labels/popup  (first-class, publishable; branch design)
├─ Maps:     project-owned canvas of layers (ordered, grouped; style in layer_styles)
└─ Apps:     project-owned; pages/widgets; map widgets reference PROJECT MAPS
```

- **Datasets stay in the global catalog** (P2). A project holds _memberships_:
  owned drafts created in-project, or linked references (pinned read-only by
  default, float for auto-sync, sync/revert actions — the existing
  consumer_references semantics). The Tourism project adds the parks datasets
  as linked pins; the source project is untouched.
- **Layers** are the style/filter/popup unit (never touch data), so one
  dataset can appear styled differently in many maps — the QGIS/ArcGIS
  decoupling, already designed in the branch.
- **Maps** are project-owned compositions of layers. **Standalone maps become
  project maps with no project** — the `/maps` tab survives as an _explorer_
  over all maps you can see (project-owned ones included), not as a separate
  creation surface.
- **Apps** join the ladder: created inside a project, `project_id` on the app
  row. The `map` widget references **stored project maps** — pull in an
  existing map, or create one from the builder, which persists a real
  project-owned map (an inline-only ad-hoc map mode dies with the change: a
  map built anywhere in the app is a map row).
- **Collections** stop being the primary grouping. A published project can
  still mint one (the bundle press already does) as a _catalog projection_;
  the standalone collection UI remains as an exploratory saved-grouping. Not
  a building block.

### 4.2 Relations (new)

```
dataset_relations: id, from_dataset, to_dataset, kind ('key'|'spatial'),
  cardinality ('1-1'|'1-N'|'N-M'), config jsonb
  -- key:     {fromKey, toKey}
  -- spatial: {predicate: 'within'|'intersects'|'contains', direction}
  created_by, unique (from_dataset, to_dataset, kind)
```

- Declared at the **catalog/data level** (like ArcGIS relationship classes and
  Power BI model relationships) — presentations _consume_ them. Creation UX
  lives inside projects (the working context), but the relation itself is
  reusable by any project that holds both datasets as members.
- **Key relations** can also auto-suggest a lookup-join derived dataset (the
  transform engine already has the op) — "relate" and "join into a table" are
  the same declaration, two consumers.
- **Map runtime** (the new juice): on feature click, for each relation
  touching a rendered layer, run a bounded PostGIS/key query (GiST-indexed,
  viewport+limit capped, e.g. 200) → highlight the related set on the other
  layer + render a "related records" section in the popup. P6, GIS edition.
- **Apps** get the same runtime benefit free: the app map widget drives the
  same relation-aware popup; optionally a related-records table widget.

### 4.3 The tabs become explorers

`/datasets`, `/maps`, `/apps`, `/collections` stay — re-scoped as browsable
views over everything visible to the viewer, with "in project X" chips and
publish state. `/projects` (or the home route) becomes the default landing:
the working context. Creation of maps/apps moves _into_ project flows;
the explorer keeps a lightweight "start from here" affordance that pre-creates
inside a chosen (or new) project.

Inside a project, keep the catalog/map separation **light** (the GeoLibre /
ArcGIS posture without over-isolating): a **Catalog** view (datasets, derived,
relations, imports) and a **Maps** view (maps, layers, apps) as the
workspace's two primary sections, plus members/settings/publish — two views
into one workspace, not separate apps.

### 4.4 Schema delta sketch (additive only)

- `project_members(project_id, user_id, role owner|editor|viewer)` + RLS
  rewrite of projects/project_artifacts (creator-private → role-based) —
  ADR 0011 re-issued for PG.
- `project_artifacts`: + `role owned|linked`, + `sync_mode manual|auto`;
  kinds + `layer`, `app`, `map` stays.
- New: `layers` (+ `layer_children`, `layer_versions` — branch design §3),
  `dataset_relations` (§4.2).
- `apps`: + `project_id` (nullable during migration), map widget spec + `mapId`.
- `maps`: + `project_id` (nullable = legacy/standalone), or project-owned only
  with a data backfill — decision D2.
- Visibility: one vocabulary (§6) replacing `published_visibility` /
  `sharing` / implicit-open.
- Realtime publication (0013) extended to the new member-relevant tables.

## 5. Scenario walkthrough (the acceptance test)

**National Parks project**

1. Create project. Catalog tab: import park polygons (new dataset, owned
   draft); add existing park points + visitor counts (linked, pinned).
2. Relate: points ↔ polygons, kind `spatial/within` (one dialog; PostGIS does
   the truth). Visitor counts → lookup-join on park id → derived
   "parks + visits" (or enriched polygons).
3. Maps tab: create map; add polygons layer (owned, styled) + points layer;
   click a polygon → its points highlight, popup shows joined visit counts.
4. Publish layer/map (freeze versions). Apps tab: "National Parks Explorer" —
   page 1: map widget → _this project map_; stats/charts on the pinned
   versions; publish app at `link` with closure promotion (§6).

**State Tourism project**

1. Create project; add national-parks datasets as **linked pins** (read-only,
   update-available badges if the source republishes); add states polygons
   dataset; relate parks→states (`spatial/within`); import state-parks CSV;
   add a restaurants dataset.
2. New map reusing the parks _layers via link-or-clone_ + new layers.
3. Publish its own app. Both projects coexist; nothing copied; source
   project's data stays singly-owned.

## 6. Publishing & visibility (the core brainstorm)

### 6.1 Two axes

1. **Draft ↔ published (freeze)** — exists (`publish_version`, tags, keep-N,
   bundle press). Extends to layers/maps/apps (layer_versions, map snapshots,
   app config freeze). Publishing never moves visibility by itself.
2. **Visibility ladder** — one enum on every _published_ artifact:

   `members` → `signed-in` → `link` → `public`

   - `members`: project members only (new; today's projects are creator-only).
   - `signed-in`: the current trusted-collaborator posture (ADR 0009) — the
     single-org default for everything published.
   - `link`: unauthenticated access by URL (needs anon SELECT policies on
     _frozen_ rows + the app/map public route; the self-hosted stack's anon
     role + single kong origin already support the shape).
   - `public`: link + discoverable/listed in the explorers.

### 6.2 The closure rule (ArcGIS's lesson, made automatic)

Publishing/sharing an app (or map) at level L **validates the whole reference
closure**: every referenced map snapshot, layer version, dataset version must
already be published at ≥ L, or the preflight offers to **promote them
together** (a diff-style report: "sharing this app publicly also widens 2
datasets and 1 map — review"). The bundle press becomes this preflight +
promotion engine (it already walks versions; add visibility). Effective
consumer access = `min(closure)` (P5) — a pinned foreign dataset that is
author-only in its home project _blocks_ a public share, surfacing as an
explicit "request access / choose different data" decision, never a silent
leak.

### 6.3 Decision (2026-11-05)

Build the **full ladder** (`members|signed-in|link|public`) with **no adoption
intermediate steps**: the app is not in production and PG data is disposable,
so every phase ships its final shape directly — breaking schema changes are
fine, no dual-vocabulary period, no back-compat shims, no legacy backfills.
The ladder + closure preflight and the anon-serving plumbing are separate
_engineering_ issues in one train (§8), not adoption phases.

## 7. Decisions (resolved 2026-11-05)

- **D1 — Dataset ownership: global + membership.** Datasets stay in the
  global catalog; projects hold owned-or-linked memberships. Tourism-style
  reuse is a pin, never a copy (P2).
- **D2 — Standalone maps: explorer + project-owned creation.** `/maps` stays
  as an explorer over every map the viewer can see; map _creation_ lives in
  projects. No migration dance — break directly.
- **D3 — Relations: catalog-level.** `dataset_relations` rows are data-truth
  (relationship-classes / PBI-model posture), reusable by any project holding
  both datasets as members; the creation UX lives in projects.
- **D4 — Visibility: full ladder, no adoption steps.**
  `members|signed-in|link|public` built complete; closure preflight +
  promotion from day one (§6.2, §6.3).
- **D5 — Collections: standalone AND bundle-minted.** Creating collections
  outside projects stays supported (exploratory groupings); the bundle press
  keeps minting them as published projections.
- **D6 — Publishing granularity: per-artifact + bundle.** Layers/maps/apps
  publish independently (frozen versions); the project bundle press is the
  convenience closure over all of it.
- **D7 — App↔map coupling: stored maps.** App map widgets reference stored
  project maps (frozen snapshot at publish); maps created inside the app
  builder persist as real maps — the inline `datasetIds` map mode retires.
- **Migration posture (global):** no in-between/migration steps anywhere —
  the app is not in production; each phase ships its final schema/UX shape.

## 8. Phasing sketch (for the future issue train)

Ordered so each phase lands value independently; per user preference this
becomes numbered, self-contained agent issues with acceptance criteria once
the design converges.

1. **Project membership + roles** (PG RLS rewrite, ADR re-issue, invites) —
   the prerequisite for everything collaborative + `members` visibility.
2. **Owned-vs-linked artifacts + project catalog tab** (create/import inside
   the project; pin/float/sync/revert wired to consumer_references).
3. **Layers + project-owned maps** (port branch design; style panel already
   exists as layer_styles; `/maps` re-scoped as explorer).
4. **Relations** (dataset_relations + PostGIS runtime + popup/highlight).
5. **Apps in projects** (`apps.project_id`; map widget → stored maps,
   create-from-builder persists a map; app freeze/publish).
6. **Visibility unification + closure preflight** (one vocabulary — replaces
   `published_visibility`/`apps.sharing`; the full ladder incl. `link`/
   `public` gates; bundle press learns visibility promotion).
7. **Link/public serving** (anon RLS on frozen rows, public app/map routes,
   tile-archive anon read path).
8. **Explorers + cross-project UX + collections integration**
   (update-available flows, "in project" chips; standalone collections stay,
   bundle-minted collections stay — D5).

One PR per issue, ordered; no back-compat steps anywhere (§7 posture).

## 9. Sources

- Power BI: [Semantic models across workspaces](https://learn.microsoft.com/en-us/power-bi/connect-data/service-datasets-across-workspaces),
  [Workspace vs app (build in one, share from another)](https://community.fabric.microsoft.com/blog/community_blog/power-bi-workspace-vs-app-build-in-one-and-share-from-another/4853844)
- ArcGIS: [Get started with sharing](https://doc.arcgis.com/en/arcgis-online/get-started/get-started-with-sharing.htm),
  [Share items](https://enterprise.arcgis.com/en/portal/12.0/use/share-items.htm),
  [All about groups](https://www.esri.com/arcgis-blog/products/arcgis-online/sharing-collaboration/all-about-groups-in-arcgis)
- Tableau: [Permissions](https://help.tableau.com/current/server/en-us/permissions.htm),
  [Permission capabilities and templates](https://help.tableau.com/current/online/en-us/permissions_capabilities.htm)
- Notion: [Sharing & permissions](https://www.notion.com/help/sharing-and-permissions),
  [Data sources & linked databases](https://www.notion.com/help/data-sources-and-linked-databases)
