---
name: analysis-layer-design
description: Future SQL-analytics layer (DuckDB-WASM client-side) designed in docs/analysis-layer-design.md — invariants recorded now, nothing built, no ADR (covered by 0005/0008)
metadata:
  type: project
---

2026-09-21: Design futures recorded in `docs/analysis-layer-design.md` —
ad-hoc analytics (DuckDB-style SQL: counts per state, avg locations per
brand) over catalog/project data. **Nothing to build now; the doc exists to
protect five invariants** so the layer stays cheap to add:

1. Analytics run **client-side** (DuckDB-WASM in a worker) — server-side
   analytics is rejected (16 MiB caps, no vectorized engine; rows already
   stream to the client). GeoLibre research already flagged DuckDB-WASM
   Spatial as the local-engine pattern.
2. **One row-resolution seam**: a single client-side resolver ("dataset
   rows, draft or published, specs applied") feeds map preview, export, AND
   the future SQL engine — lands with ADR 0005 §10 steps 1–2.
3. **Typed structures stay accurate end-to-end**; mixed-type coercion
   shared with join key normalization; Arrow registration is the bridge.
4. **Specs stay declarative/serializable** so SQL-backed operations join as
   another spec type; rollup primitive and freeform SQL are ONE system
   (rollup = guided UI, SQL = escape hatch, same engine + same
   "save result as derived dataset" path).
5. **Published immutability** (ADR 0008) keeps the future Parquet/
   GeoParquet sidecar correct (analytical sibling of the tile archive;
   HTTP range requests per version).

Analysis results/queries are project artifacts — the lifecycle absorbs
them; no new concepts. Deliberately unconstrained: WASM loading strategy,
duckdb-spatial timing, sidecar trigger threshold.

Related: [[derived-datasets-brainstorm]] (engine + lifecycle this rides on),
[[convex-platform-limits]] (why server-side analytics is a dead end).
