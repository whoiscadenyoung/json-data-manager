# Analysis layer — SQL over catalog and project data (future design)

Design futures for ad-hoc analytics over datasets — DuckDB-style SQL on the
data users already have in the app ("how many restaurants in each state,"
"average locations per restaurant brand"). Captured 2026-09-21; **nothing to
build now** — this doc records the invariants today's work must protect so
the layer stays cheap to add later. It rides the seams created by
[`derived-datasets-design.md`](./derived-datasets-design.md) (the transform
engine, ADR 0005) and
[`catalog-lifecycle-design.md`](./catalog-lifecycle-design.md) (draft /
publish lifecycle, ADR 0008); those decisions cover it, so no ADR of its own.

## 1. Context and goal

The analysis examples on the table are group-by rollups: counts per state,
averages per restaurant brand. That makes SQL and the planned rollup
primitive **one system, not two**: the rollup spec is the guided UI, freeform
SQL is the power-user escape hatch, and both feed the same engine interface
and the same downstream path — an analysis result is a derived dataset in
waiting, promoted through the lifecycle's materialized publish.

## 2. Invariants to protect now

- **Analytics run client-side.** DuckDB-WASM in a Web Worker, read-only SQL
  over locally registered tables. Server-side analytics is rejected: Convex's
  16 MiB per-query caps and the absence of a vectorized engine make it a
  fight, while the rows already stream to the client for maps and exports.
  Repo precedent: the GeoLibre research notes already flag DuckDB-WASM
  Spatial as the local-engine pattern. Any future feature proposing
  server-side analytics is a smell.
- **One row-resolution seam.** Analysis must query what the user is actually
  looking at: a published dataset, or a project draft with derived views
  applied. That is the same job the map preview and export paths need under
  the lifecycle — so when the transform engine lands (ADR 0005 §10 steps
  1–2), build **one client-side resolver** ("resolve this dataset's rows —
  draft or published, specs applied") and hang preview, export, and the SQL
  engine off it. Per-surface row-fetching logic would triple the mess.
- **Typed structures stay accurate end-to-end.** Entries are schemaless
  JSON; a columnar engine wants typed columns. The bridge is the declared
  structure each dataset already carries (type inference at import), plus
  the derived-dataset design's requirement that specs produce computed
  output types. The invariant: every pipeline that creates or transforms a
  dataset keeps its declared structure real, with mixed-type coercion
  policies shared with the join key-normalization rules (`GrantId` as string
  in one file, number in another, is the same disease). Arrow
  (`apache-arrow`) registration into DuckDB is the fast path.
- **Specs stay declarative and serializable**, so a SQL-backed operation can
  join later as just another spec type instead of a parallel universe — and
  saved queries can round-trip as data.
- **Published immutability stands** (ADR 0008). This is what makes a future
  columnar sidecar correct: see §3.

## 3. Later-stage decisions (deliberately unconstrained now)

- **Engine loading**: lazy-load the WASM bundle only when the analysis
  surface opens; single- vs multi-threaded build (COOP/COEP headers) chosen
  then; set `memory_limit` and rendered-result caps.
- **Columnar sidecar at publish** — the analytical sibling of the tile
  archive: a Parquet/GeoParquet artifact per published *version*, queried by
  DuckDB-WASM over HTTP range requests without full download. Only becomes
  relevant when published datasets outgrow client-side streaming; it is
  viable precisely because published datasets are immutable versions, so
  don't break that property later.
- **Spatial analytics** (duckdb-spatial) — timing relative to the tile path;
  tabular analytics v1 needs no geometry handling.
- **Saved analyses as project artifacts** — the lifecycle absorbs them (a
  query draft publishes like any artifact); no new lifecycle concepts.

## 4. Open questions

- UX surface first: a SQL editor, or canned-query builders that compile to
  the same engine?
- Whether the rollup UI compiles *to SQL* under the hood, or shares only the
  engine interface with it.
- Sidecar trigger threshold (dataset size / query patterns that justify
  Parquet materialization at publish).
