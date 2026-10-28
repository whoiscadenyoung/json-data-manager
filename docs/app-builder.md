# App builder

> Status: **implemented** (2026-10-24). Decision record:
> [ADR 0011](./decisions/0011-app-builder-feature-module.md). Walkthrough
> video: [`demo/app-builder-walkthrough.mp4`](./demo/app-builder-walkthrough.mp4);
> screenshots: [`demo/app-builder/`](./demo/app-builder/).

A simple experience builder (think ArcGIS Experience Builder, much smaller):
signed-in users compose an **app**, one or more pages of widgets that read
from catalog datasets, lay each page out on a grid, and share it by URL.

## What a user can do

| Step                  | How                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create an app         | **Apps** in the header → **New app** (title required, description optional) → the builder opens.                                                                                                                                                                                                                         |
| Add datasets          | Builder → **Data** tab → **Add dataset** (any catalog dataset you can see, up to 20). Removing a dataset removes the widgets that use it (maps just lose the layer), after a confirmation.                                                                                                                               |
| Add widgets           | **Add** tab: **Map** (geospatial datasets as colored layers, click a feature for its properties), **Chart** (bar / line / area / donut over a grouped field), **Table** (searchable, sortable rows, choose columns), **Number** (count / sum / avg / min / max), **Text** (headings, bullets, paragraphs).               |
| Configure             | Click a widget → **Widget** tab: title, dataset, fields, measure, chart type, order, columns, size.                                                                                                                                                                                                                      |
| Lay out               | Drag a widget's grip to reorder; drag its corner to resize (snaps to the 12-column grid and 64px rows), or use the width presets (¼ … Full) and height buttons. Widgets flow left-to-right, top-to-bottom; on phones every widget stacks full-width.                                                                     |
| Pages                 | The tab strip above the canvas lists the app's pages; **Add page** appends one (up to 12). The **Page** tab sets its title, layout, and order, and deletes it (confirmed when the page has widgets; an app always keeps one page).                                                                                       |
| Layout per page       | **Contained**: a centered, max-width grid with the app description above it, scrolling like a document. **Full screen**: edge to edge under the app bar, with rows stretching to fill the window, so a 12-row map fills the screen. On phones both stack like a normal page.                                             |
| Preview               | **Preview** in the builder opens `/apps/<id>/preview`: the app full page, exactly as viewers see it, under a toolbar whose **X** returns to the builder on the same page.                                                                                                                                                |
| Save                  | Automatic. The header shows _Saving…_ / _Saved_; a save that conflicts with another open tab is refused with a reload prompt instead of overwriting.                                                                                                                                                                     |
| Share                 | **Share** → _Private_ (default) or _Anyone with the link_, then **Copy**. The URL is `/apps/<id>`; other pages add `?page=<page id>`.                                                                                                                                                                                    |
| Start from an example | **Apps** → **Examples**: seeded, read-only apps on locked sample datasets. Open one, then **Make a copy** to get your own editable copy.                                                                                                                                                                                 |
| Open a share link     | The published app, drawn **standalone**: no JSON Data Manager header, just the app's own bar (title, page tabs, theme, and a **⋯** menu with **Copy link**, **Make a copy** or, for the creator, **Share…** / **Edit app**, plus **Go to your apps**). Signed-out visitors are sent to sign-in and land back on the app. |

## Example apps

`app/convex/appBuilder/examples.ts` seeds two apps and the two sample datasets
they read (_Example: National Parks_, geospatial points, and _Example: Park
System Visits by Year_; the figures are approximate):

- **National Parks Explorer**: one contained page with headline numbers, a map, a
  donut, a line chart, and a table.
- **Park Visits Atlas**: a full-screen map page, then a contained dashboard page.

Seed them once per deployment:

```sh
cd app
bunx convex run appBuilder/examples:seed                     # no-op if they exist
bunx convex run appBuilder/examples:seed '{"replace": true}' # rebuild the apps, reuse the datasets
```

Examples are owned by the pseudo-user `system:examples` and marked
`example: true`. Every signed-in user can read them (they are listed on
`/apps`), and no one can edit them, because the write path matches the
caller against `createdBy`. Their datasets are published and set to `locked`
in json-cms. Users copy an example with **Make a copy** (`apps.duplicate`).

## Sharing and security model

- Apps sit behind the app-wide sign-in gate like everything else (closed
  sign-up, ADR 0009). "Anyone with the link" means any signed-in user who has
  the URL; it is **not** anonymous public access.
- Only the creator edits an app. Everyone else gets `null` from
  `apps.get` for a private app, the same answer as for a missing one, so an
  app id never leaks whether it exists.
- **An app stores dataset references, never data or access grants.** Every
  widget reads through the normal dataset APIs as the _viewer_, so sharing an
  app never widens who can see a dataset. A dataset the viewer can't open (a
  draft, `publishedVisibility: "author"`, or deleted) shows as "isn't
  available" in its widgets; the builder warns the author about
  author-only datasets.
- `saveContent` refuses to add a dataset id the creator can't see (the
  stage-8 rule: an invisible id is never written into shareable state), and
  refuses widgets that reference datasets outside the app's list.

## Architecture

The feature is one self-contained module on each side, plus a handful of
one-line integration points. Nothing else in the codebase imports it.

```
app/convex/appBuilder/          backend: api.appBuilder.apps.*
  validators.ts                 every stored shape (app, pages, widgets) + limits; shared with the client
  tables.ts                     the `apps` table, spread into convex/schema.ts
  apps.ts                       list · listExamples · get · create · updateDetails · saveContent · duplicate · remove
  examples.ts, exampleData.ts   internal `seed` mutation: sample datasets + example apps
  apps.test.ts                  access model + content rules (convex-test)
app/src/features/app-builder/   frontend
  lib/                          pure, tested: layout.ts (grid model), pages.ts (page list ops), aggregate.ts, fields.ts
  data.tsx                      the ONLY data access: dataset docs (context) + live entry rows
  use-app-editor.ts             working copy + debounced autosave with optimistic revisions
  widgets/                      registry.tsx + one module per widget kind (View + Settings)
  components/                   canvas (view + edit), page tabs, builder panel, share + details dialogs
  pages/                        apps list, viewer, builder
app/src/routes/apps/            thin route shells: /apps, /apps/$appId, /apps/$appId/preview, /apps/$appId/edit
```

Key choices (the reasoning is in ADR 0011):

- **One document per app.** Pages and their widgets are bounded inline arrays
  (≤ 12 pages, ≤ 40 widgets a page, ≤ 80 in total, all small config objects
  with no row data), so a layout save is one atomic write and the viewer is one
  subscription. `revision` provides optimistic concurrency. Apps saved before
  pages existed carry a top-level `widgets` array instead; `appPages()` reads
  that as one contained page, and the next save rewrites it as `pages`, so no
  migration is needed.
- **Layout is a page property.** `contained` and `fullscreen` share one grid
  model; full screen only changes the frame and lets rows stretch
  (`minmax(40px, 1fr)`), so widgets move between layouts unchanged.
- **Layout = order + span.** No free x/y positions: widgets flow through a
  CSS grid (`grid-auto-flow: dense`) by list order with a column span (1–12)
  and a row height (1–12). Responsive by construction, trivial to store, and
  the same `AppCanvas` renders both the builder and the viewer, so the author
  sees exactly what viewers get.
- **Widget registry.** A widget kind is a Convex validator plus a module that
  exports a `View` and a `Settings` component; `widgets/registry.tsx` wires
  them up. Map (MapLibre) and Chart (Recharts) are lazy-loaded, so an app
  without them never downloads them, and the rest of the product never does.
- **Reuse, not forks.** The map widget renders through the existing
  `LayersMap` and the row/tile geometry paths (`useGeometriesBySchemas`,
  `useTileArchiveSources`); tables use the vendored niko-table kit and
  `useDatasetEntryPages`; charts and numbers aggregate the live entry rows
  from the seam's `useAllPaginated`. So an app updates in real time as its
  data changes.
- Charts follow the dataviz method: the validated categorical palette
  (light and dark steps), one color for single-series charts, a donut capped
  at 7 named slices with a neutral _Other_, hover tooltips, and a
  one-click data-table view of every chart.

### UI components (shadcn base-ui registry)

The module builds its UI from the project's shadcn kit (`@caden/ui`, `packages/ui/src/components`, style
`base-mira` on Base UI) rather than custom markup, so restyling or upgrading the kit
restyles the builder too:

| Need                                    | Component                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Widget frames, app cards                | `Card` (+ `CardHeader`/`CardTitle`/`CardAction`/`CardContent`/`CardFooter`)                 |
| Charts                                  | `Chart` (`ChartContainer`, `ChartTooltip`, `ChartLegend`, themed `ChartConfig`)             |
| Chart data view                         | `Table`                                                                                     |
| Settings forms                          | `Field`, `FieldGroup`, `FieldSet`, `FieldLegend`, `Select`, `Checkbox`, `Input`, `Textarea` |
| Width presets / height stepper          | `ToggleGroup`, `ButtonGroup`                                                                |
| Sharing choice and link                 | `RadioGroup` (Field choice cards), `InputGroup`                                             |
| Widget palette, data sources            | `Item`, `ItemGroup`                                                                         |
| Empty / loading / notices               | `Empty`, `Spinner`, `Skeleton`, `Alert`, `Badge`                                            |
| Confirmations, menus, navigation, hints | `AlertDialog`, `Dialog`, `DropdownMenu`, `Breadcrumb`, `Tabs`, `Tooltip`, `Sheet`           |

`alert-dialog`, `button-group`, `chart`, `field`, `item`, `radio-group`, `spinner`,
`toggle` and `toggle-group` were added to the kit for this feature. They are general
components and stay if the builder is removed. One local adaptation: `Spinner` omits
the SVG `strokeWidth` prop, because `HugeiconsIcon` takes a number. The remaining custom
pieces are app-specific: the grid canvas and its drag/resize handles (dnd-kit), the map
(`LayersMap`), and the data table (the vendored niko-table).

### Integration points outside the module

| File                                                    | Change                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `app/convex/schema.ts`                                  | `...appBuilderTables` (one line + import).                                                                      |
| `app/src/components/header.tsx`                         | The **Apps** nav link, and it renders nothing on routes with `staticData: { hideHeader: true }`.                |
| `app/src/router.tsx`                                    | Declares the `hideHeader` route static-data flag. General-purpose; the viewer and preview routes set it.        |
| `app/src/components/layers-map.tsx`                     | `datasets` prop narrowed to the three fields it reads (`_id`, `title`, `boundingBox`), so any schema row works. |
| `app/src/components/auth-gate.tsx`, `routes/signin.tsx` | Return-to-URL after sign-in (`/signin?redirect=…`, in-app paths only). General-purpose; share links rely on it. |
| `app/package.json`                                      | `recharts`.                                                                                                     |

## Removing the app builder

1. Delete `app/convex/appBuilder/`, `app/src/features/app-builder/`, and
   `app/src/routes/apps/`.
2. Remove the `appBuilderTables` import and spread from `app/convex/schema.ts`
   and the **Apps** link from `header.tsx`.
   The example apps and sample datasets go with them; delete the two
   _Example: …_ datasets from the catalog if they were seeded.
3. `bun remove recharts` in `app/` (nothing else uses it).
4. Regenerate: `bunx convex codegen` and let the router plugin regenerate
   `routeTree.gen.ts` (run `vite dev` or `vite build`).
5. Deploy. Convex drops the now-undeclared `apps` table's schema; delete its
   documents from the dashboard if you want the data gone too.

The `LayersMap` prop narrowing, the sign-in redirect and the `hideHeader` route
flag are improvements that stand on their own; leave them.

## Limits and known gaps

- Charts and numbers aggregate in the browser over **every row** of the
  dataset. That's fine for thousands of rows; for very large datasets, an
  aggregate query (or the DuckDB analysis worker) would be the next step.
- Derived (virtual) datasets can't be added yet; publish them first.
- No anonymous/public sharing: the whole app sits behind sign-in by design.
  A public mode would need a deliberate read path that bypasses the dataset
  auth choke point, and its own ADR.
- Single-author editing; there are no co-editors. Viewers make copies.
- Not yet: filters shared across widgets (or pages), per-layer map styling, an embed
  mode without the app header.
