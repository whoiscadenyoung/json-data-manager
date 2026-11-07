---
name: project-262-explorers-closeout
description: #262 closeout gotchas — explorer polish surfaces, the standalone-create retirement ripples, and the back-reference read shapes
metadata:
  type: project
---

# [project 8] Explorers + cross-project reuse (#262) — implementation notes

- **The train's last phase is mostly wiring, not machinery**: phases 1–7
  already shipped the D1 global picker, sync/float/pin/revert badges, and
  the bundle press's minted collection. The closeout's real deltas were the
  front door (`/` → redirect `/projects`), the explorer chrome (publish/
  visibility/project chips), the used-in back-references, and retiring the
  standalone create flow.
- **Standalone-create retirement ripples**: killing `/datasets/create` also
  required threading `projectId` into the app-builder's DataPanel (its
  "import new data" link targeted the dead route) and tightening
  `PostgresCreateDatasetPage` to require `projectId` (the standalone
  branches — markImportComplete flip, back-to-datasets nav — deleted with
  it).
- **Back-reference reads are one-query-per-surface, RLS-scoped**:
  `projects.listVisibleArtifactMembershipsQueryOptions()` (all visible
  membership rows + project embed; filter `artifact_kind in (dataset,
derived)` — the kind domain is `dataset|derived|layer|app` since 0022)
  feeds the datasets explorer's chips AND the dataset overview's Used-in
  card; `appsStore.appMapIds()` scans widget jsonb for `mapId` (the one key
  the builder writes) for the maps explorer's used-in-apps chips;
  `publishing.listBundlesForCollectionQueryOptions()` resolves the minted-by
  chip. No service-role anything: foreign projects/invisible apps simply
  don't render (ADR 0024 records why that's the honest answer).
- **Chip rule regression to watch**: the maps explorer (shipped #257) had a
  project Link nested INSIDE the card's Link — anchors can't nest (the
  user-profiles memory's rule); #262 restructured the dataset/map cards so
  the badge row is a sibling of the main link.
- Related: [[project-centric-brainstorm-2026-11-05]],
  [[project-anon-serving-0024-lessons]], [[user-profiles]].
