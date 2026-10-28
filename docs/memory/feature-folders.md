---
name: feature-folders
description: 2026-10-27 restructure step F2 — app/src split into core + domain
  features + optional modules; two-tier boundary rules (ADR 0014 amendment)
  enforced by no-restricted-imports + import/no-cycle; maps has a separate
  `tiles` entry so the root bundle skips MapLibre
metadata:
  node_type: memory
  type: project
---

Step F2 moved 70 files from flat `app/src/components` + `app/src/lib` into
`app/src/features/{maps,datasets,versions,publishing,analysis,catalog,dashboard}`
(each with `components/`, `lib/` and a generated `index.ts`). Core keeps the
shell, `dataset-type-tags`, `dataset-picker-sheet`, `confirm-delete-dialog`,
the row seam (`dataset-rows*`, `version-rows`) and, until step F3 moved it
to `@caden/analysis`, the DuckDB engine.

- **"Features never import features" didn't survive contact.** The real
  graph has domain features building on each other (datasets → versions →
  publishing ← analysis; catalog/app-builder/layer-styles → maps). ADR 0014
  was amended to two tiers: domain features may import each other's root
  entries if the graph stays acyclic; optional modules (app-builder,
  layer-styles) are imported only by routes; core never imports features.
- **Cycles found and broken** by moving small shared pieces to core:
  `dataset-type-tags` (datasets ↔ versions), `confirm-delete-dialog` (was
  under dashboard), `version-rows` (rows seam ↔ versions), and the DuckDB
  engine (publish ↔ analysis).
- `import/no-cycle` resolves the `#/` alias through `app/package.json`
  `imports`; verified it fires on a probe cycle and is clean on the real code.
- **Root bundle**: `map.tsx` has top-level side effects (protocol
  registration, MapLibre CSS), so `__root.tsx` imports the tile managers
  from `#/features/maps/tiles`, not the maps index. Checked in the build: the
  entry chunk only lists the map chunk in Vite's lazy preload map.
- A `vi.mock` of a moved cross-feature module must mock the feature entry
  (`vi.mock("#/features/publishing", …)`), which replaces the whole entry.
- The move codemod and import-merge scripts lived in the session scratchpad;
  rerunning needs the old → new map in the F2 PR description.
