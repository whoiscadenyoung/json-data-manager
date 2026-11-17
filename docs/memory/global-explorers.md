---
name: global-explorers
description: 2026-11-17 global /maps and /apps explorers share one layout (src/components/explorer.tsx) and VisibilityBadge (src/components/visibility-badge.tsx); "New map"/"New app"; step 4 of 4 of the maps/apps redesign
metadata:
  type: project
---

2026-11-17 (branch `feat/global-maps-apps-explorers`, stacked on
`feat/app-builder-workspace`): step 4, the last of the approved maps/apps
redesign (see [[project-maps-apps-pages]], [[map-editor-workspace]],
[[app-builder-workspace]]).

- `src/components/explorer.tsx` holds the shared pieces: `ExplorerPage`
  (title, description, create button, search box), `ExplorerList`,
  `ExplorerRow` (kind icon, title link, chips, description, one meta line),
  `ExplorerEmpty`, `ProjectChip`, `matchesSearch`, `updatedOn`. It lives in
  `src/components` because `features/app-builder` and the maps route both use
  it and neither feature depends on the other.
- `VisibilityBadge` moved from `features/publishing/components` to
  `src/components/visibility-badge.tsx` for the same reason; the project
  lists import it from there. The two inline copies of the badge are gone.
- Rows are whole-row links (`after:absolute after:inset-0` on the title
  link); chips that link elsewhere carry `relative z-10` so they stay
  clickable.
- Create buttons say "New map" / "New app" (was "Start from here"). New map
  asks "Which project is the map for?" and lands on that project's Maps page.
- Known, not fixed here: the global site header overflows at phone width
  (page scrolls sideways); predates this work.
