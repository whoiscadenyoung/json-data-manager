# Project-centric workspace: datasets → layers → maps inside collaborative projects

## Context

Projects, datasets, and maps are separate silos today. A project is a flat, creator-private
list of references (`projectArtifacts`, kinds `dataset | derived | map`). Maps are standalone,
shared rows in the `@caden/json-cms` component: name + description + layer pointers, no
styling, no creator, no versioning, untouched by publish. Goal: a project is a thin,
collaborative workspace (an "app" grouping maps and their sources). Styling is decoupled from
data (QGIS-style) into a first-class, publishable **Layer**. Maps exist only inside projects.
Greenfield: no migration/back-compat.

## Model (ArcGIS → this app)

| Tier            | Is                                                                                                                                                  | Publishable                                                                                                        | Reuse                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Dataset         | data + schema (exists)                                                                                                                              | yes (versioned chain)                                                                                              | link (pinned) / fork                                                                                |
| Derived dataset | analysis output, "workflows → tables" (exists; joins/counts are materialized here)                                                                  | yes                                                                                                                | same                                                                                                |
| **Data layer**  | one dataset ref + style, filter, labels, popup. Never modifies data                                                                                 | yes (versioned chain, same lifecycle as datasets)                                                                  | **link** (read-only, pinned) **or clone** (editable copy). Never link AND modify                    |
| **Group layer** | ordered children (data layers or other groups) + group name/visibility/opacity. A layer too, so it publishes/links/clones exactly like a data layer | yes; publish freezes a version with every child pinned (draft children are published with it, like bundle closure) | link = one read-only pinned unit (local visibility toggles only); clone = deep copy to owned drafts |
| **Map**         | canvas: viewport, basemap, ordered root layers (data or group). Project-owned                                                                       | publish = frozen snapshot                                                                                          | clone                                                                                               |
| **Project**     | thin collaborative workspace; references datasets/derived/layers/maps                                                                               | publish = bundle manifest of pinned versions                                                                       | clone                                                                                               |

Rules:

- References only point downward; every cross-entity reference is pin or float.
- Linked (foreign, published) things are read-only and pinned; sync is an explicit action; per-member
  "keep in sync" checkbox = float. Owned things are editable by project editors.
- A map contains only layers (and groups). Adding a dataset to a map auto-creates an owned layer with default
  style (one click). Dataset detail pages also get an ephemeral "Preview on map" (default style, not persisted).
- Groups are **layers** (kind `group`), not map-only nodes and not nested maps: nesting lives only inside group layers;
  a map is just the canvas + root placements. No cycles (editing guard; published versions only point at older pinned versions).
  Syncing a linked group moves the whole unit; children follow the group's version, not their own.
- **Future (note only):** joins inside the layer/dataset. For now materialize via derived datasets (DuckDB).

## Reused as-is

- Membership + fork edges: `projects.addArtifact` (`app/convex/projects.ts:339`).
- Pin/float/sync/revert: `consumption.ts` (`setReferenceMode` 1463, `syncReference` 1505, `revertReference` 1545,
  `sourceBadges`, `consumedBy`), UI in `src/components/dataset-consumption.tsx`.
- Bundle press: `bundles.ts`, `src/lib/bundle-publish.ts`, `bundleClosure`; publish state machine `publish.ts`.
- Visibility helpers `datasetVisibleTo`, `sourceVisibleToViewer`; test helpers in `projects.test.ts`/`sharing.test.ts`.

## Phases

### 1. Collaborative projects

- New `projectMembers` (`projectId`, `userId`, `role: owner|editor|viewer`; indexes `by_project`, `by_user`).
- Replace creator-only `projectForWrite`/`get`/`list` with role-based access helper; `list` returns projects
  you belong to. Add `projects.update`, `projects.remove` (cascade), `addMember`/`setRole`/`removeMember`
  (owner only; invite by user id/email lookup via `users.ts`).
- Project-owned drafts (datasets/layers/maps created in a project) become visible/editable to members: update
  `datasetVisibleTo`/draft scoping accordingly. Check against ADR 0009/0010 (edit policy) and write a new ADR.
- UI: project members dialog; `routes/projects/*` shows role.

### 2. Member roles and pin/sync

- `projectArtifacts`: add `role: owned|linked`, `syncMode: manual|auto`; kinds become `dataset|derived|layer|map`.
- Linked add mints a **pin** edge at head (today float); `auto` → float. Add `projects.setMemberSync`, per-member
  Sync/Revert, "update available" badge. UI in `routes/projects/$projectId.tsx`; "Add to project" on dataset
  browser/detail pages.

### 3. Layers (new entity) and project-owned maps

- App-side tables (`app/convex/schema.ts`):
  - `layers`: `projectId` (owner project), `kind: data|group`, `name`, data: `datasetMemberId`, `style`, `filter?`,
    `labels?`, `popup?`; group: `opacity?`; common: `visible`, `lifecycle: draft|published`, `needsAttention?`.
  - `layerChildren`: `groupId`, `order`, `childLayerId` (owned layer, or a pinned `layerVersions` ref for a linked one).
    Rows, not arrays; index `by_group` `[groupId, order]`.
  - `layerVersions` (frozen published definitions, append-only chain, mirrors dataset versioning; dataset ref
    resolved/pinned at publish; group versions freeze their children's pinned versions).
  - `projectMaps`: `projectId`, `name`, `description?`, `viewport?`, `basemap?`, `order`.
  - `mapLayers`: `mapId`, `order`, `layerMemberId` (a `projectArtifacts` id), `visible` (map-local override). Index `by_map`.
- New `app/convex/layers.ts` and `projectMaps.ts` (role-checked): CRUD, clone layer/group (published → owned draft,
  deep for groups), link layer/group (published → pinned read-only member), group/ungroup/reparent/reorder with
  cycle guard, set visibility, auto-layer on "add dataset to map".
- Style/schema drift: when a dataset sync changes fields, mark affected layers `needsAttention` rather than breaking.
- Retire standalone maps: component map tables/API (`packages/json-cms/src/component/lib.ts` map functions),
  `app/convex/maps.ts`, `map` artifactKind, `consumerKind "map"`, `routes/maps/*`, header "Maps" link,
  `add-to-map-sheet.tsx` → "Add to project map". Collection/group targets become "add all datasets from collection".

### 4. Map editor in the project

- Move `routes/maps/$mapId.tsx`, `layers-map.tsx`, `map-layer-panel.tsx`, `map-layer-picker.tsx`, `lib/map-layers.ts`
  under `projects/$projectId/maps/$mapId`. Picker offers project members + inline import/link. Layer style panel
  (stored style replaces client-only `assignDatasetColors`). Project page tabs: Datasets · Layers · Maps · Analysis · Publish.

### 5. Publishing and reuse

- **Layer publish** (data or group): freeze a `layerVersions` row (reuses the publish/attempt pattern); a group's closure
  publishes its draft children first (generalize `bundleClosure`); linkable (pinned) or cloneable. "Publish group" in the map
  layer panel is the same action as publishing a layer.
- **Map publish**: frozen snapshot of the node tree with layer definitions inline and dataset versions pinned; cloneable.
- **Project bundle**: manifest of pinned member versions (extends `bundles.ts` closure to layers/maps; replaces
  `linkMapLayers` at `bundles.ts:1058`). Clone project → linked pinned datasets/layers + editable map copies.

### 6. Docs

- Update `docs/architecture.md`, `docs/catalog-lifecycle-design.md` (§3, §9), add ADRs (project collaboration,
  layers & project-owned maps), `docs/memory/` entry per AGENTS.md.

## Verification

- convex-test (conventions as in `projects.test.ts`): role access matrix (owner/editor/viewer/outsider); linked add pins and
  Sync advances; auto = float; link XOR modify enforced; clone yields editable owned copy; layer publish versions; map nodes
  only reference same-project layer members; drift → `needsAttention`; bundle manifest pins versions; project clone.
- `cd app && bun run test`, oxlint/oxfmt, typecheck/build via `bun --filter=app`.
- Browser pass (preview): create project → invite collaborator → import dataset → add to map (auto-layer) → restyle, group →
  publish layer → link/clone it in a second project → publish map/bundle → clone; confirm no standalone map entry points.

## Open items

- Whether to physically delete the component's map tables (plan assumes yes).
- Exact draft-visibility change for project-owned datasets (ADR needed in phase 1).
