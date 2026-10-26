# 11. App builder as a removable feature module; apps store references, not data or grants

- Status: accepted
- Date: 2026-10-24

## Context

Users want to compose simple, shareable "apps" from their datasets: maps,
tables, and charts arranged on a page (an ArcGIS Experience Builder–style
experience, much simpler). The product owner also wants the feature easy to
remove or rework later, and shareable by URL. The design is in
[`../app-builder.md`](../app-builder.md).

## Decision

- **A self-contained feature module on each side.** The backend lives in
  `app/convex/appBuilder/` (`api.appBuilder.apps.*`, its own `apps` table
  spread into the schema with one line); the frontend lives in
  `app/src/features/app-builder/` with thin route shells under
  `app/src/routes/apps/`. The module only _reads_ the rest of the system
  (dataset docs, entry/geometry rows, the users mirror). Nothing imports it.
  Removal is a documented, five-step checklist.
- **Apps store dataset references, never data or access grants.** Widgets
  read through the existing auth-checked dataset APIs as the viewer, so
  sharing an app can never widen dataset visibility (stage 8 / ADR 0009 stay
  the only visibility rules). Adding a dataset the creator can't see is
  refused, the same rule as project membership and map layers.
- **Sharing is creator-owned and sign-in-gated:** `private` (default) or
  `link` (any signed-in user with the URL). Private and missing apps read
  identically (`null`). Only the creator edits; others can duplicate.
- **One document per app, layout as order + span.** Widgets are a bounded
  inline array (≤ 40) on the app row with an optimistic-concurrency
  `revision`; positions are list order on a 12-column dense CSS grid with
  per-widget column/row spans. We chose this over a free-form x/y grid
  library (react-grid-layout) and over a child `widgets` table.
- **Pages, each with a layout (amended 2026-10-26).** An app holds 1–12
  pages (≤ 40 widgets each, ≤ 80 in total) on the same row, each with a title
  and a `contained` or `fullscreen` layout. Full screen reuses the same
  order + span grid and only stretches its rows, so it adds no second layout
  model. Legacy single-page documents are read as one contained page and
  rewritten on their next save, so no migration is needed. The viewer keeps the
  current page in `?page=`.
- **Seeded examples are ordinary apps with a system owner.** They are owned by
  `system:examples` and marked `example: true`. Every signed-in user can read
  them, and no one can write them, because the existing owner check covers
  that without a new permission path. They read published sample datasets that
  are locked in json-cms. An internal `seed` mutation that can be re-run creates
  them.
- **Published apps render standalone (amended 2026-10-26).** The share URL
  and the builder's preview hide the product header through a generic route
  flag (`staticData.hideHeader`) and draw only the app's own bar, so a shared
  app reads as its own app. The builder keeps the product chrome.
- **Widget kinds are a registry:** a Convex validator plus a View/Settings
  module per kind. Heavy kinds (map, chart) are lazy-loaded. Charts use
  Recharts (new dependency, used only by this module).

## Consequences

- A whole-layout save rewrites one small document, which is atomic and
  simple. The array is bounded, so the guideline against unbounded arrays
  holds.
- Order + span can't express arbitrary overlapping or absolutely placed
  layouts. In exchange, layouts are responsive for free and the builder
  and viewer render the same component.
- Aggregation is client-side over live rows, so very large datasets will be
  slow in charts. The aggregate math is isolated in `lib/aggregate.ts` if
  that moves server-side or to DuckDB later.
- Anonymous public apps are explicitly out of scope; adding them needs a
  new ADR, because it means a read path outside the `auth()` choke point.
