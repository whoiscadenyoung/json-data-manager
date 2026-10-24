# App builder

> Status: **implemented** (2026-10-24). Decision record:
> [ADR 0011](./decisions/0011-app-builder-feature-module.md). Walkthrough
> video: [`demo/app-builder-walkthrough.mp4`](./demo/app-builder-walkthrough.mp4);
> screenshots: [`demo/app-builder/`](./demo/app-builder/).

A simple experience builder (think ArcGIS Experience Builder, much smaller):
signed-in users compose an **app**, a single page of widgets that read from
catalog datasets, lay it out on a grid, and share it by URL.

## What a user can do

| Step              | How                                                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create an app     | **Apps** in the header → **New app** (title required, description optional) → the builder opens.                                                                                                                                                                                                           |
| Add datasets      | Builder → **Data** tab → **Add dataset** (any catalog dataset you can see, up to 20). Removing a dataset removes the widgets that use it (maps just lose the layer), after a confirmation.                                                                                                                 |
| Add widgets       | **Add** tab: **Map** (geospatial datasets as colored layers, click a feature for its properties), **Chart** (bar / line / area / donut over a grouped field), **Table** (searchable, sortable rows, choose columns), **Number** (count / sum / avg / min / max), **Text** (headings, bullets, paragraphs). |
| Configure         | Click a widget → **Widget** tab: title, dataset, fields, measure, chart type, order, columns, size.                                                                                                                                                                                                        |
| Lay out           | Drag a widget's grip to reorder; drag its corner to resize (snaps to the 12-column grid and 64px rows), or use the width presets (¼ … Full) and height buttons. Widgets flow left-to-right, top-to-bottom; on phones every widget stacks full-width.                                                       |
| Save              | Automatic. The header shows _Saving…_ / _Saved_; a save that conflicts with another open tab is refused with a reload prompt instead of overwriting.                                                                                                                                                       |
| Share             | **Share** → _Private_ (default) or _Anyone with the link_, then **Copy**. The URL is `/apps/<id>`.                                                                                                                                                                                                         |
| Open a share link | The read-only viewer. Signed-out visitors are sent to sign-in and land back on the app. Viewers can **Copy link** or **Make a copy** (a private, editable copy of their own).                                                                                                                              |

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
  validators.ts                 every stored shape (app, widgets) + limits; shared with the client
  tables.ts                     the `apps` table, spread into convex/schema.ts
  apps.ts                       list · get · create · updateDetails · saveContent · duplicate · remove
  apps.test.ts                  access model + content rules (convex-test)
app/src/features/app-builder/   frontend
  lib/                          pure, tested: layout.ts (grid model), aggregate.ts (chart/stat math), fields.ts
  data.tsx                      the ONLY data access: dataset docs (context) + live entry rows
  use-app-editor.ts             working copy + debounced autosave with optimistic revisions
  widgets/                      registry.tsx + one module per widget kind (View + Settings)
  components/                   canvas (view + edit), builder panel, share + details dialogs
  pages/                        apps list, viewer, builder
app/src/routes/apps/            thin route shells: /apps, /apps/$appId, /apps/$appId/edit
```

Key choices (the reasoning is in ADR 0011):

- **One document per app.** Widgets are a bounded inline array (≤ 40 small
  config objects, no row data), so a layout save is one atomic write and the
  viewer is one subscription. `revision` provides optimistic concurrency.
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

The module builds its UI from the project's shadcn kit (`app/src/components/ui`, style
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
| `app/src/components/header.tsx`                         | The **Apps** nav link.                                                                                          |
| `app/src/components/layers-map.tsx`                     | `datasets` prop narrowed to the three fields it reads (`_id`, `title`, `boundingBox`), so any schema row works. |
| `app/src/components/auth-gate.tsx`, `routes/signin.tsx` | Return-to-URL after sign-in (`/signin?redirect=…`, in-app paths only). General-purpose; share links rely on it. |
| `app/package.json`                                      | `recharts`.                                                                                                     |

## Removing the app builder

1. Delete `app/convex/appBuilder/`, `app/src/features/app-builder/`, and
   `app/src/routes/apps/`.
2. Remove the `appBuilderTables` import and spread from `app/convex/schema.ts`
   and the **Apps** link from `header.tsx`.
3. `bun remove recharts` in `app/` (nothing else uses it).
4. Regenerate: `bunx convex codegen` and let the router plugin regenerate
   `routeTree.gen.ts` (run `vite dev` or `vite build`).
5. Deploy. Convex drops the now-undeclared `apps` table's schema; delete its
   documents from the dashboard if you want the data gone too.

The `LayersMap` prop narrowing and the sign-in redirect are improvements
that stand on their own; leave them.

## Limits and known gaps

- Charts and numbers aggregate in the browser over **every row** of the
  dataset. That's fine for thousands of rows; for very large datasets, an
  aggregate query (or the DuckDB analysis worker) would be the next step.
- Derived (virtual) datasets can't be added yet; publish them first.
- No anonymous/public sharing: the whole app sits behind sign-in by design.
  A public mode would need a deliberate read path that bypasses the dataset
  auth choke point, and its own ADR.
- Single-author editing; there are no co-editors. Viewers make copies.
- Not yet: filters shared across widgets, per-layer map styling, an embed
  mode without the app header.
