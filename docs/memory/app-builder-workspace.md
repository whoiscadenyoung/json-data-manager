---
name: app-builder-workspace
description: 2026-11-17 app builder laid out like the map editor — pages/widgets/data outline left, canvas middle, selection settings right; one Add menu; tabs panel retired
metadata:
  type: project
---

2026-11-17 (branch `feat/app-builder-workspace`, stacked on
`feat/map-editor-workspace`): step 3 of the approved maps/apps redesign.
Still to do: the global `/maps` and `/apps` explorers on one shared row and
`VisibilityBadge`, with plain-language create buttons.

- Same shape as [[map-editor-workspace]]: header (outline toggle, title, save
  state, ONE "Add" menu, Preview, Publish, Share, "App actions" menu), then
  outline | canvas | settings.
- `components/builder-outline.tsx`: pages in order with each page's widgets
  nested under it (untitled widgets are named by kind), then the app's
  datasets. A page row shows that page and opens its settings; a widget row
  on another page switches to it.
- `components/builder-settings.tsx` (was `builder-panel.tsx`): the old
  Add/Data/Widget/Page tabs are gone. `BuilderSettings` shows the selection
  (`BuilderSelection` = page | data | widget) and only renders while
  something is selected; a canvas background click or Escape clears it.
  `WidgetPalette` (the old Add tab) now fills the empty-page state.
- The "Add" menu holds the widget kinds (disabled ones say why: "Needs a
  dataset"), "Page" and "Dataset…" (opens the Data settings).
- With the outline hidden, page tabs come back above the canvas so pages stay
  reachable.
- Deleting an app from the project builder returns to the project's Apps
  list, not the global `/apps`.
- Full-screen pages are labelled on the outline button (`aria-label`); a
  sr-only span did not get a space into the accessible name.
