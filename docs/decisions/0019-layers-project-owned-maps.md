# 19. Layers & project-owned maps: style decoupled from data, `/maps` as explorer

- Status: accepted
- Date: 2026-11-06
- Phase 3 of the [project-centric experience train](../../project-centric-experience-design.md)
  (§4.1 layers line, §4.3 Maps view, §7 D2/D6; issue #257, umbrella #254).
  Ports the preserved branch's phase 3
  ([`project-workspace-design.md`](../../project-workspace-design.md) §3) to
  the Postgres backend. Builds on [ADR 0017](0017-project-membership-roles.md)
  (roles gate every write) and [ADR 0018](0018-project-catalog-owned-vs-linked.md)
  (owned vs linked). Migration `0020_layers_project_maps.sql` carries the
  schema.

## Context

Styling lived on the map: `map_layers` named raw dataset/collection/group
targets and `layer_styles` stored per-`(map, renderId)` fragments — a
dataset drew one way per map, collections expanded at read time, and maps
were standalone rows editable by every signed-in user. The design's ladder
puts **layers** between data and maps (QGIS/ArcGIS decoupling): a layer is
one dataset + the style/filter/labels/popup that paint it; maps compose
layers; groups are layers too.

## Decision

- **`layers` (kind `data|group`), project-owned from birth.** A data layer
  styles exactly one dataset _membership_ of its own project
  (`dataset_member_id → project_artifacts`, CASCADE — removing the
  membership removes its layers); groups carry order/opacity and their
  children. Style/filter/labels/popup live ON the layer row (`style` is the
  MapLibre fragment the @caden/layer-styles validators define) —
  `layer_styles` and `map_layer_overrides` retire (the layers tree replaces
  child-visibility overrides; per-layer storage fixes what per-renderId
  storage never could: the same dataset twice, styled differently).
  `marker_sprites` stays.
- **`layer_children` rows, not arrays** (`[group_id, order]`, unique per
  child), child `owned` (a layers row) or `linked` (a pinned
  `layer_versions` row — no FK: one column, two id spaces, documented).
  Nesting lives only inside groups; cycles are rejected at edit time by a
  depth-bounded parent walk in the store (the DB keeps the tree honest, the
  guard keeps it acyclic).
- **`layer_versions` append-only** (no UPDATE/DELETE grants — the
  dataset_versions posture). A data version freezes the definition and pins
  its dataset ref at publish; a group version freezes its children's pinned
  versions (the bundle-closure pattern). Existence of a version — not the
  `lifecycle` marker — gates link/clone (the existence-over-marker rule).
- **Maps are project-owned ROWS, never memberships** (correcting the #256
  handoff note, which expected kind `map` to return): `maps.project_id`
  NOT NULL + order/viewport/basemap; `project_artifacts` widens to
  `dataset|derived|layer`, and kind-`layer` memberships are minted only by
  the layers store (create mints the owned layer's, link mints the pinned
  version's — "layers join by create/link only", branch parity).
  `map_layers` becomes the placement table (map, order, layer_member_id →
  the membership, visible — the map-local toggle; "link = read-only pinned
  unit, local visibility toggles only").
- **The standalone backfill**: every pre-0020 map folds into one
  per-creator project (creator = owner member, the 0018 birth trigger) —
  the one in-migration backfill the train's posture allows, so the
  project-owned RLS locks nobody out. Maps RLS rewrites from
  authenticated-wide to member-read/editor-write (the 0018 helpers).
- **Auto-layer**: "add dataset to map" mints membership + owned layer +
  placement in one store flow, idempotent per map (a dataset already
  placed re-places nothing). The dataset page's existing map surface IS the
  ephemeral "Preview on map" (default style, never persisted).
- **Drift → `needsAttention`** (a message, not a boolean): the dataset
  schema-edit flow stamps the styled layers; any layer styling write clears
  it.
- **`/maps` is an explorer** (D2): every map the viewer can see, project
  chips, no creation entry — map creation lives in the project's Maps
  view; `/maps/$mapId` resolves the map's project and redirects into the
  in-project editor (which is how backfilled standalone maps open).
- **Rendering stays live this phase**: a linked layer renders its frozen
  _definition_ (style) over its dataset's live data; the version row
  carries the pin, and rendering from frozen rows is [project 5]'s
  snapshot work.

## Consequences

- The store guard shapes (auto-layer idempotency, cycle walk, publish
  closure, clone deep-copy) are pinned by store tests; the RLS matrix and
  the placement cascade by `pg-layers.int.test.ts`.
- The styling feature's panel/editing machinery is re-keyed from
  `(map, renderId)` rows to the layer row (storage adapter); sprites and
  validators are untouched.
- Realtime: `layers` + `layer_children` join the publication;
  `layer_styles` (dropped) leaves it; `map_layers` re-joins explicitly
  (the retarget's DROP detaches publication members silently).
- The bundle press keeps dataset+derived members; closing over layers and
  maps is D6's later extension ([project 5]/bundle work).
