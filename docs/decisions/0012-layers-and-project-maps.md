# 12. Layers and project-owned maps: styling decoupled from data, and the end of standalone maps

- Status: accepted
- Date: 2026-10-09
- Phase 3 of the project-workspace design
  (`docs/project-workspace-design.md`, §3). Extends
  [ADR 0011](./0011-project-collaboration.md)'s role model to two new
  entities; every other clause of ADR 0009 (trusted collaborators, absolute
  read-only guarantees, signup gating) and ADR 0010 (dataset `editPolicy`)
  stands unchanged.

## Context

Datasets, maps, and their presentation were fused at the wrong tier: a
component `mapLayers` row pointed at a whole collection/group/dataset with a
visibility bit and nothing else — styling was computed client-side per
render (`assignDatasetColors`), filters/labels/popups did not exist, and a
map was a standalone, shared, creator-less catalog row that published
nothing and lived outside any project. The design's model tier (ArcGIS
→ this app) splits them: a **data layer** is one dataset reference plus
style/filter/labels/popup; a **group layer** is ordered children plus
group display state; a **map** is a canvas (viewport, basemap, ordered root
layers) owned by one project; and every one of them is publishable and
reusable exactly like a dataset (link = pinned read-only, clone = editable
copy).

## Decision

- **Five new app-side tables** (`app/convex/schema.ts`), all app-side — the
  component never learns layers or projects exist (lifecycle §4):
  - `layers` (`projectId`, `kind: "data" | "group"`, `name`, data arm:
    `datasetMemberId` — a **projectArtifacts membership id**, `style`,
    `filter?`, `labels?`, `popup?`; group arm: `opacity?`; common: `visible`,
    `lifecycle: "draft" | "published"`, `needsAttention?`; index `by_project`).
  - `layerChildren` (`groupId`, `order`, `childKind: "owned" | "linked"`,
    `childLayerId` — an owned `layers` id, or a pinned `layerVersions` id for
    a linked child; **rows, not arrays**; indexes `by_group [groupId, order]`,
    plus `by_child` for the parent lookups the cycle guard needs).
  - `layerVersions` (frozen published definitions, append-only chain mirroring
    dataset versioning; `dataset` freezes the ref resolved/pinned at publish;
    a group version's `frozenChildren` freeze each child's pinned version).
    Rows are never mutated; the newest row per layer is the head, and — until
    phase 5 wires publishing — the chain's EXISTENCE is what makes a layer
    published (the existence-over-marker rule).
  - `projectMaps` (`projectId`, `name`, `description?`, `viewport?`,
    `basemap?`, `order`; indexes `by_project` and `by_project_order`).
  - `mapLayers` (`mapId`, `order`, `layerMemberId` — a **projectArtifacts
    id**, `visible` as the map-local override; index `by_map [mapId, order]`).
- **The membership indirection is the point.** A data layer styles its
  dataset THROUGH the project's membership row, so the pin/float version
  edge (phase 2) is the layer's data edge too — restyle or sync the dataset
  without touching the layer. A map placement names a layer through its
  membership, so an owned placement resolves to the live `layers` row and a
  linked one to its pinned `layerVersions` row by one rule.
- **Link and clone are separate flows, never a bare reference.**
  `projects.addArtifact` REFUSES kind `"layer"` — layers join a project by
  being created (`layers.create`, owned, row + membership born in one
  transaction) or linked (`layers.link`: the membership's `artifactId` IS
  the pinned `layerVersions` row; the pin is the membership, so a linked
  layer needs no `consumerReferences` edge). `layers.clone` builds an owned
  draft from the head version — deep for groups (owned children clone from
  their own frozen versions; linked children re-pin theirs). Both refuse an
  unpublished source: no chain, nothing to pin or copy ("publish it first").
- **Groups are layers, not map-only nodes.** Nesting lives only inside group
  layers; every group op (`addToGroup`/`removeFromGroup`/`reparent`/
  `reorder`) is editor-gated, keeps a layer in at most one group, and walks
  the parent chain with a depth bound as the cycle guard (a move into the
  moved subtree refuses). Removing a group unparents its children — never
  deletes them (references, not containment).
- **Schema drift flags, never breaks.** When `consumption.syncReference`
  moves a fork edge's pin onto a version whose top-level field set differs
  from the previously pinned row's, every data layer styling that membership
  gets `needsAttention` (a message naming the version, stamped in the SAME
  transaction via `layerDrift.ts` — a dependency-free module so consumption
  never imports the layers/projects chain). The layer's next styling write
  (`layers.update`) clears the flag: whoever edited the definition just
  looked at it.
- **Auto-layer on "add dataset to map"** (`projectMaps.addDatasetToMap`):
  one click, one transaction — the dataset joins the map's project (the
  addArtifact semantics, idempotent; pin-at-head default), an owned data
  layer styles its membership with the default palette color (reusing a
  layer that already styles it), and the layer is placed on the map. Only a
  geospatial dataset layers (a standard one is refused with the reason).
  Collection/group targets become **"add all datasets from collection"**
  (`addAllDatasets`): expand, auto-layer each geospatial dataset, report the
  skipped (no-geometry) count — never silently dropped.
- **Standalone maps are retired, physically.** The component's `maps`,
  `mapLayers`, and `mapLayerOverrides` tables and their lib functions are
  deleted; `app/convex/maps.ts` goes with them; the `map` artifactKind and
  the `consumerKind "map"` edges are removed from the unions (greenfield —
  no migration); `routes/maps/*`, the header "Maps" link, and the map
  components are deleted; `add-to-map-sheet.tsx` becomes "Add to project
  map". The bundle press loses its fourth leg (`linkMapLayers`) and its map
  members — the closure is exactly the project's memberships, ordered
  datasets-then-derived; `bundles.layerResolutions` (the stale-id trap's
  read) goes with it. Layer/map publish joins the press in phase 5.

## Consequences

- Every write on a layer or map answers to the OWNING project's
  editor-and-up (`projectForWrite`); reads answer to any member, null/empty
  to outsiders — the ADR 0011 matrix, unchanged. A published layer is
  linkable/cloneable by any signed-in user (the ADR 0009 trusted-collaborator
  default); the pinned unit is read-only by construction (its definition
  lives in a frozen row), not by policy — ADR 0010's `editPolicy` stays a
  dataset-level concern.
- "Link XOR modify" now holds for layers too, stated structurally: a linked
  layer has no local row to edit, an owned layer has no version chain to
  sync — `projects.setMemberSync` refuses kind `"layer"` until phase 5's
  re-pin action exists.
- `projectMembers`-held drafts and project visibility now extend to layers
  automatically (their membership rows are `projectArtifacts`), so the
  workspace read needed no new leak rules — only a new arm resolving owned
  vs pinned layer members.
- The old component-map API surface (`listMaps`, `addMapLayer`,
  `setMapLayerOverride`, …) is gone from `exposeApi` and the
  `ExposeApiOperation.mapId` seam with it; a future per-map policy would be
  a host-side predicate on the app's own role checks, which already answer
  the question.
- Deliberately deferred to phase 4/5 (recorded, not forgotten): the map
  editor UI under `/projects/$projectId/maps/$mapId` (this phase ships the
  workspace's read-only Maps section and the add-to-map flows), and layer
  publishing through the real 5b state machine (phase 5 — until then tests
  seed `layerVersions` rows directly, the same way tag tests seed frozen
  rows).
