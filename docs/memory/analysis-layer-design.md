---
name: analysis-layer-design
description: SQL-analytics layer (DuckDB-WASM client-side) — designed 2026-09-21 in docs/analysis-layer-design.md, SHIPPED as roadmap stage 9 (#105): analyses are registry rows, applySql is the one engine, DuckDB engine + worker in app/src/lib/analysis*
metadata:
  type: project
---

2026-09-21: Design futures recorded in `docs/analysis-layer-design.md` —
ad-hoc analytics (DuckDB-style SQL: counts per state, avg locations per
brand) over catalog/project data, guarding five invariants (client-side
only; one row-resolution seam; typed structures + shared 0.4 coercion;
declarative/serializable specs, rollup & SQL one system; published
immutability keeps a Parquet sidecar viable).

**2026-09-29: SHIPPED as roadmap stage 9 (issue #105, branch
roadmap/9-analysis-layer).** The recorded decisions, in case they ever need
revisiting:

- **Analyses are `derivedDatasets` registry rows** whose spec carries a
  `sql` operation — projects membership `artifactKind: "derived"`, publish
  via the existing 5b machine, autosave via `derivedDatasets.save` ("zero
  new lifecycle concepts"). The `projectArtifacts.artifactKind` open union
  anticipated a literal; it stayed unneeded (schema comment records this).
- **One engine, no compilation**: `applySql(operation, rows, sideTables,
engine, options?)` in `packages/json-cms/src/shared/transform/sql.ts` —
  the sibling of applyRollup; the DuckDB handle is the INJECTED fourth
  argument (json-cms has zero duckdb deps, unit-tested with stand-ins).
  Rollup does NOT compile to SQL (the open question §4:73-74 decided by
  sharing only the interface).
- **Registered tables carry canonical key form** (strings via `normalizeKey`
  — "Aldine"/"aldine" and 42/"42" group together; numbers via
  `coerceNumber`), columns typed from the declared structure — the AC-3
  "mixed-type keys don't split groups" contract. Display casing is NOT
  preserved inside GROUP BY results.
- **Resolution is resolve-then-feed**: `consumption.analysisTargets` (new
  query, same `resolveSourceHead` core as the 7b layer resolutions) resolves
  each target server-side first — frozen version rows read as themselves
  (identity), live chain anchors float to head, registry ids rejected by
  the v1 editor. The worker receives concrete component ids only.
- **DuckDB-WASM wiring** (`app/src/lib/analysis-duckdb.ts`): lazy dynamic
  imports of `@duckdb/duckdb-wasm` + Vite `?url` assets (no CDN),
  single-threaded (no COOP/COEP), `memory_limit='1GB'`, create-or-replace
  registration via information_schema (DROP TABLE refuses views and vice
  versa), arrow table registration via `tableFromArrays` (apache-arrow
  PINNED to 17.x to match duckdb-wasm's own dep — v21 type-conflicts),
  COUNT/sum arrive as BigInt and normalize to safe numbers. The engine
  loads in the worker interactively AND in-page for publish parity
  (`publish.ts` passes `analysisSqlEngine` as a provider — only invoked
  when a spec actually carries a sql op).
- **Parquet sidecar**: still deferred (conditional, doc §3) — the worker's
  registration path is its future substitute point.

Related: [[derived-datasets-brainstorm]] (engine + lifecycle this rides on),
[[react-compiler-seam-memoization]] (the panel's hook rules).
