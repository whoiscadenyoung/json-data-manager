# Views — design

Date: 2026-11-10 · Status: implemented; reshaped as a node graph 2026-11-17
([`views-node-graph-design.md`](views-node-graph-design.md), ADR 0028
addendum d) ·
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
| D2  | The node graph compiles to one Postgres SQL statement (a CTE per node) and runs in Postgres/PostGIS                                                     |
| D3  | Runs save their output into the view's rows; refresh modes are `manual` (default, with a stale badge), `auto` and `live`; exports always use a snapshot |
| D4  | One SQL engine: a server function runs runs, previews and Scratch queries in Postgres as the user (RLS); DuckDB-WASM is retired                         |
| D5  | The Analysis and Transform tabs fold into the View editor; a relation's "Join into a table" becomes "Create view from relation"                         |
| D6  | Relations stay for related records without a joined field; a join node can be seeded from one                                                           |
| D7  | Reuse by Duplicate (with input remap), chaining, and Extract to view; no templates                                                                      |
| D8  | Flat output is the contract; arrays are opt-in only                                                                                                     |
| D9  | Each join chooses what happens when several rows match (incl. summarize and spread); preparing a side first is its own node, never a sub-pipeline       |
| D10 | Output schema has key, label, hidden and order; layer tooltips default to it; export profiles choose keys or labels                                     |
| D11 | Keeping or omitting empty fields is the user's choice, per export profile                                                                               |
| D12 | Join keys get normalization options and a manual key map                                                                                                |
| D13 | React Flow draws the catalog lineage graph and the view's node graph, which is also the editor's canvas                                                 |

## 4. Definition format: a graph of named nodes

The definition is plain JSON stored on the view dataset. It is validated
and compiled in `@caden/data-core`; the compiler is pure (definition plus
source metadata in, SQL text plus params out). There is one format: no
`version`, no legacy linear shape, no conversion (ADR 0028 addendum d).

```ts
type ViewDefinition = {
  nodes: Record<string, ViewNode>; // key = stable node id (a lowercase slug)
  result: { node: string; output: OutputSchema }; // the node the view saves
};

type ViewNode = { label?: string } & (
  | { kind: "source"; ref: { kind: "dataset"; id: string; version?: string } }
  | { kind: "filter"; from: string; where: Condition }
  | { kind: "columns"; from: string; edits: ColumnEdit[]; only?: string[] }
  | { kind: "calculate"; from: string; fields: { field: string; expr: Expr }[] }
  | { kind: "groupBy"; from: string; by: string[]; measures: Measure[] }
  | { kind: "sql"; from: string; reads?: string[]; query: string }
  | {
      kind: "join";
      left: string;
      right: string;
      on: KeyPair[];
      matching: KeyMatching;
      type: "left" | "inner";
      multiMatch: MultiMatch;
      fields?: string[];
      prefix?: string;
    }
  | { kind: "stack"; inputs: StackInput[]; tagField?: string }
);

type StackInput = { node: string; tag?: AppendTag; columns?: ColumnEdit[] };
type ColumnEdit = { from: string; as: string } | { from: string; exclude: true };
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

- **Every processing node produces a new, independent dataset-like node.**
  Later nodes read nodes by id; nothing nests. Any node may read any other
  node (a node is shared by being read twice). Cycles are an error
  (`Node "a" reads itself: a → b → a`), in the validator and the compiler.
  Nodes that are not an ancestor of `result.node` do not compile and show an
  "Unused" hint.
- **Ids** are stable slugs from the label (`^[a-z0-9_]{1,40}$`, never a uuid or
  a dataset id). Renaming a label never changes an id, so references never
  break.
- **Field references** are names in the row of the node being read. Joined
  fields land as `<prefix>.<field>`; the prefix defaults to a slug of the
  right node's title (a source's dataset title, else its label, else its id).
  The `columns` node and the output schema rename them.
- **Sources are datasets.** A view used as a source is a dataset of kind
  `view`, so chaining needs no special case. A source reads current rows
  unless `version` pins a published version. The saved `view_inputs` rows are
  derived from the source nodes (`alias` holds the node id).
- **Cycles across views** are rejected at save: the input graph is checked
  through `view_inputs`.
- **`spread` columns are declared**, not discovered at run time, so the
  output schema is stable. The editor proposes them from the distinct
  values in a preview. Categories found at run time without a column are
  reported in diagnostics and never add columns silently.
- **`hidden` fields** can be used by later nodes and by layer styling,
  but are left out of tooltips and exports.
- **`stack`** is a `UNION ALL` of its inputs; each row keeps its own geometry,
  and a tag (e.g. a fiscal year) and column edits belong to the **edge**
  (`StackInput`). Untouched fields pass through.
- **`columns`** renames or drops many columns in one node (`ColumnEdit`s are
  shared with stack edges); `only` is an optional keep list (no ordering; display order is the Output card's) applied
  after the edits.
- **`calculate`** holds several fields, evaluated in order, so a later one may
  read an earlier one.
- **Spatial nodes later.** `spatialJoin` (within, intersects, nearest),
  `dissolve` and `buffer` are later node kinds. The union stays open for them.

### Calculate expressions

A small expression language parsed into an AST, then compiled to SQL. It
is never spliced in as raw text. v1 supports: field refs, literals,
`+ - * /`, comparisons, `and/or/not`, `coalesce`, `case when`, `concat`,
`lower/upper/trim`, `replace(text, find, with)`, `number(value)`, `round`,
`year/month/day`, and `if(cond, a, b)`. String literals use single quotes;
double quotes name a field.
Typing follows the input `json_schema`, with casts at the reference
site. The node stores each expression as its source text (`expr: string`);
the parser produces the AST.

## 5. Worked example (the end-to-end test fixture)

Inputs:

- `states`: multipolygons with `id` and `name`.
- `deployments`: points with `id`, `name` and `stateId`.
- `deployment_agencies`: `deploymentId` and `agencyId`.
- `links`: `stateName`, `type` and `url`. There are 0–3 rows per state,
  and some names have stray whitespace or different casing.

View **States enriched**, a graph over four sources:

1. `agency_counts` = `join` `deployments` (left) with `deployment_agencies`
   (right) on `id = deploymentId`, multiMatch `summarize [count → agencyCount]`.
2. `with_deployments` = `join` `states` (left) with `agency_counts` (right) on
   `stateId = id`; multiMatch is `summarize [count → deployments (empty 0),
topBy(name by agencyCount max) → mostCollaboration]`.
3. `enriched` (the result) = `join` `with_deployments` with `links` on
   `stateName = name`, matching `trim + caseFold`, with multiMatch `spread by
type value url` and columns `docs → docsLink` and `benefits → benefitsLink`.
4. Output: `name`, `deployments` (label "Deployments"),
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

Diagnostics for `enriched` report the `links` rows that matched no state and
the states with no links. Neither changes the output.

## 6. Compiler (Postgres)

- **Node CTEs.** Each node becomes `in_<id>(row_id, d jsonb, geom)`. A
  `source` node reads `entries` left-joined to `geometries`, filtered by
  `dataset_id`; a pinned version reads `version_entries` instead. Rows stay as
  jsonb `d` throughout, so the compiler never needs DDL. Nodes build a new `d`
  with `d || jsonb_build_object(…)` or `d - 'key'`.
- **Order.** Depth-first from `result.node`, dependencies first, ties by
  `nodes` key order; only ancestors of the target compile. A `calculate` node
  emits one CTE per field. `uptoNode` compiles the ancestors of one node and
  reads its CTE (previews).
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

- **Geometry** travels with each row through every node; a stack keeps each
  row's own geometry. `groupBy` drops geometry in v1; `dissolve` is the later
  spatial answer.
- **Identifiers and values.** Every identifier is quoted by the compiler
  (`quote_ident` semantics in TS) and every value is a bind parameter.
- **`sql` node.** The user query is parsed (a Postgres parser in TS or
  WASM). It must be a single `SELECT` with no data-modifying CTEs, and
  may reference only `prev` (its `from` node) and `in_<id>` for its `from`
  and `reads` nodes.
  Output columns are classified by name: `d` (jsonb properties), optional
  `row_id` and `geom`; any other columns become properties (merged into `d`
  when present). `select * from prev` keeps everything.
- **Golden tests.** Each node kind × mode has a golden SQL file in
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

  **Runner location (decided in [views 2], #300): a server-side runner**
  (TanStack Start server functions in `app/src/server/views`, talking to
  Postgres directly with `postgres` (porsager)). The browser sends only a
  view id (plus an optional node id to preview up to, or a draft DEFINITION as JSON) and its
  Supabase access token. It never sends SQL and never sees rows; user SQL
  (the `sql` node) is compiled on the server and reaches no endpoint a
  browser can call.
  - **Acting as the user.** The server verifies the access token itself
    (HS256 with `JWT_SECRET`, algorithm pinned, expiry/audience/role checked;
    `claims.ts`), never a client-supplied user id. Each transaction then runs
    `set local role authenticated` and installs the verified claims as
    `request.jwt.claims`, so `auth.uid()` and RLS behave exactly as through
    PostgREST.
  - **Phase 1** (`begin read only`, always rolled back): `set local
statement_timeout` (default 60 s, `VIEW_RUN_TIMEOUT_MS`), then
    `view_input_versions` (the gate: editable view, every input viewable;
    versions captured _before_ the read), the definition and input metadata,
    the compile, and the execute. Rows stay on the server. An input the user
    cannot see is refused loudly rather than read as zero rows.
  - **Phase 2** is a separate write transaction: the verified claims are
    installed and `view_apply_run` / `view_record_failure` are called. They
    are `SECURITY DEFINER`, take rows as data, execute no user SQL, and are
    executable ONLY by the `view_runner` role (revoked from authenticated and
    anon); they re-check `can_edit_dataset` and input visibility against the
    verified user. The server connects as a login role that is a member of
    `view_runner` (`jdm_server` in compose; a superuser works for dev/CI).
  - Entries of a view can only be written by `view_apply_run` (statement-level
    guard triggers bind a token to `<view id>:<xid>`). It diffs by a
    deterministic entry id (`md5(view || row_id || occurrence)`, not the
    input's `row_id`, which is a global primary key already taken) so re-runs
    touch only changed rows and the tile version only bumps on real change.
  - **Why a server function, not an RPC pair.** A first version ran phase 1
    through a SQL-taking RPC (`view_query`) and ferried rows through the
    browser. That put client-supplied SQL on an endpoint any signed-in user
    can call, could not enforce `statement_timeout` (a function cannot re-arm
    the timer of its own top-level statement), and trusted the browser to
    carry honest rows. The server runner fixes all three; the cost is a
    server-only Postgres connection (`DATABASE_URL`, `JWT_SECRET`) and the
    token round-trip. `create_view` / `save_view` still take definitions, not
    SQL, and stay PostgREST RPCs with DB-side checks (inputs visible, no
    cycle, editable view).
  - Run payloads are held in server memory (capped at 1M rows) and sent to
    Postgres as one jsonb parameter; chunked staging is the follow-up if
    real views outgrow that.

- **Stale** means any input's current `data_version` differs from the
  last successful run's. It is computed in the catalog query and shown as
  a badge.
- **Failures** keep the last good rows; the view shows the error and its
  run history.
- **`auto` mode** (decided in [views 7], #305; migration 0029):
  - **Mechanism: a job table drained by the app server, not pg_cron.**
    pg_cron exists in the stack (0012), but a cron job can only run SQL and
    a view run needs the TypeScript compiler and the server runner, so cron
    could at most poke something. Instead an `AFTER UPDATE OF data_version`
    trigger on `datasets` upserts one `view_refresh_queue` row per unpinned
    `auto` view that reads the dataset (a view's own run bumps its
    `data_version`, so chains cascade). `due_at` is first change + 60 s
    (`jdm.view_refresh_debounce_seconds`); further changes inside the
    window coalesce into the same row (a fixed coalescing window, not a
    trailing debounce, so a steady stream of edits cannot starve the
    refresh). A Nitro plugin starts a loop (`VIEW_REFRESH_POLL_MS`, default
    15 s) that calls `view_refresh_claim` (`FOR UPDATE SKIP LOCKED`, safe for
    several app servers) and runs each claim through the ordinary two-phase
    runner. A claimed row is the per-view lock ("at most one concurrent
    run"; a claim older than 15 minutes is treated as abandoned); an edit
    that lands mid-run is remembered in `redo_at` and re-queues one more
    run when the current one finishes.
  - **Identity: the editor who turned `auto` on.** `datasets.auto_refresh_by`
    is set to `auth.uid()` by `set_view_refresh_mode` (re-selecting Auto
    takes the identity over). The drain runs the view as that user:
    `role authenticated` plus a claim set for the stored id, so RLS and
    `can_edit_dataset` apply exactly as for a manual run. The server trusts
    its own database for this id; no browser token is involved. Why not the
    creator: a creator who stopped editing would silently keep running
    something a different editor configured; the person who enabled Auto
    is the one who accepted its access. If that user loses access (or the
    profile is deleted), the run fails at the gate, an errored `view_runs`
    row is written (`view_refresh_record_failure`, which does not need edit
    rights) and the previous rows stay. The header shows "Last run failed".
  - `set_view_refresh_mode` is executable only by `view_runner`;
    `create_view` / `save_view` refuse to move a view to auto/live, so the
    server's checks cannot be bypassed through PostgREST.
- **`live` mode** saves no rows (`view_stale` is always false for it).
  Reads go through the `readLiveViewFn` server function: the compiled SQL
  runs as the reader in the phase-1 envelope (read-only, rolled back,
  `statement_timeout` 15 s by default, `VIEW_LIVE_TIMEOUT_MS`) and the
  result is capped at 20 000 rows (`VIEW_LIVE_ROW_CAP`; longer results are
  truncated and flagged). A reader who cannot see an input is refused
  loudly, never shown zero rows.
  - **Spatial nodes.** `isSpatialStep` (`app/src/lib/views/spatial.ts`) is
    the hook; it answers false for every v1 kind. `live` is refused when it
    is true for any node, both when the mode is set and on every read (the
    definition can change after the mode was chosen).
  - **Table:** the table page reads the capped result once and runs
    search, filter and sort over it in the browser (`live-rows.ts`); there
    is no `search_entries` over rows that were never saved.
  - **Map:** a live view's layer uses the row path through
    `PgLiveGeometriesLoader` (one capped server read, no worker pass) and
    the tile manager's watch feed excludes live views, so no archive is
    ever built. The dataset's declared columns and geometry flag are
    mirrored by an editor's read (`view_sync_live_meta`, metadata only), so
    the table has columns and the map treats it as geospatial.
  - **Exports** snapshot: exporting a live view runs it once (a normal saved
    run) and exports those rows.
  - **Measured** (5 000 point rows with five properties, local Docker,
    Apple silicon, real compiler, warm): 180-320 ms per read for 1.2 MB of
    JSON; 20 000 rows: 560-730 ms for 4.7 MB. A snapshot run of the same
    views costs 1.7 s and 5.8 s (it also writes). So the row path is
    enough at 5k: reads are interactive and the cap keeps the worst case
    bounded. The 20k cap is also about where a single JSON response and
    the main-thread GeoJSON build stop feeling instant; beyond that,
    switch to manual/auto and let the tile archive carry it.
- **Publishing and freezing** use the existing path.
  `dataset_versions.lineage` records `{ definition, inputVersions }`.

## 8. Diagnostics contract

Diagnostics are `{ nodes: [{ id, kind, rowsIn, rowsOut, fieldsAdded,
fieldsRemoved, join? }] }`, one entry per compiled node (dependencies first).
Every node reports the row count in and out and the fields added or
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
- **View editor** (one full-height workspace on one selection: a node or the output):
  - Left: the outline, nodes in dependency order with an "Unused" hint for
    nodes the result does not need.
  - Middle: the **canvas is the structure editor** (add a node after the
    selection, "+" on any connection inserts a node on it, branch from a
    node, mark the result, remove a node and reconnect its readers), with
    the preview, run history and exports docked under it.
  - Right: the **Sources** panel (datasets and views as source nodes, who
    reads each, Unused) and the selected node's form (filter, columns,
    calculate list, group, join, stack with its Columns table, SQL). Any node
    previews, with its diagnostics and "Add to key map" on unmatched samples.
  - Output card: keys, labels, hidden flags and order.
  - Header: Run, refresh mode, Duplicate, Export. Reuse: Duplicate (remap a
    source's dataset, checked per node), Prune, Extract to view (a node and its
    ancestors become a view).
- **Create view from relation**: pre-fills two source nodes and a join node
  on the keys.
- **Graphs** (`@xyflow/react` + elkjs auto-layout):
  - _Catalog lineage_: nodes are datasets, views, maps, layers and apps.
    Edges are view inputs (solid), relations (dashed) and consumers.
    Clicking a node opens it, and stale views are marked.
  - _View node graph_: sources and nodes joined by the reads between them,
    ending in the output; the editor's canvas. Selecting a node selects it
    everywhere.
- **Scratch query**: a raw SQL pad over the project's datasets and views,
  unsaved, replacing the Analysis tab. It runs on the server in Postgres
  through the preview path: read-only, as the user (RLS), with a timeout
  and a row cap. Datasets are exposed by name as CTEs (the same input CTE
  layout the compiler uses), so the SQL a user writes is the SQL a `sql`
  node will run. "Save as view" creates a view with one `sql` node over the
  tables it reads, with no dialect translation.
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
  rewritten on save, one row per `source` node (`alias` = the node id). It drives lineage, cycle checks, staleness and the
  "Used by" lists.
- `view_runs (id, view_id, status, started_at, finished_at, row_count,
input_versions jsonb, diagnostics jsonb, error text, created_by)`.
- `export_profiles (id, dataset_id, name, settings jsonb)`.
- **Dropped:** `derived_datasets`, the `derived` artifact kind, the
  relation join mint RPCs, and the derived-row read paths in
  `dataset-rows-pg.ts` and the bundle publish.
- **Visibility (implemented in [views 2]; confirmed by the owner 2026-11-10):**
  - Saved rows of a view follow the view dataset's own gates, like any
    dataset.
  - Saving (`create_view` / `save_view`) or running a view requires
    `can_view_dataset` on every input, with no lifecycle gate: unpublished
    project drafts are valid inputs.
  - Live reads run as the invoker, so they also require it.
  - Run history (`view_runs`, which holds diagnostics with sample input
    values) is readable by the view's editors and creator only.
  - `view_stale` is `SECURITY DEFINER` and leaks one boolean about inputs
    the reader may not see.

  This mirrors publishing: whoever builds the view decides what it exposes.
  Other implemented facts: a client cannot INSERT a view directly (only
  `create_view`); an input dataset cannot be deleted while a view reads it
  (NO ACTION FK); run history keeps the last 50 runs per view; a view is
  stale with no good run yet, when its definition hash changed, or when any
  unpinned input's `data_version` moved.

## 11. Test plan

- **data-core:** validator cases (cycles, unknown nodes, unknown fields,
  missing spread columns), golden SQL for every node kind and mode, PGlite
  runs (the owner's d1…d4 graph, per-source clean before a tagged stack,
  stack → clean → join, multi-field calculate with `replace`/`number`,
  multi-edit columns node, unused nodes, geometry through a stack), expression
  parser tests.
- **int (dedicated DB, never the live compose DB; see
  `docs/memory/int-test-db-split-ri-teardown.md`):**
  - run/preview RPCs;
  - RLS (a viewer cannot run; an invoker without an input cannot read a
    live view);
  - `sql` node rejection (DML, data-modifying CTE, undeclared table);
  - staleness flips when an input changes;
  - `auto` debounce;
  - the §5 fixture's expected output and diagnostics.
- **app:** editor outline, canvas editing and preview, node forms, output
  schema editor, export profile → GeoJSON, React Flow graphs render from
  fixture data.
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
