---
name: geometry-precision-experiment
description: Geometry 6dp precision analysis (issue #45) and its implementation
  (PR #46, merged) — simplify-geometry checkbox, source-file retention,
  on-demand simplification workflow
metadata:
  type: project
---

2026-09-15 geometry-precision analysis (issue #45) → **implemented & merged as PR #46 (merge commit 85d053d) the same day.** Analysis: dataset `jx7dysaey8dmp2mw07ppq0h3818eftqm` (SS4A FY22 IG Awards, 37 MultiPolygon) had 94.1% of 611,806 coordinates at 7–13 dp (float64 noise); rounding to 6dp cut payload −27.8% raw / −22.8% gzip and map geometry-load −15% locally. A **6dp duplicate dataset `jx78knwxh0aqmnj2jgfg80st318efn5j` ("…(6dp precision)") from the experiment is still in local dev** — deletable.

What PR #46 added (json-cms component + app): (1) importer "Simplify geometry" checkbox, default ON, geospatial-only, in the Dataset Type section (copy mentions 6dp ≈ 11 cm and original-file retention); (2) original-file retention — importer uploads the exact file to its own blob, `startImport`'s optional `sourceFile` attaches it to the schema doc (`sourceFileStorageId/Name/Size`), `getSourceFileUrl` query re-exposes it, deleteSchema deletes it, dataset action menu offers "Download original file"; (3) `simplifyGeometry` flag on schemas gates rounding at every geometry write path (validateEntryGeometry / resolveImportRowGeometry / convertEntriesBatchInternal) via shared `roundGeometryCoordinates` + `GEOMETRY_SIMPLIFY_DECIMAL_PLACES` (=6, in shared/geojson/geometry.ts); (4) dataset-page Ellipsis action menu → `SimplifyGeometryPanel` sheet → `startSimplification` mutation + `simplifyGeometryWorkflow` (reuses imports status doc + updateImportProgress/handleImportComplete) driving `simplifyGeometryBatchInternal` internalAction (blob reads need the action; write-chunks ≤4 MB per mutation like the import path; re-decides inline-vs-blob per row, deletes replaced blobs; idempotent → step retries safe). No auto-migration of existing data — the action covers it on demand. TS gotcha: internal actions/workflow steps whose return type flows through `internal.lib.*` need explicit return annotations or tsc hits circular inference.
