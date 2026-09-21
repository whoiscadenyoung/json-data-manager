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
