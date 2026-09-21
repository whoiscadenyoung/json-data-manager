---
name: derived-datasets-brainstorm
description: Tableau-like transformation design (specs → virtual derived datasets) captured in docs/derived-datasets-design.md + ADR 0005; Projects layer deferred, references-not-containment is the binding rule
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

Projects layer: DEFERRED (design §9). The user's multi-consumer concern is
solved by derived datasets, not Projects. The binding rule that keeps a
future Projects layer cheap is **references-not-containment**: derived
datasets are global catalog citizens, never nested/owned. Triggers to
revisit: real multi-user with a permission story, or map sprawl beyond
lightweight grouping. Open question for the user: multi-user future = shared
deployment or isolated audiences?

Related: [[bound-datasets-poc]] (frozen tag versions pin lineage; live bound
datasets compute live), [[break-initiatives-into-ordered-agent-issues]]
(candidate issue sequence is design §10).
