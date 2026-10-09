---
name: project-workspace-phase-3
description: Layers and project-owned maps (design phase 3, ADR 0012) — the membership indirection, pin-as-membership, the drift-stamp module placement, and what got retired with standalone maps
type: project
---

Project-workspace design phase 3 (layers + project-owned maps, ADR 0012,
2026-10-09) landed app-side on `feat/project-workspace`. The four
non-obvious shape decisions a future session needs:

- **Everything points THROUGH `projectArtifacts` memberships.** A data
  layer's `datasetMemberId` and a `mapLayers` placement's `layerMemberId`
  are membership row ids, not artifact ids — that's what makes the phase-2
  pin/float edge the layer's data edge and lets owned/link resolve by one
  rule (`layers.resolveLayerMember`). A linked layer has NO `layers` row at
  all: its membership's `artifactId` IS the pinned `layerVersions` row
  (the pin is the membership — no consumerReferences edge), so
  `projects.setMemberSync` refuses kind "layer" until phase 5's re-pin.
  Every layer-creating path (create/link/clone/auto-layer) must mint the
  membership in the same transaction — the clone data-arm and auto-layer
  initially didn't and the workspace/maps reads went blind (caught by
  convex-test).
- **The drift stamp lives in `app/convex/layerDrift.ts`** — a
  dependency-free module (the projectAccess.ts pattern) because
  consumption.syncReference calls it in-transaction and a consumption →
  layers → projects → consumption import cycle is fatal. It compares
  top-level field SETS of the old vs new pinned row; the message clears on
  the next `layers.update`.
- **Standalone maps were retired physically** (component `maps`/
  `mapLayers`/`mapLayerOverrides` tables + lib functions + exposeApi
  wrappers + `mapId` op field, app `maps.ts`, `map` artifactKind,
  `consumerKind "map"`, `bundles.linkMapLayers`/`layerResolutions`,
  `routes/maps/*`, header link). The bundle press is now two legs
  (collection, complete); `layerVersions` seeded directly in tests stands
  in for phase-5 publishing.
- `bun run fmt:check` at the repo root FAILS on two pre-existing files this
  phase didn't touch (`docs/project-workspace-design.md`,
  `docs/memory/demo-recording-recipe.md`) — scope oxfmt to your own files;
  don't reformat the design doc mid-flight.
