---
name: views-canvas-editor
description: 2026-11-16 view editor workspace — full-height outline + React Flow canvas + settings + docked preview, one selection (steps, inputs, output), new-view page; test stub and gotchas
metadata:
  type: project
---

2026-11-16: the view page (`features/views/components/pg-view-page.tsx`) is
ONE full-height workspace (`lg:h-[calc(100vh-7rem)]`, the map editor's
sizing; `/views/` is an editor path, so the project sidebar starts as the
rail): header, then step outline (left, `step-outline.tsx`), flow canvas
(middle), settings (right) and a collapsible Preview / Run history / Exports
panel docked under the canvas. The owner asked for this over a separate
Canvas / List toggle, which is gone. Everything follows ONE selection
(`lib/selection.ts`): a step, a nested step, an input (by alias) or the
output. The settings panel is the same `StepList`, rendered with
`only={index}`; an input shows `input-detail.tsx`.

- **Clicking an input previews that input alone**: a one-input, no-steps draft
  through the normal preview function (the nested-preview shape). It is
  enabled even while the steps are incomplete.
- Step kinds share one icon + tint (`view-graphs/lib/step-kind.ts`) across
  canvas nodes, the outline and the settings card.
- The graph stays generic: `buildViewStepGraph(definition, options)` takes
  `inputTitles`, `describeStep` (label/detail/badge) and `outputDetail`; `flow`
  edges carry `insertIndex`. The page supplies them from
  `features/views/lib/canvas-nodes.ts` and draws the "+" through
  `renderInsert` (`InsertStepButton`).
- **Page tests mock `@/features/view-graphs` with
  `components/test-step-graph.tsx`** (same graph as plain buttons); React Flow
  throws `ResizeObserver is not defined` in jsdom otherwise.
- The canvas is narrow between two sidebars, so the initial fit may go down
  to 0.45 zoom; the outline is what stays readable at any flow length.
- `<ReactFlow key={signature}>` keeps its viewport across HMR and same-URL
  navigation: reload the page before judging the initial `fitView`.
- A lucide icon picked through a helper function trips
  `react(static-components)`; pick it with an inline expression.
- **"New view" is a page, not a sheet**: route `/projects/$projectId/views/new`
  (`components/new-view-page.tsx`) takes a title and a base picked from the
  project's dataset memberships, draws start -> output on the canvas, then
  creates and opens the editor. `CreateViewSheet` is gone; the shell's "Add
  new > View" and the catalog's "New view" navigate there. Steps still start
  in the editor: a view has no preview before it has a base and an id.
- The initial fit is capped at 100% zoom (a two-node graph filled the box
  with giant cards otherwise).
- Not built: drag-to-reorder nodes (reorder is the settings card's arrows)
  and changing the base input of an existing view.

Related: [[views-graphs-notes]], [[views-editor-and-derived-retire]].
