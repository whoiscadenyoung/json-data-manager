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

  [[project-anon-serving-0024-lessons]], [[user-profiles]].

# Walkthrough outcomes (2026-11-07, main @ f854daa)

The §5 tourism scenario passed end-to-end in the browser and caught FOUR
real bugs that no test suite had:

- **Target-sheet handoff** (new): the sheet discarded the freshly-created
  project's id and handed the caller the pending marker — the new-project
  path of the start-from-here affordance had never been clicked before.
- **Foreign published maps crash the explorers** (pre-existing from #257):
  a map visible via a widened rung embeds NULL — or, under concurrent
  writes, NO — owning project; both the maps explorer and the editor read
  `.project.title` unguarded. Fixed by typing the embeds nullable and
  normalizing (absent → null) at the store boundary. Lesson: PostgREST
  embeds are `null` for unreadable rows AND the key can be ABSENT under
  concurrent deletes — normalize at the store, never trust the typed shape.
- **Linked-layer app freeze refusal** (pre-existing from #259): the freeze
  walk treated a linked layer placement as unreachable, but the link-or-
  clone picker produces exactly that shape; the walk now reuses the
  frozen `layer_versions` id the membership's artifactId carries. Lesson:
  for linked LAYER memberships, artifact_id names the VERSION, not a row.
- **Bundle press planned non-dataset kinds** (pre-existing from 0022's
  kind-domain widening): every non-dataset artifactKind became a derived
  publish leg and failed the press — the collection-minting path was dead
  for any project holding derived/layer/app memberships. Presses are
  datasets-only (D6). Test lesson: the press stub's member READ must
  reflect minted rows, never fabricate from the artifacts list (a stub
  that invents members pins the bug in place).

Verification beats, all on main: home → /projects redirect; both apps serve
signed-out from frozen snapshots; datasets explorer (Published chips +
project chips); maps explorer (By-link + used-in-apps chips); collections
dual-path (bundle-minted card names its press + standalone without chip);
update-available → sync moved a stale pin to v2; closure preflight→apply
ran twice (7- and 4-artifact lists; foreign pins correctly NOT widened).
Related: [[project-centric-brainstorm-2026-11-05]].
