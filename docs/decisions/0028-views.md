# ADR 0028: Views — saved, Postgres-compiled step pipelines that are datasets

Date: 2026-11-10 · Status: accepted · Umbrella: Views initiative (see
[`../views-handoff.md`](../views-handoff.md)) · Design:
[`../views-design.md`](../views-design.md)

Supersedes [ADR 0005](0005-derived-datasets-catalog-level.md),
[ADR 0027](0027-derived-ownership-route.md), and
[ADR 0026](0026-1n-join-collect.md) in part (array output becomes one
opt-in multi-match mode, not the default).

## Context

Derived datasets (ADR 0005) are virtual recipes: one source dataset plus
an ordered list of `lookup` / `rollup` / `sql` operations, computed in
the browser when read, stored in the `derived_datasets` registry, and
attached to projects as artifacts (ADR 0027). The Analysis tab is a
second surface for the same engine. Working through a real GIS flow
showed five problems:

1. Counting points per polygon (deployments per state) takes two derived
   datasets or raw SQL. Aggregating the joined side is not one step.
2. 1-N joins produce arrays (ADR 0026). ArcGIS and GeoJSON consumers
   need flat, scalar feature properties.
3. Nothing is saved as real rows. Tiles, anonymous serving (ADR 0023),
   relations (ADR 0020 "ends are datasets only"), bundle publishing (ADR
   0027 "press re-executes") and exports all work around virtual rows.
4. Two surfaces (Transform tab and Analysis tab) exist for one system.
5. There is no way to see the catalog's lineage, or a recipe's shape, at
   a glance.

Comparable products converge on one model (research in the design doc
§2). ArcGIS Data Pipelines, CARTO Workflows and dbt all treat a recipe's
output as a real table or layer. They compile steps to SQL where the data
lives, and refresh explicitly or on a schedule. Power Query and Tableau
Prep set the editing pattern: a linear list of steps, a preview for each
step, and match diagnostics for joins.

The owner directed that the app be treated as green: no backward
compatibility and no migration of stored derived specs.

## Decision

1. **A View is a dataset.** `datasets.kind` is `'source' | 'view'`. A view
   row carries a definition (inputs, steps, output schema) and is
   read-only as data. Every consumer (tables, maps, popups, exports,
   relations, apps, bundles) reads a view through the ordinary dataset
   path. The `derived_datasets` registry and the `derived` artifact kind
   are dropped. Project ownership is the normal dataset membership (ADR
   0018).
2. **Steps compile to one Postgres SQL statement** (a chain of CTEs) and
   run in Postgres/PostGIS. The compiler is pure TypeScript in
   `@caden/data-core`, covered by golden-SQL tests. This leaves room for
   spatial steps (`ST_Within`, `ST_Intersects`) later without a rewrite.
3. **Runs save their output.** A run replaces the view's `entries` and
   `geometries` in one transaction, so tile archives, publishing and
   freezing (`dataset_versions.lineage` records the recipe plus the input
   versions) work unchanged. Each view has a refresh mode:
   - `manual` (default): a **stale** badge appears when an input has
     changed since the last run, and the user decides when to refresh.
   - `auto`: re-runs (debounced) when an input changes.
   - `live`: no saved rows; reads execute the compiled SQL with caps.
     Live is limited to views without spatial steps, and is read through
     the capped, viewport-scoped path that the map runtime already uses.
   - Exports are always a saved snapshot.
4. **One SQL engine: Postgres.** A TanStack Start server function
   connects directly to Postgres as the signed-in user: it verifies the
   token, then sets `role authenticated` and the JWT claims, so RLS applies
   exactly as through PostgREST. It runs every query: saved runs, step
   previews, and the **Scratch query** pad. Scratch queries are raw SQL,
   read-only, with a timeout and a row cap; "Save as view" turns one into a
   `sql` step without translating it. The browser never sends rows, and
   sends SQL only through the scratch pad and `sql` steps. Those run as
   `authenticated`, so they can reach nothing the API can't already reach.
   The guards against expensive queries are read-only transactions, the
   timeout and the row cap. DuckDB-WASM and the Analysis worker are
   retired.
5. **One editor.** The Analysis tab and the dataset Transform tab fold
   into the View editor. A relation's "Join into a table" becomes "Create
   view from relation", which pre-fills a Join step.
6. **Relations stay** as catalog facts for related records without a
   joined field: click-highlight and related lists in popups (ADR 0020).
   A Join step can be seeded from a relation. Whether relations remain
   necessary once live views and collections exist is an open question.
7. **Reuse without templates.** There are no parameterized templates.
   Instead, views support Duplicate (optionally remapping inputs),
   chaining (a view can be another view's input, so several views branch
   from a shared prefix), and Extract to view (promote a join's
   sub-pipeline into its own view).
8. **Flat output is the contract.** Every multi-match resolves to flat,
   scalar properties unless the user explicitly picks `list`.
9. **Each join decides what happens when several rows match**: `first`,
   `last`, `summarize` (aggregate the matched rows), `spread` (pivot by a
   category column into named columns), `text` (join as a string), `list`
   (opt-in arrays), or `error`. A join's right side may be an inline
   sub-pipeline (its own steps, run before the join). Measures include
   `topBy`, the value of one field on the row where another field is
   highest or lowest.
10. **Field labels live in the view and the layer.** The view's output
    schema has a per-field `key` (the export property name), `label`,
    `hidden` flag and order. Layer tooltips default to the view's labels
    and can override them. Export profiles choose keys or labels as
    property names, and choose to keep or omit empty fields.
11. **Key matching meets users where they are.** Each join has
    normalization options (trim, case-fold, collapse whitespace, strip
    diacritics/punctuation) and a manual key map edited from the
    unmatched-keys diagnostic. Joins on names are first-class, not only
    joins on codes.
12. **Visualized with React Flow** (`@xyflow/react` + an auto-layout): a
    catalog lineage graph and a per-view step graph, both read-only in
    v1.
13. **SQL security posture.** Every compiled query and the `sql` step run
    read-only, `SECURITY INVOKER` (RLS applies), with a statement
    timeout. Only the view's declared inputs are visible, exposed as
    RLS-gated CTEs. No DDL or DML is allowed. Identifiers are quoted by
    the compiler, never interpolated. The `calculate` expression language
    compiles from a parsed AST, never by string concatenation.

## Rejected alternatives

- **Keep virtual, compute-in-the-browser derived datasets** (ADR 0005).
  Every downstream consumer needs saved rows; the workarounds were
  already piling up.
- **Separate "workflow" and "view" objects.** The recipe is the dataset
  (the dbt posture). Two objects double the lifecycle and permissions
  with no consumer that wants them apart.
- **Parameterized templates.** Too complex for the payoff; Duplicate,
  chaining and Extract cover reuse.
- **Arrays as the default 1-N output** (ADR 0026's default). GIS
  consumers need flat properties; arrays remain one opt-in mode.
- **A node-canvas-first editor** (CARTO, ModelBuilder). It is expensive
  to build and slower for the common linear case; the graph is a read-only
  visualization in v1.
- **Running SQL in both DuckDB-WASM and Postgres** (including DuckDB for
  scratch queries only). The two SQL dialects drift apart, and a query
  that works in the scratch pad would fail once saved.
- **DuckDB on the server** (`@duckdb/node-api` with the Postgres
  extension). Every input would be copied out of Postgres and the output
  written back. It adds a native binary to the SSR build, and RLS would
  have to be re-applied by fetching inputs as the user. It gains nothing
  PostGIS doesn't already provide.
- **Supabase's REST API (PostgREST) for runs.** It can only call tables
  and existing functions, so running compiled SQL would need a "run this
  SQL" RPC that the browser could also call. It would also be held to the
  `authenticated` role's short timeout, and every row would cross HTTP
  twice.
- **Executing the step format in TypeScript** (the old derived engine).
  It can't scale to large datasets or spatial work, and it duplicates
  what Postgres does.

## Consequences

- The legacy engine (`transform/spec.ts` lookup/rollup/sql kinds and
  their executors), the `derived_datasets` table, the derived route,
  `pg-derived-dataset-page`, the Transform tab and the Analysis tab are
  removed as the initiative lands. Stored derived specs are discarded,
  not migrated.
- [remedies 4] (#290, legacy join namespaces + aliases) is superseded:
  legacy specs go away, and aliases are the output schema's labels.
- Views inherit the dataset machinery for tiles, publishing, freezing
  and anonymous serving. The cost is run orchestration: run records,
  staleness tracking, and the `auto` refresh job.
- A view's saved output is readable by anyone who can read the view
  dataset. The rule for viewers who cannot read an input is decided in
  the design doc (§10).
- Spatial steps are a later step kind on the same compiler, re-scoping
  GIS 3 (#161) away from the DuckDB-WASM spatial-join plan. DuckDB-WASM
  leaves the app with the Analysis tab (#306).
