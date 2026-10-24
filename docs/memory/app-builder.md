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

Related: [[demo-recording-recipe]], [[ui-polish-expectations]], [[local-dev-verification]]
