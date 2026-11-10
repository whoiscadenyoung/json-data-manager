# Views — design

Date: 2026-11-10 · Status: accepted direction, implementation pending ·
Decision record: [ADR 0028](decisions/0028-views.md) · Handoff and issue
train: [`views-handoff.md`](views-handoff.md)

Supersedes [`derived-datasets-design.md`](derived-datasets-design.md) and
[`analysis-layer-design.md`](analysis-layer-design.md).

**Ground rule:** the app is green and disposable. There is no backward
compatibility and no migration of stored derived specs; drop and recreate
tables freely.

---

## 1. Problem

A user adds source datasets to a project's catalog (imported or
hand-made) and wants to shape them into what a map or an export needs:
join, aggregate, pivot, rename, filter. Then they want to keep that recipe
and refresh it when sources change. Today's derived datasets (ADR 0005)
can't do this cleanly:

- **Aggregate-then-join is not one step.** "Deployments per state" needs
  two derived datasets, or SQL.
- **1-N joins produce arrays** (ADR 0026); ArcGIS and GeoJSON consumers
  need flat feature properties.
- **Nothing is saved as real rows**, so tiles, anonymous serving,
  relations, bundles and exports each work around virtual rows.
- **The Transform tab and the Analysis tab** are two surfaces for one
  system.
- **Lineage is invisible**: there's no picture of what feeds what.

## 2. Comparable products

| Product                    | Model                                                                         | Output                                        | What we take                                                                         |
| -------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| ArcGIS Data Pipelines      | Inputs → tools (Join, Summarize, Filter, Calculate) → outputs; can schedule   | A saved feature layer (create/replace/upsert) | Output is a real layer; refresh is explicit or scheduled                             |
| CARTO Workflows            | Node canvas compiled to SQL, run in the user's warehouse                      | Warehouse tables or views                     | Compile steps to SQL; "Group by" puts point statistics onto polygons in one step     |
| Felt                       | Join a sheet to a layer on a column; matches places by name, FIPS or ISO code | A static copy                                 | Match on names, not just codes; a static join goes stale silently, so show staleness |
| Power Query / Tableau Prep | Linear list of steps with a preview each; Prep shows join matches per side    | Refreshed on demand                           | A linear step list with per-step diagnostics is the core UX                          |
| dbt                        | One model = one query, `ref()` to others; saved as a view or table per model  | View or table                                 | The recipe _is_ the dataset; how it's saved is a setting                             |
| ArcGIS field aliases       | Field name vs. alias                                                          | —                                             | Keep the machine key separate from the display label                                 |

Sources: [Data Pipelines tools](https://doc.esri.com/en/arcgis-data-pipelines/latest/process/tool-overview.html),
[Data Pipelines in Enterprise](https://www.esri.com/arcgis-blog/products/arcgis-enterprise/data-management/arcgis-data-pipelines-is-now-available-in-arcgis-enterprise),
[CARTO aggregation components](https://docs.carto.com/carto-user-manual/workflows/components/aggregation),
[CARTO Workflows intro](https://academy.carto.com/creating-workflows/introduction-to-carto-workflows),
[Felt spreadsheets](https://help.felt.com/upload-anything/spreadsheets).

## 3. Decisions

Recorded in [ADR 0028](decisions/0028-views.md); summarized here:

| #   | Decision                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A View is a dataset (`datasets.kind = 'view'`); the derived registry is dropped                                                                         |
| D2  | Steps compile to one Postgres SQL statement (CTEs) and run in Postgres/PostGIS                                                                          |
| D3  | Runs save their output into the view's rows; refresh modes are `manual` (default, with a stale badge), `auto` and `live`; exports always use a snapshot |
| D4  | Previews run in Postgres with a LIMIT; DuckDB-WASM is only for unsaved Scratch queries                                                                  |
| D5  | The Analysis and Transform tabs fold into the View editor; a relation's "Join into a table" becomes "Create view from relation"                         |
| D6  | Relations stay for related records without a joined field; a Join step can be seeded from one                                                           |
| D7  | Reuse by Duplicate (with input remap), chaining, and Extract to view; no templates                                                                      |
| D8  | Flat output is the contract; arrays are opt-in only                                                                                                     |
| D9  | Each join chooses what happens when several rows match (incl. summarize and spread) and may carry an inline sub-pipeline                                |
| D10 | Output schema has key, label, hidden and order; layer tooltips default to it; export profiles choose keys or labels                                     |
| D11 | Keeping or omitting empty fields is the user's choice, per export profile                                                                               |
| D12 | Join keys get normalization options and a manual key map                                                                                                |
| D13 | React Flow draws the catalog lineage graph and a per-view step graph (read-only in v1)                                                                  |

## 4. Step format (v1)

The definition is plain JSON stored on the view dataset. It is validated
(zod) and compiled in `@caden/data-core`; the compiler is pure (definition
plus input metadata in, SQL text plus params out).

```ts
type ViewDefinition = {
  inputs: { alias: string; ref: { kind: "dataset"; id: string; version?: string } }[];
  base: string; // alias of the input whose rows (and geometry) the view keeps
  steps: Step[];
  output: OutputSchema;
};

type Step =
  | { kind: "filter"; where: Condition }
  | {
      kind: "join";
      right: RightSide;
      on: KeyPair[];
      matching: KeyMatching;
      type: "left" | "inner";
      multiMatch: MultiMatch;
      fields?: string[];
      prefix?: string;
    }
  | { kind: "groupBy"; by: string[]; measures: Measure[] }
  | { kind: "calculate"; field: string; expr: Expr }
  | { kind: "select"; fields: { from: string; as: string }[] }
  | { kind: "sql"; query: string };

type RightSide = { input: string; steps?: Step[] }; // steps = inline sub-pipeline (D9)
type KeyPair = { left: string; right: string };

type MultiMatch =
  | { mode: "first" | "last"; orderBy?: Sort[] }
  | { mode: "summarize"; measures: Measure[] }
  | { mode: "spread"; by: string; value: string; columns: { category: string; as: string }[] }
  | { mode: "text"; field: string; separator: string }
  | { mode: "list" }
  | { mode: "error" };

type Measure = {
  as: string;
  fn: "count" | "countDistinct" | "sum" | "avg" | "min" | "max" | "topBy" | "text";
  field?: string; // not needed for count
  by?: string;
  direction?: "max" | "min"; // topBy: value of `field` on the row with the max/min `by`
  separator?: string; // text
  emptyValue?: string | number | boolean | null; // value when nothing matched (count defaults to 0)
};

type KeyMatching = {
  trim: boolean;
  caseFold: boolean;
  collapseSpace: boolean;
  stripDiacritics: boolean;
  manualMap?: { from: string; to: string }[]; // applied to the left key before normalization
};

type OutputSchema = {
  fields: { key: string; label?: string; hidden?: boolean }[]; // order = display/export order
  emptyFields: "keep" | "omit"; // default for export profiles (D11)
};
```

Semantics worth stating:

- **Field references** are names in the current row. Joined fields land
  as `<prefix>.<field>`; the prefix defaults to the input alias. `select`
  and the output schema rename them.
- **Inputs are datasets.** A view used as an input is a dataset of kind
  `view`, so chaining needs no special case. Inputs read current rows
  unless `version` pins a published version.
- **Cycles** are rejected at save: the input graph is checked through
  `view_inputs`.
- **`spread` columns are declared**, not discovered at run time, so the
  output schema is stable. The editor proposes them from the distinct
  values in a preview. Categories found at run time without a column are
  reported in diagnostics and never add columns silently.
- **`hidden` fields** can be used by later steps and by layer styling,
  but are left out of tooltips and exports.
- **Spatial steps later.** `spatialJoin` (within, intersects, nearest),
  `append`, `dissolve` and `buffer` are later step kinds. The union must
  stay open for them.

### Calculate expressions

A small expression language parsed into an AST, then compiled to SQL. It
is never spliced in as raw text. v1 supports: field refs, literals,
`+ - * /`, comparisons, `and/or/not`, `coalesce`, `case when`, `concat`,
`lower/upper/trim`, `round`, `year/month/day`, and `if(cond, a, b)`.
Typing follows the input `json_schema`, with casts at the reference
site.

## 5. Worked example (the end-to-end test fixture)

Inputs:

- `states`: multipolygons with `id` and `name`.
- `deployments`: points with `id`, `name` and `stateId`.
- `deploymentAgencies`: `deploymentId` and `agencyId`.
- `links`: `stateName`, `type` and `url`. There are 0–3 rows per state,
  and some names have stray whitespace or different casing.

View **States enriched**, base `states`:

1. `join` deployments on `stateId = id`. The right side carries a
   sub-pipeline: `join deploymentAgencies` on `id = deploymentId`, with
   multiMatch `summarize [count → agencyCount]`. The outer join's
   multiMatch is `summarize [count → deployments (empty 0),
topBy(name by agencyCount max) → mostCollaboration]`.
2. `join links` on `stateName = name`, matching `trim + caseFold`, with
   multiMatch `spread by type value url` and columns `docs → docsLink`
   and `benefits → benefitsLink`.
3. Output: `name`, `deployments` (label "Deployments"),
   `mostCollaboration` (label "Most collaboration"), `docsLink` and
   `benefitsLink`. `agencyCount` never reaches the view.

GeoJSON with "omit empty" turned on:

```json
{
  "type": "Feature",
  "geometry": { "...": "..." },
  "properties": {
    "name": "Kansas",
    "deployments": 14,
    "mostCollaboration": "Main Street",
    "docsLink": "https://…"
  }
}
```

Diagnostics for step 2 report the `links` rows that matched no state and
the states with no links. Neither changes the output.

## 6. Compiler (Postgres)

- **Input CTEs.** Each input becomes
  `in_<alias>(row_id, d jsonb, geom)` over `entries` left-joined to
  `geometries`, filtered by `dataset_id`. A pinned version reads
  `version_entries` instead. Rows stay as jsonb `d` throughout, so the
  compiler never needs DDL. Steps build a new `d` with `d || jsonb_build_object(…)`
  or `d - 'key'`.
- **Step chain.** Each step is one CTE (`s1`, `s2`, …) over the previous
  one; a sub-pipeline is a nested chain prefixed by its step id.
- **Key normalization.** One `norm_<n>(expr)` expression composed from
  the options: `btrim`, `lower`, `regexp_replace(…, '\s+', ' ', 'g')`,
  and `unaccent` (confirm the extension exists on the self-hosted stack;
  fall back to `translate`). The manual map is a `VALUES` CTE applied
  with `coalesce(map.to, raw)` before normalizing. Both sides of the join
  normalize identically.
- **Multi-match modes:**

  | Mode           | SQL                                                                                |
  | -------------- | ---------------------------------------------------------------------------------- |
  | `first`/`last` | `left join lateral (… order by … limit 1)`, or `distinct on (key)` in a pre-CTE    |
  | `summarize`    | A right-side CTE grouped by key, then a left join; `coalesce` applies `emptyValue` |
  | `topBy`        | `(array_agg(field order by by desc nulls last))[1]`                                |
  | `spread`       | Group by key with `max(value) filter (where category = '<c>')` per declared column |
  | `text`         | `string_agg`                                                                       |
  | `list`         | `jsonb_agg`                                                                        |
  | `error`        | A guard CTE that raises when any key has more than one match                       |

- **Geometry** comes from the base input and passes through unchanged.
  `groupBy` drops geometry in v1; `dissolve` is the later spatial answer.
- **Identifiers and values.** Every identifier is quoted by the compiler
  (`quote_ident` semantics in TS) and every value is a bind parameter.
- **`sql` step.** The user query is parsed (a Postgres parser in TS or
  WASM). It must be a single `SELECT` with no data-modifying CTEs, and
  may reference only the input CTE names and the previous step (`prev`).
  It must return `d` (and optionally `geom`), or plain columns that the
  compiler folds into `d`.
- **Golden tests.** Each step kind × mode has a golden SQL file in
  `@caden/data-core`. A separate int test runs the §5 fixture against a
  dedicated database.

## 7. Runs, staleness, refresh

- **Change tracking.** Add a monotonic `datasets.data_version`, bumped by
  statement-level triggers on `entries` and `geometries`. This is
  separate from `map_tile_cache_version`, which only tracks geometry.
- **A run:**
  1. Phase 1 executes the compiled SELECT in a read-only transaction as
     the invoker, so RLS applies, with a statement timeout. It records
     each input's `data_version`.
  2. Phase 2, in a separate write transaction, replaces the view's
     `entries` and `geometries`. This requires `can_edit_dataset(view)`.
  3. It writes a `view_runs` row: status, row count, input versions,
     diagnostics and any error.

  Where the runner lives (an app server function or a Postgres RPC pair)
  is decided in [views 2]. The requirement is that user SQL never runs
  in a transaction that can write.

- **Stale** means any input's current `data_version` differs from the
  last successful run's. It is computed in the catalog query and shown as
  a badge.
- **Failures** keep the last good rows; the view shows the error and its
  run history.
- **`auto` mode** queues a run when an input's `data_version` changes,
  debounced to 60 s (pg_cron or a job table), at most one concurrent run
  per view.
- **`live` mode** saves no rows. Reads call a capped RPC that executes
  the compiled SQL as the invoker. Views with spatial steps cannot be
  live. A map layer over a live view uses the row path with the
  viewport and cap rules; tile archives are not built.
- **Publishing and freezing** use the existing path.
  `dataset_versions.lineage` records `{ definition, inputVersions }`.

## 8. Diagnostics contract

Every step reports the row count in and out and the fields added or
removed. Joins also report:

- left matched / unmatched counts and up to 20 unmatched key samples;
- right matched / unmatched counts and up to 20 samples;
- the number of keys with several matches, and the policy that ran;
- for `spread`, categories found with no declared column.

Previews compute diagnostics over the full inputs, while row previews are
limited to 50 rows. Diagnostics are stored on `view_runs` for the last
run.

## 9. UX

- **Catalog**: Datasets and Views side by side. View cards show refresh
  mode, last run, a stale or error badge, and input count.
- **View editor**:
  - Left: the linear step list, Power Query style, with sub-pipelines
    indented under their join.
  - Right: a preview of the selected step and its diagnostics, with "Add
    to key map" on unmatched samples.
  - Output tab: keys, labels, hidden flags and order.
  - Header: Run, refresh mode, Duplicate, Export.
- **Create view from relation**: pre-fills the base, a Join step and the
  keys.
- **Graphs** (`@xyflow/react` + elkjs auto-layout):
  - _Catalog lineage_: nodes are datasets, views, maps, layers and apps.
    Edges are view inputs (solid), relations (dashed) and consumers.
    Clicking a node opens it, and stale views are marked.
  - _View step graph_: inputs → steps → output, with sub-pipelines as
    branches. It stays in sync with the step list (selecting a node
    selects the step). Read-only in v1.
- **Scratch query**: a DuckDB-WASM SQL pad over loaded rows, unsaved. It
  replaces the Analysis tab. "Save as view" creates a view with one
  `sql` step after validating it as Postgres SQL.
- **Export profiles** on a view: format (GeoJSON first, then CSV and
  JSON), property names (keys or labels), empty fields (keep or omit) and
  coordinate precision. The editor warns when a key is not a valid ArcGIS
  field name (letters, digits or underscore; at most 64 characters).
- **Map layers**: tooltip fields default to the view's labels and order,
  with per-layer overrides (the existing tooltip config gains a "from
  view" default).

## 10. Data model

- `datasets` gains:
  - `kind text not null default 'source' check (kind in ('source','view'))`;
  - `definition jsonb` (required when the kind is `view`);
  - `refresh_mode text check (refresh_mode in ('manual','auto','live'))`;
  - `output_settings jsonb`;
  - `data_version bigint`.

  Source-only paths (import, row editing) refuse writes to view rows.

- `view_inputs (view_id, input_dataset_id, alias, pinned_version)` is
  rewritten on save. It drives lineage, cycle checks, staleness and the
  "Used by" lists.
- `view_runs (id, view_id, status, started_at, finished_at, row_count,
input_versions jsonb, diagnostics jsonb, error text, created_by)`.
- `export_profiles (id, dataset_id, name, settings jsonb)`.
- **Dropped:** `derived_datasets`, the `derived` artifact kind, the
  relation join mint RPCs, and the derived-row read paths in
  `dataset-rows-pg.ts` and the bundle publish.
- **Visibility (proposed default; confirm in [views 2]):**
  - Saved rows of a view follow the view dataset's own gates, like any
    dataset.
  - Saving or running a view requires `can_view_dataset` on every input.
  - Live reads run as the invoker, so they also require it.

  This mirrors publishing: whoever builds the view decides what it
  exposes.

## 11. Test plan

- **data-core:** validator cases (cycles, unknown fields, missing spread
  columns), golden SQL for every step kind and mode, expression parser
  tests.
- **int (dedicated DB, never the live compose DB; see
  `docs/memory/int-test-db-split-ri-teardown.md`):**
  - run/preview RPCs;
  - RLS (a viewer cannot run; an invoker without an input cannot read a
    live view);
  - `sql` step rejection (DML, data-modifying CTE, undeclared table);
  - staleness flips when an input changes;
  - `auto` debounce;
  - the §5 fixture's expected output and diagnostics.
- **app:** editor step list and preview, output schema editor, export
  profile → GeoJSON, React Flow graphs render from fixture data.
- **e2e:** the §5 walkthrough in the browser, ending in an exported
  GeoJSON file.

## 12. Open questions

- Do relations remain necessary once live views and dataset collections
  exist (D6)? Revisit after [views 7].
- Keep run history as published versions only (proposed), or N past
  snapshots?
- Should `groupBy` ever carry geometry (union) before `dissolve` exists?
  Proposed: no.
- Live mode and tile archives: is the row path enough for live views at
  real sizes? Measure in [views 7].
