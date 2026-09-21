---
name: derived-datasets-brainstorm
description: Transformation design (specs → virtual derived datasets) + catalog lifecycle (projects virtual / catalog materialized) — docs/derived-datasets-design.md, docs/catalog-lifecycle-design.md, ADRs 0005 and 0008
metadata:
  type: project
---

2026-09-21: The data-transformation brainstorm is documented in
`docs/derived-datasets-design.md` with the architectural direction accepted
in `docs/decisions/0005-derived-datasets-catalog-level.md`. **Design only —
nothing implemented, sequencing not yet scheduled.**

Core direction (ADR 0005): declarative transform specs produce *virtual*
derived datasets; imports are never mutated. Transforms live at the catalog
(dataset) level, never as map-level config — maps/tables/exports/popups all
consume the derived dataset. One pure TS engine in `@caden/json-cms` (next
to import parsers), two executors: client-side bulk (tables/exports, over
byte-budget pagination) + on-demand popup lookup (preserves #52; open
choice between a key→entryId index table — the `bindingEntries` precedent —
and a client-side key map). Primitives: lookup (many-to-one) then rollup
(group-by); composition forms a DAG; match-rate diagnostics in the preview
UI are a first-class requirement.

**2026-09-21 update — catalog lifecycle designed** (`docs/catalog-lifecycle-design.md`,
ADR 0008, superseding ADR 0005's Projects deferral): **projects are the
virtual working layer; the catalog is materialized; publish is the
crossing.** Publish materializes + freezes (imports → version datasets;
derived specs executed once into version datasets with lineage) — the
earlier "register the virtual spec" lean is dead, virtual artifacts would
have to penetrate the whole perf stack (archives/extents/pagination). Catalog
append-only, republish = new immutable version, consumers pin/float with
in-app notify + diff (`tagDeltas` machinery) + sync (re-run + re-freeze) +
revert (repin) — generalizes the shipped frozen-version machinery. Auto-
publish dependencies; exposure decoupled (a materialized derived dataset is
self-contained, sources publish only if chosen — answers the restaurant-
join scenario). Bundle rule: one project = one publishable bundle
(collection + maps + datasets; SMART per-year projects). New spec field
`geometrySource` (derived rows can take geometry from a joined side).
Mapping: datasets atomic+versioned; collections = publish bundles; groups
demoted to display folders, no schema rework. Durability: drafts are
server-side documents — autosave specs/maps early, publishes checkpoint
like `syncRuns`. **Auth gating (Better Auth follow-up) gates the
projects/sharing stage only**; staging still engine-first (ADR 0005 §10,
then materialized publish, then version UX, then projects).

Related: [[bound-datasets-poc]] (frozen tag versions pin lineage; live bound
datasets compute live), [[break-initiatives-into-ordered-agent-issues]]
(candidate issue sequence is design §10 / lifecycle §8).
