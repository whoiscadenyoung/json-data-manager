---
name: map-editor-workspace
description: 2026-11-17 project map editor is a workspace in features/maps/components/map-editor — header with one Add layer menu, selectable draggable layer list, settings panel on the right that follows the selection; restores layer styling; gotchas
metadata:
  type: project
---

2026-11-17 (branch `feat/map-editor-workspace`, stacked on
`feat/project-maps-apps-pages`): step 2 of the approved maps/apps redesign.
Still to do, in order: app builder alignment (outline left, settings right),
then the global `/maps` and `/apps` explorers on one shared row and badge.

- The editor left the 1,947-line route for
  `features/maps/components/map-editor/`: `map-editor.tsx` (reads, layout,
  dialogs), `layer-outline.tsx` (the list), `layer-settings.tsx` (the right
  panel), `map-editor-sheets.tsx`, `layer-grouping.ts`, `types.ts`. The route
  is a thin shell. `features/maps` imports `#/features/layer-styles`
  directly (it already did in `stored-map-canvas.tsx`; layer-styles left the
  optional-module list with #259).
- Header: the layer-list toggle, the map's name, ONE "Add layer" menu
  (dataset from this project / published layer from another project / new
  group) and a "Map actions" menu (edit name and description, delete).
- Layer list: a row click selects; rows drag to reorder (the store only has
  `movePlacement` up/down, so a drop runs one swap per step); the color dot
  is the layer's swatch; "published" is an icon, not text.
- Settings panel: shows only while a row is selected. A data layer gets its
  dataset link, relation notes, popup fields and the style controls; a group
  says what it holds; a linked layer explains why it is read-only and offers
  an editable copy. Selecting a data layer opens its style controls
  (`useLayerStyles` gained `edit`, `editingId`, `isStyled`, `reset`).
- **Styling had been unreachable**: the old route never rendered the hook's
  `datasetActions` menu, so nothing could open the Style panel. The settings
  panel is now the way in.
- Every removal carries its own confirm text (`PendingRemoval`): remove from
  map, unlink, ungroup, delete layer (a group's text says its layers stay).
  The old single dialog told "Remove from project" that the layer would stay.

Gotchas:

- "Uncaught (in promise) ReferenceError: document is not defined" in the
  console is a dev-server hot-reload artifact from the map workers: it shows
  up after files change, not on a plain reload. Count with
  `read_console_messages` `pattern`, across two reloads with no edits.
- The browser pane's console buffer is not cleared on navigation and its
  "N matching" total can shrink; compare filtered counts, not totals.
- Not built: undo for a reorder, optimistic reorder (the list updates when
  the writes land), renaming a layer from the panel.

Related: [[project-maps-apps-pages]], [[views-canvas-editor]],
[[layer-styles]], [[ui-polish-expectations]].
