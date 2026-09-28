# 5. Transformations are catalog-level virtual derived datasets; a Projects layer is deferred

- Status: accepted
- Date: 2026-09

## Context

The app needs Tableau-like data transformation: joining datasets on a shared
key (e.g. `GrantId` → a `grants` dataset) to enrich map tooltips and
exports, and rolling up long/relational tables (e.g. the
`restaurantLocations` join table → locations per restaurant). Imports must
never change — different consumers need different shapes over the same
source. Alongside this, a **Projects** layer was proposed: a level under
which maps fall, where consumers organize derived views and exports, making
imports a catalog view.

The full design brainstorm is captured in
[`../derived-datasets-design.md`](../derived-datasets-design.md); this
record fixes the architectural direction.

## Decision

- **Transformations are declarative specs producing virtual derived
  datasets.** Base data is never mutated; nothing is materialized into base
  tables. A derived dataset behaves like a dataset everywhere (browser,
  map layers, exports, popups) and can feed another spec (a DAG, cycles
  rejected).
- **Transforms live at the catalog (dataset) level, not map level.** The
  map remains a consumer of datasets; per-map enrichment config is
  rejected (it would redefine joins per layer, exclude tables, and fork
  exports).
- **One pure engine, two executors.** Join/rollup functions are pure
  TypeScript in `@caden/json-cms`, run client-side over paginated rows for
  tables/exports, with a separate on-demand lookup path for popups
  (preserving the issue #52 on-demand popup design).
- **References, not containment.** Derived datasets are global catalog
  citizens with stable ids; specs reference source ids; nothing nests
  under a map, layer, or project.
- **A Projects layer is deferred**, not designed out. It is an
  organizational/sharing layer, motivated by multi-user consumption that
  doesn't exist yet (auth is a stub). It returns when a real trigger
  arrives: actual multi-user with a permission story, or map/bundle sprawl
  lightweight grouping can't absorb. Thanks to references-not-containment,
  adding it later is a thin registry of references — no data moves.

## Consequences

- Every transformation consumer (maps, tables, exports, popups) reuses one
  dataset-shaped surface instead of growing its own join feature; the same
  spec serves all of them.
- The client stays the compute host for bulk transforms (matching the
  client-side export path), so per-query caps and export paths are
  unaffected; the popup executor choice (index table vs. client key map)
  remains an open implementation decision.
- Derived datasets introduce dependency-tracking obligations (DAG,
  staleness on source deletion/re-import) that plain imported datasets
  don't have.
- The organizational surface stays as-is (groups/collections + maps). If
  map clutter grows before multi-user does, the interim fix is lightweight
  map grouping, not a hierarchy.

## Addendum (2026-09, roadmap stage 3b — issue #97): the popup executor is resolved

The "on-demand lookup path for popups" above was left as §5's open question
(index table vs. client-side joined view). Decided at implementation time,
as the design intended:

**Mechanism: (b) — client-side enrichment, generalized to "on demand at
click time".** A popup click enriches through the row-resolution seam's
point read (`applyEntryRowSpec` in `app/src/lib/dataset-rows.ts`): the
saved, read-time-healthy specs targeting the clicked dataset are resolved
(`derivedDatasets.listBySource` → `get`), the lookup datasets' rows stream
through the seam's reactive bulk path, and the stage 1 engine
(`applyLookup`) folds the namespaced fields onto the one clicked entry.
There is no key→entryId index table, so the original framing of (b) — "only
works when both datasets are small enough to be fully loaded" — is
superseded: the joined view is materialized client-side per popup, for only
while the popup is open (the issue #52 subscription pattern), then dropped.
First paint pays nothing for joins; an open popup pays O(lookup-dataset
rows) — pages of the same byte-budgeted `entries.listPage` reads the bulk
path always makes — and the reactive cache keeps a reopened popup cheap.
This is the same trade the tables and exports already make, moved to click
time; §5's lean toward (a) is recorded as fixed the other way.

**Layer: the constraint dissolves rather than being answered.** The index
table was (a)'s prerequisite, and "index and trigger must share a layer"
existed because nothing observable marks import completion. With no index,
no trigger and no new table are needed — component or app side. For the
record, should (a) ever be revived (popups over lookup datasets too large
to stream per click): the index must live **component-side**, next to a
writer at import completion — the component is the only layer that observes
it (the success path of the import workflow's progress updates), while the
app side has no host-observable completion signal at all
(`app/convex/imports.ts` is a pure `exposeApi` passthrough;
`app/convex/derivedSpec.ts` records the same absence for staleness).

**Executor semantics** (each pinned by test in `dataset-rows.test.ts`):

- Only specs with status `saved` and read-time health `ready` enrich —
  drafts never surface to catalog consumers, and an orphaned/stale spec
  would render nulls at best.
- **All** matching specs apply, folded in `listBySource` order (newest
  first), each spec's operations in order; later enrichment wins
  same-named keys, per the engine. The picked-vs-all default of §11 is
  "as stored": an op with `fields` brings its picks; an op without brings
  the engine's omit-means-all union.
- An unmatched key renders null for every enrichment field — never an
  error, never a dropped popup. The popup-side corollaries: an inner-match
  miss leaves the base row (the bulk path drops the row; a popup cannot
  disappear), and an `onDuplicateKey: "error"` conflict skips only that
  operation.
- A lookup side that fails to stream leaves the popup base-only (joined
  fields stay "loading"); it never breaks the panel.
- **Registry lookup sides enrich nothing (yet).** A saved+ready spec whose
  lookup side is itself a derived dataset has no rows the popup can stream
  — derived datasets are compute-on-read and only publishing materializes
  rows — so the executor checks every lookup side against the registry
  before streaming and such specs settle base-only, rather than hanging a
  never-completing pagination or presenting all-null fields as a healthy
  spec's answer. (The health walk labels these specs "ready" today via
  `specStatus`'s registry-reference branch; the popup executor's gate is
  the recorded exception until stage 4's composition — or a future
  client-side materializer of derived rows — gives those sides rows to
  join. The builder already refuses to save derived lookup sides
  (`transform-editor.tsx` filters to component datasets), so the gate is
  defense for direct saves and for stage 4.)

**The derived-layer contract (stage 3a / #96 implements to this).** The
executor keys on the clicked feature's `{entryId, schemaId}` payload: the
spec shortlist is `listBySource(schemaId)` and the entry read is
`entries.get(entryId)`. For a derived layer's features this requires the
payload's `schemaId` to be the **defining spec's `sourceDatasetId`** (the
base dataset the rows compute from) — then the spec is found, enrichment
applies, and `entries.get` reads the source entry unchanged, so `entryId`
needs no adaptation. A derived layer whose feature properties carry the
derived dataset's own registry id instead will render base-only popups:
that shape contradicts this contract and must not ship. The bulk path keeps
feature properties `{entryId, schemaId}` stable precisely so this stays a
wiring rule, not a new payload.

**Scope of governance.** This executor governs the virtual/preview
surfaces: derived layers on maps (stage 3a) and project previews (lifecycle
§9's open question is answered by this addendum). Published maps keep the
existing #52 path on materialized rows — a published dataset's popups read
real rows and need no enrichment. Project previews (stage 7a) inherit this
decision unchanged: the executor is keyed on "saved specs targeting the
clicked dataset", which says nothing about what kind of surface is
clicking.
