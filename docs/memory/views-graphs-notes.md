---
name: views-graphs-notes
description: "#304 gotchas — React Flow + elkjs graphs: client-only lazy impl, elk bundled import, jsdom stubs, store query split, edge direction"
metadata:
  type: project
---

`app/src/features/view-graphs/` (2026-11-10, #304): `buildLineageGraph`,
`buildViewStepGraph` (pure, tested), `layoutGraph` (elkjs layered, RIGHT),
`<LineageGraph projectId>` and `<ViewStepGraph definition selectedStep
onSelectStep>`; route `/projects/$projectId/lineage`.

- **Client-only**: `graph-view.tsx` lazy-imports `graph-view-impl.tsx`
  (@xyflow/react + elkjs + its CSS) behind `useSyncExternalStore` `useIsClient`,
  the json-editor shape. Build is fine: the impl is a separate lazy client chunk
  (~1.6 MB) and the finalize-ssr guard passes (nitro still bundles elkjs into
  `_libs`, never evaluated at SSR).
- Import elk as `elkjs/lib/elk.bundled.js` (runs in the main thread and in
  node/vitest); types come from `elkjs/lib/elk-api`.
- **Layout is a `useQuery`** keyed by node/edge ids (`graphSignature`), not
  effect + state (oxlint forbids set-state-in-effect). `<ReactFlow key=signature>`
  so `fitView` reruns when the graph changes.
- **jsdom component tests** need `ResizeObserver` and `DOMMatrixReadOnly` stubs;
  nodes still render in the DOM unmeasured. Keep the store import (supabase env
  check in `src/env.ts`) out of components under test: the fetching wrapper
  `lineage-graph.tsx` is separate from the pure `lineage-graph-view.tsx`.
- Strict lint applies to the builders: no `?.`, no `forEach`; read stored step
  JSON through an `isLoose` type guard instead of casts.
- Edges point in data-flow direction (dataset -> view, dataset -> layer -> map
  -> app) so LTR reads sources on the left. Linked layers (membership pins a
  layer_versions id) are not resolved into map edges. Layers have no page, so
  clicking one does nothing. View route `/projects/$id/views/$viewId` comes from
  #301; navigation uses `router.history.push` because the typed `to` can't name
  a route that doesn't exist yet.
- Lint noise in a fresh worktree (`any` overrides, json-cms module errors) is
  the stale `packages/json-cms/dist`: `rm -rf dist && bun run build` there first.
