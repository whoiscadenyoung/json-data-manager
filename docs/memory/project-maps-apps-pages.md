---
name: project-maps-apps-pages
description: 2026-11-17 project Maps and Apps are list pages in the catalog's table style; sidebar links with counts, Overview tiles, labeled new-map dialog; step 1 of the approved maps/apps redesign path
metadata:
  type: project
---

2026-11-17 (branch `feat/project-maps-apps-pages`): step 1 of the maps/apps
redesign the owner approved. The remaining steps, in the approved order: map
editor workspace (move out of the 1,947-line route into `features/maps`,
one "Add layer" menu, selection-driven settings panel), app builder
alignment (outline left, settings right), then the global `/maps` and
`/apps` explorers on one shared row and badge.

- `/projects/$projectId/maps` and `/projects/$projectId/apps` are list pages
  (`features/publishing/components/pg-project-lists.tsx`): one table each,
  search, sort by name or modified, row menu with Rename and Delete. A row's
  name opens its editor; an app's public page is the menu's "Open the app".
- The sidebar has one "Build" group with Maps and Apps links and counts. It
  no longer lists every map and app, and the per-item "New map" / "New app"
  sidebar buttons are gone (the toolbar's "Add new" and the pages create).
- Overview is three tiles (Catalog, Maps, Apps) with counts and the newest
  three names. The old card lists (`PgProjectMapsSection`,
  `PgProjectAppsSection`) were deleted.
- "New map" is `new-map-dialog.tsx`: labeled Name (required, inline error on
  an empty submit, never a silently disabled button) and optional
  Description. An empty name no longer becomes "New map".
- Shared pieces: `SortHead` (generic over the sort key) and `RowMenu` are
  exported from `pg-catalog-rows.tsx`; `FolderNameDialog` takes `fieldLabel`
  and renames maps and apps too; `visibility-badge.tsx` is the one badge for
  who can open a map or app (the global explorers still carry their own
  copies until step 4).
- Deleting a map from its editor lands on the Maps list. The list's delete
  dialog names the apps that show the map.
- Maps and apps are deliberately NOT in the catalog's folders: that needs a
  migration nobody has scoped.

Gotchas:

- Base-ui row menus are not driven in the jsdom page test; rename and delete
  were checked in the browser instead.
- The browser pane's simulated `cmd+a` does not select an input's text.

Related: [[catalog-file-browser]], [[views-canvas-editor]],
[[ui-polish-expectations]].
