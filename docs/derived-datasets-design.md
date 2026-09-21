# Derived datasets — a Tableau-like transformation layer over the catalog

Design for data transformation in the Tableau mold: declarative **transform
specs** that produce **virtual derived datasets** over the existing catalog —
joins for tooltip/export enrichment, group-by rollups for long/relational
data — without ever altering an imported dataset. Captured 2026-09-21 from
the brainstorm; **design only, nothing implemented yet**. The Projects-layer
question raised in the same discussion is assessed and deferred in §9.

> **Superseded 2026-09-21 (in part)** by
> [`catalog-lifecycle-design.md`](./catalog-lifecycle-design.md) and
> [ADR 0008](./decisions/0008-catalog-lifecycle.md): §9's Projects deferral
> is reversed by the catalog-lifecycle design (projects = the virtual
> working layer; publish materializes), and §11's materialization question
> is answered (publish materializes and freezes). The engine and execution
> design in §§2–8 stands; implementation remains staged per lifecycle §8.

## 1. Context and goal

The app's datasets are imported once and then consumed by maps, tables, and
exports. Two consumption gaps motivate this work:

- **Enrichment.** Datasets sharing a key column (e.g. `GrantId` appearing in
  three datasets alongside a `grants` dataset) can't reference each other.
  We want to point a dataset at its parent (`grants`) so grant fields show up
  in map tooltips and in exports.
- **Aggregation.** Long/relational shapes — e.g. the `restaurantLocations`
  join table in `app/convex/schema.ts` mapping restaurants to locations —
  can't currently be viewed as "number of locations per restaurant."

Hard requirement: **the underlying imported data never changes.**
Transformations are applied at consumption time; different consumers (maps,
exports, later people) each get the shape they need over the same source.

What the codebase already gives us to build on:

- **Exports are client-side** (`app/src/lib/export.ts`): GeoJSON / JSON /
  XLSX via exceljs, built from paginated rows the client already fetched —
  shared by the dataset and group export dialogs.
- **Map popups are on-demand single-entry reads** (issue #52,
  `app/src/components/layers-map.tsx`): one indexed read per click,
  subscribed only while the popup is open. First paint deliberately pays no
  O(total rows) entries fetch.
- **Byte-budget pagination** (#48: 10 MB budget, 500-row ceiling) streams
  full datasets to the client without tripping the 16 MiB per-query caps.
- **Datasets have declared structures** (`?view=structure`), so key-column
  pickers and derived-column types have something to read.
- **The aggregation demo data already exists**: `restaurants`,
  `locations`, and the `restaurantLocations` join table are the PoC foreign
  domain in `app/convex/schema.ts`.

## 2. Decisions recorded

- **Transform specs in, virtual datasets out.** A transform is a small
  declarative spec ("dataset X joined to Y on `X.grantId = Y.grantId`,
  bringing in `Y.name`/`Y.status`"; or "group `restaurantLocations` by
  `restaurantId`, count"). Its output is a **derived dataset** that behaves
  like a dataset everywhere the app already consumes datasets. Base data is
  never mutated; there is no materialization into base tables in v1.
- **Transformations live at the catalog (dataset) level, not map level.**
  Map-level enrichment config would redefine the same join for every layer,
  lock tables out of reusing it, and fork the export path. The map stays
  what it already is: a consumer of datasets — it just may now point at a
  derived one.
- **One pure engine, two executors.** The join/rollup functions are pure
  TypeScript living in `@caden/json-cms` (next to the import parsers), run
  client-side over paginated rows for tables and exports, plus an on-demand
  lookup path for map popups (§5). Avoiding a server-side materialization
  sidesteps the 16 MiB per-query caps and stays reactive over live queries.
- **References, not containment.** Derived datasets are global catalog
  citizens with stable ids, exactly like base datasets. Specs reference
  source dataset ids; nothing nests under or is owned by a map, layer, or
  (future) project. This is the rule that keeps the deferred Projects layer
  cheap to add later (§9).
- **Deliberately not in v1:** a general expression language, SQL, pivots
  (long→wide), filters, calculated fields, persistent materialization. The
  primitive set is two operations deep until both have consumers.

## 3. Concept model

- A **transform spec** records: the source dataset, one or more operations,
  output column naming, and the datasets it depends on.
- A **derived dataset** is the virtual result: it appears in the datasets
  browser (badged as derived), can be added to a map as a layer, exports
  through the existing dialogs, and can serve as the *source of another
  spec* — derived-of-derived.
- Composition therefore forms a **DAG**: e.g. `restaurantLocations` → rollup
  (locations per restaurant) → joined back into `restaurants` to attach
  names and cuisine. Cycles are rejected at spec-save time; deleting a
  source marks dependents stale/orphaned rather than silently breaking them.

## 4. The two primitives

1. **Lookup (many-to-one enrichment).** Rows in the base dataset gain
   namespaced fields from one related row (`grants.name`,
   `grants.status`). Row count is unchanged. Powers tooltips and flattened
   exports.
2. **Rollup (group-by aggregation).** Group a long/join table by one or
   more key columns; compute measures — count, sum, avg, min/max, distinct
   count. Output is small (one row per group) and, being a dataset, is
   immediately re-joinable into a parent dataset (the composition above).

## 5. Execution model

**Bulk path (tables, exports).** The client already streams full datasets
via byte-budget pagination; the pure engine joins/groups those rows in
memory (20k-row scale is trivial compute) and every downstream surface —
dataset table, export dialog, map layer — reads the result. Convex is
uninvolved in computation; reactivity falls out of live queries re-running
the engine.

**Popup path (the open engineering question).** Pre-joining everything
client-side just for tooltips would undo #52's on-demand popup work. Two
candidates:

- *(a)* On-demand server lookup when a popup opens: read the clicked entry,
  extract its key, fetch the related row, merge. Wrinkle: entry data is
  schemaless, so field-value lookups aren't indexed — this needs a small
  maintained key→entryId index table (the `bindingEntries` precedent) or a
  scan.
- *(b)* Keep the popup dumb and let it read from the same client-side joined
  view — simple, but only works when both datasets are small enough to be
  fully loaded client-side.

Lean: same spec, two executors — bulk client-side, popup via option (a).
Decide at implementation time.

## 6. Join and aggregation semantics

The details that make joins feel trustworthy instead of magical:

- **Key hygiene**: trim/case/number-vs-string coercion on join keys (JSON
  imports make `GrantId` a string in one file and a number in another).
- **Match policy**: default left join (unmatched rows survive with null
  enriched fields); inner join as an explicit choice.
- **Duplicate keys in the lookup table**: first match, last match, or
  config error — must be decided, not implicit.
- **Name collisions**: brought-in fields are namespaced (`grants.status`)
  so exports and popup labels stay unambiguous.
- **Match-rate diagnostics in the preview UI**: "87% of rows matched; 214
  orphan GrantIds." This is the detail that separates Tableau-like
  confidence from a footgun.
- **Dependency handling**: DAG composition, cycle rejection, stale/orphan
  states when a source is deleted or re-imported with different columns.

## 7. Interaction with bound datasets

Derived specs over bound data follow `docs/bound-datasets-design.md`:

- Over a **frozen tag version**, the spec pins that lineage — the derived
  view is as immutable as its source.
- Over the **live bound dataset**, the spec computes live so syncs flow
  through automatically (free under the client-side execution model).

## 8. UI sketch

- Datasets already use `?view=` tabs; a **Transform** tab is the natural
  home: pick an operation → pick the related dataset (key columns
  auto-suggested from declared structures) → pick fields → **preview the
  first N rows with match stats** → save the spec.
- Derived datasets show in the browser (badged), layer onto maps like any
  dataset, and appear in the existing export dialogs (plus an "include
  joined fields" toggle on base-dataset exports).
- Popups render the namespaced fields once enrichment is attached.

## 9. The Projects layer — assessed, deferred

> **Superseded 2026-09-21** by
> [`catalog-lifecycle-design.md`](./catalog-lifecycle-design.md) / ADR 0008:
> Projects are now designed (the virtual working layer; publish
> materializes into the catalog). The references-not-containment rule below
> survives inside the working layer, and the *implementation* deferral still
> holds — projects land last, behind auth gating (lifecycle §8). The
> original assessment is kept for the record.

The same discussion raised a **Projects** concept: a layer under which maps
fall, where consumers could "import" catalog datasets, define derived views,
and organize maps/exports — making imports a catalog view.

Two problems were untangled:

- **"Different consumers need different formats over immutable imports"** —
  already solved by this design. Ten people wanting ten shapes of one grant
  dataset is ten specs over one source; nothing here assumes single-user.
- **"Consumers need a container grouping their maps, views, exports"** —
  the actual Projects proposal, which is an organizational/sharing layer.

**Decision: defer Projects.** Reasons:

- The app already runs two organizational hierarchies — groups/collections
  for datasets (PR #43) and saved map views whose layer-groups mirror that
  hierarchy (PR #47). A third tree (projects → maps → layers → datasets)
  adds real UI and cascade surface for a benefit that is mostly aesthetic
  today.
- Projects' strongest justification — multiple people — doesn't exist yet
  (auth is a stub returning "anonymous"; multi-user is a known post-MVP
  gap). Its final shape depends on which multi-user future arrives
  (colleagues sharing one deployment vs. isolated audiences needing
  permissions), and that can't be known until it's real.
- For *datasets*, a container already exists (groups/collections). The only
  flat thing is the maps list; if clutter bites first, lightweight map
  grouping (folders/tags on the existing pattern) is a UI-level fix, not an
  architectural layer.

**What keeps the door cheaply open** is the references-not-containment rule
(§2): a future Projects layer is then just a small registry — project → map
ids + derived dataset ids + (later) members — over entities that are already
referenceable by id. No data moves, no re-parenting.

**Trigger conditions to revisit**: real multi-user with a permission story;
map sprawl that lightweight grouping can't absorb; curated bundles at a
scale where ad-hoc grouping stops working.

## 10. Candidate sequencing

If/when approved, this breaks into ordered implementation issues:

1. Spec types + pure transform engine in `json-cms` (lookup first),
   unit-tested.
2. Derived-dataset registry (an app-side table, the `datasetBindings`
   precedent for referencing component ids as strings) + preview UI with
   match stats.
3. Surfacing: export "include joined fields," derived datasets as map
   layers, popup enrichment (popup executor decision lands here).
4. Rollup primitive + join-back composition (locations-per-restaurant →
   restaurants).
5. Later: filters, calculated fields, pivots; stale/lineage indicators.

## 11. Open questions

- Composite (multi-column) join keys, or single-column only in v1?
  (Single keeps v1 much simpler.)
- Should enrichment default to a picked subset of fields (exports) or all
  fields (popups)?
- Popup executor: key→entryId index table vs. client-side key map (§5).
- Appetite for materialization ("flatten this derived view into a real
  dataset") — **answered 2026-09-21**: publish materializes and freezes;
  see [`catalog-lifecycle-design.md`](./catalog-lifecycle-design.md) /
  ADR 0008.
- Multi-user future: shared deployment or isolated audiences? **Partially
  answered**: the lifecycle is designed (lifecycle doc + ADR 0008) with
  auth gating as the prerequisite; sharing granularity stays open until
  auth lands.
