---
name: app-builder
description: 2026-10-24 app builder (ArcGIS-Experience-Builder-lite) — removable
  feature module (convex/appBuilder + src/features/app-builder), apps hold
  dataset refs only, order+span grid layout; verification + recording gotchas
metadata:
  type: project
---

The app builder shipped as a self-contained module (docs/app-builder.md, ADR 0011):
backend `app/convex/appBuilder/` (`api.appBuilder.apps.*`, `apps` table spread
into schema.ts), frontend `app/src/features/app-builder/`, routes `/apps`,
`/apps/$appId` (share URL), `/apps/$appId/edit`. Removal checklist is in the doc.
Keep new app-builder code inside those folders.

2026-10-26 additions: apps have `pages` (title + `contained`/`fullscreen` layout,
`?page=` in the viewer); legacy `widgets`-only docs are read via `appPages()`. Seeded
examples (`bunx convex run appBuilder/examples:seed`, `'{"replace": true}'` to rebuild)
are owned by `system:examples`, so the owner check makes them read-only. Users copy them.

Learned while building it:

- convex-test from a NESTED test file: glob modules ROOT-relative
  (`import.meta.glob("/convex/**/*.ts")`). A `"../**/*.ts"` glob fails with
  "Could not find module for: appBuilder/apps".
- Convex stores object keys sorted, so a dataset's JSON Schema `properties`
  come back alphabetical. "Declared order" isn't recoverable anywhere in the app.
- base-ui `Select` needs `items` (label/value pairs) or `SelectValue`
  renders the raw value (a dataset id).
- Sign-in race: navigating right after `signIn.email` can hit the AuthGate
  before the session is live, which bounces back to /signin. The sign-in page
  now forwards authenticated visitors to `?redirect=` (in-app paths only).
- Pre-existing, NOT fixed: submitting the sign-in form before hydration does a
  native GET that puts email+password in the URL (form has no method). Automation
  must wait for networkidle before filling it.
- Cloud sandbox recording: the CARTO basemap is blocked by the network policy,
  so the demo served stand-in MVT tiles (world-atlas/us-atlas → geojson-vt →
  vt-pbf) via Playwright `context.route`. SwiftShader takes seconds per frame to
  render `backdrop-filter` (dialog close stalled screenshots ~20s), so inject
  `backdrop-filter: none` for recordings. Anonymous local backend:
  `CONVEX_AGENT_MODE=anonymous bunx convex dev` from `app/`; reset a table with
  `bunx convex import --table apps --replace -y empty.jsonl`.

- Recording WebGL maps: Playwright's screencast only captures frames on repaint,
  so a static map that painted late never reaches the video. Sweep the mouse
  (`hold()` in the demo recorder) for a few seconds after the map loads.
  Wait for widget cards to exist and settle ~800ms after a tab switch before
  checking for loaders, or the check passes against the previous page.

- shadcn components without ui.shadcn.com (the cloud sandbox's network policy
  blocks it, so `shadcn add` fails with "Proxy refused to open a tunnel"): the
  registry SOURCE is on raw.githubusercontent.com at
  `shadcn-ui/ui/main/apps/v4/registry/bases/base/ui/<name>.tsx`. Those files carry `cn-*`
  style tokens; `apps/v4/registry/styles/style-mira.css` maps each one to Tailwind via
  `@apply`. Reproducing `shadcn add` means: inline the tokens (dedupe), replace
  `<IconPlaceholder hugeicons="X" …/>` with `<HugeiconsIcon icon={X} strokeWidth={2} …/>`,
  rewrite `cn`/`@/registry/bases/base/ui/*` imports to `#/lib/utils`/`#/components/ui/*`, then
  oxfmt. Verified byte-equivalent (class sets) against the installed button/select.
  Prefer the real CLI whenever ui.shadcn.com is reachable.
- Composition gotchas: `ChartConfig` theme colors exist only INSIDE `ChartContainer`
  (`--color-<key>` is scoped to `[data-chart]`), so legends must use
  `ChartLegend`/`ChartLegendContent`. `AlertDialogAction` is a plain Button, so close the dialog
  yourself. `Item` rendered as `<button>` needs its own `aria-label` (the jsx-a11y lint).

Related: [[demo-recording-recipe]], [[ui-polish-expectations]], [[local-dev-verification]]
