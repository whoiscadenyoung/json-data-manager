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
   - (#305) `auto` is a job table (`view_refresh_queue`) filled by a
     `data_version` trigger and drained by the app server, running as the
     editor who turned it on; `live` reads are a capped server function.
     Details and measurements: `docs/views-design.md` §7.
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

## Addendum 2026-11-17: views combine, links point

Status: accepted. Refines D6 ("Relations stay for related records…") and the
open question in design §12.

**Model.** Datasets hold rows. Views combine datasets: a `join` adds
columns, and the new `append` (Stack) step adds rows. Links (the stored
`dataset_relations`, ADR 0020) only power map clicks: the linked features
highlight and are listed in the popup. The UI says "link"; the table and
ADR 0020 keep "relation".

**Decisions.**

1. **`append` step.** `{ kind: "append", sources: [{ input, tag? }], tagField?, baseTag? }`
   compiles to `UNION ALL` over the current rows and each source input. Rows
   keep their own geometry, so stacking spatial datasets yields one spatial
   dataset (FY22 + FY23 + … corridors, each row with its own shape). A tag
   stamps a scalar (a fiscal year) into one field. Row ids are global
   primary keys, so stacked ids never collide. Fields match by name; a field
   a source lacks is absent on its rows.
2. **Combining across years is attribute joins, not spatial joins.** Stack
   each dataset family (awards, areas, corridors, intersections), tag each
   with `fiscal_year`, then join a stacked spatial view to the stacked awards
   view on `UEI` + `fiscal_year`. Geometry comes from the base (the stacked
   spatial view). `UEI` repeats across years, so `fiscal_year` is part of the
   key. A true spatial step (`spatialJoin`, `dissolve`) is still later work;
   this needs none of it.
3. **Links are managed from each dataset's page** (Related tab), with key
   suggestions from shared field names. The catalog's Relations section is
   removed; the row's badge opens the Related tab.
4. **Group-level relations are rejected.** Folders are organizational only,
   and pairing "FY22 awards with FY22 corridors" needs a rule no table
   expresses. Stacking covers the real need.
5. **A saved view may be a link end; a live view may not** (migration 0035):
   a live view saves no rows, so the bounded runtime query would see an
   empty side.
6. **Existing links** are replaced by hand; there is no migration.

**Risks.** A stale view gives stale popups (refresh it). An input dataset
can't be deleted while a view reads it, and stacking makes that more likely.
`sql` steps and `live` views are unaffected.

### Addendum 2026-11-17 (b): explicit inputs, uniform input edges

Advice from a design consult, adopted:

- **`base` stays**, meaning "the input the pipeline starts from". Stack's
  asymmetry was presentation only, so it was fixed there: the Stack form is
  one table (Dataset | Tag) whose first row is the rows flowing in (the Start
  when Stack is step 1), and the canvas draws every input into the step with
  the same solid `input` edge (start, join right side, stacked source, SQL
  `in_<alias>`). `branch` is now only the step-to-step chain inside a join's
  sub-pipeline. Inputs nothing reads show an "Unused" badge.
- **Inputs are explicit.** The editor has an Inputs panel (add with search,
  choose the Start, rename an alias, see what uses each input, remove when
  unused). Join, Stack and SQL pickers offer only declared inputs. Save no
  longer prunes unused inputs, so a declared input counts for staleness,
  auto-refresh and "can't delete a dataset a view reads". `inputUsages` and
  `renameInputAlias` live in `@caden/data-core/views` (`reuse.ts`).
- **New view** takes several datasets (the first is the Start).
- Not done: an inline "Add input…" item inside the step selects (inputs are
  added in the panel), and "Stack them" seeding on the new-view page.

### Addendum 2026-11-17 (c): Stack column mapping

A Stack merges fields by exact name; users can now see and change that
mapping. `AppendSource.columns` and `AppendStep.baseColumns` hold optional
per-member `ColumnEdit`s (`{ from, as }` rename / re-map, `{ from, exclude:
true }` drop), applied to that member's rows before the `UNION ALL`. Untouched
fields pass through, so existing stacks are unchanged and no migration is
needed (definitions are plain JSON).

- Compiler (`chain.ts` `editedRow`): `(d - 'a' - 'b') || case when
jsonb_exists(d,'a') then jsonb_build_object('x', d -> 'a') else '{}' end`;
  every key is a bind parameter; all reads use the original row (swaps work);
  a rename of an absent field adds no null key; geometry is untouched.
- Validation: shape (`from`/`as` non-empty, no duplicate `from`, `exclude`
  only `true`), `Unknown field` for a `from` the member lacks (when its
  fields are known), and a collision error when a rename lands on a field
  that stays. Field scope after the step is the union of each member's edited
  fields (`editFields` in `validate-fields.ts`).
- UI: a Columns table under the Stack dataset table (`append-columns.tsx`,
  pure model in `lib/append-columns.ts`): Merged / Only in … / Renamed /
  Excluded status, inline rename, per-cell re-map, exclude toggle, and
  one-click "Merge X into Y" chips for case/punctuation-insensitive matches
  (never applied silently).
