# Layer styles

> Status: **implemented** (2026-10-26, #159 under the GIS basic-tier
> umbrella #158; point markers 2026-10-27, #168). Decision records:
> [ADR 0012](./decisions/0012-layer-styles-optional-module.md),
> [ADR 0013](./decisions/0013-point-markers-sdf-sprite.md) (point markers).

Optional cartography for saved maps: color a dataset by category or by
numeric classes, set outlines, sizes, labels and zoom ranges, and move
styles in and out as standard **MapLibre style-spec JSON**. Maps work
exactly as before if nobody opens it.

## What a user can do

| Step                  | How                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open the style editor | Map page → a dataset row in **Layers** (a dataset layer, or a dataset under a collection/group layer) → **⋯** → **Style…**. The panel docks above the layer list; the map stays visible and previews every change live.                                                                         |
| Single symbol         | **Symbology → Single**: one color, plus fill opacity.                                                                                                                                                                                                                                           |
| Categories            | **Symbology → Categories**: pick a field. Classes are generated from its most frequent values (up to 12, the rest go to **Other**), and each color is editable. It starts on a text field with a handful of repeated values.                                                                    |
| Graduated             | **Symbology → Graduated**: pick a numeric field, the method (quantile or equal interval), the number of classes (3–7) and a color ramp. Features with no value show as **No data**.                                                                                                             |
| Point markers         | **Symbology → Marker** (datasets that may have points): **Circle**, **Shape** (circle, square, triangle, diamond, star, cross, pin) or **Icon** (searchable Lucide and Maki grids, plus your **Uploaded** icons). The style's colors tint shapes and icons.                                     |
| Per-category markers  | In **Categories** with a Shape or Icon marker, each class row has a marker button: pick a different shape or icon per class. Unset classes and **Other** use the marker's own icon.                                                                                                             |
| Marker options        | Collapsed section: icon size, rotation, "show every marker" (overlap), and for **Graduated** styles, **Grow markers by class** (the largest class up to ×4).                                                                                                                                    |
| Outlines & sizes      | Collapsed section: polygon outline color and width, line width, point size (circles).                                                                                                                                                                                                           |
| Labels                | Collapsed section: label field, size, text and halo colors.                                                                                                                                                                                                                                     |
| Zoom range            | Collapsed section: show from / hide past zoom levels.                                                                                                                                                                                                                                           |
| Advanced              | Collapsed section: the style as MapLibre layers. **Copy**, **Download** (`<dataset>-style.json`), **Download sprite** (when the style uses icons), or paste MapLibre JSON (one layer, an array, or a whole style.json) and **Apply JSON**. Validation errors and unknown icon names are listed. |
| Reset                 | **Reset to default** in the panel, or **⋯ → Reset style**: the dataset draws in the map's assigned color again.                                                                                                                                                                                 |
| Legend                | Styled datasets with classes list their classes in the map legend, each with its marker icon when points draw as shapes/icons; others keep their single swatch (or their single marker). A single-symbol color also shows on the layer row's dot.                                               |

Saving is automatic (debounced 400 ms). Styles are **per map**: the same
dataset can look different on another map, and the data is never changed.

## The style document

```ts
{
  version: 1,
  layers: StyleLayer[],   // MapLibre layer fragments: type, paint, layout, filter, minzoom, maxzoom
  editor?: StyleEditor,   // the simple editor's settings; absent for a custom (JSON) style
}
```

The simple editor compiles to up to five fragments, each with its own
geometry-type filter: polygon fill, polygon outline, line, points, and
(optional) a symbol label layer. Category colors are a `match` on
`["to-string", ["get", field]]`. Graduated colors are a `step` on
`["to-number", ["get", field], 0]`, wrapped in a no-data `case`.

## Point markers

Points draw as a `circle` layer unless `editor.marker` picks a shape or an
icon. Then the points fragment is a `symbol` layer:

```jsonc
{
  "type": "symbol",
  "filter": ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
  "layout": {
    "icon-image": "lucide-school", // or a `match` on the category field
    "icon-size": 0.75, // marker size / 24 (a `step` when classes grow)
    "icon-rotate": 45, // only when rotated
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
  },
  "paint": {
    "icon-color": "<the color expression>",
    "icon-halo-color": "#ffffff",
    "icon-halo-width": 1,
  },
}
```

- **Icon names** are namespaced: `shape-*` (the seven shapes), `lucide-*`
  (a curated Lucide set, the default family), `maki-*` (all of Maki) and
  `user-<id>` (uploads).
- **The sprite.** Built-in icons are a standard MapLibre sprite in
  `app/public/sprites/layer-styles/` (`sprite.json`/`.png`, `@2x`, plus
  `catalog.json` with each icon's family, label and search keywords). Every
  image is an SDF, so `icon-color` and `icon-halo-*` tint it. The map loads the
  sprite lazily and `addImage`s only the icons a layer uses before adding it.
  To add icons, edit `app/src/features/layer-styles/sprite/sources.ts` and run
  `bun src/features/layer-styles/sprite/build.ts` from `app/`; commit the
  output.
- **Tiles.** `icon-image` and `icon-size` are layout properties, which can't
  read feature-state. On tile-path datasets a single icon works and colors
  still apply; per-category icons fall back to the marker's icon, and class
  sizes to the base size, until the category field rides in the tile archive.

## Uploaded icons

**Marker → Icon → Uploaded → Upload** takes an SVG or PNG (256 KB at most;
PNGs up to 128 px). The browser rasterizes it to a PNG that fits the 24 px
glyph box at 2x (an SVG is drawn through an `<img>` from a blob URL, which
never runs scripts or fetches anything, and its markup is never put in the
page or stored). With **Tintable** on (the default), it's stored as an SDF
so the style's colors apply; turn it off for logos and full-color images.

Uploads are shared with every signed-in user, like the styles (ADR 0009),
and listed in every map's picker (up to 500). Anyone can delete one; styles
that used it draw those points as circles in the same colors, and the Style
panel says so.

**Using an exported style elsewhere:** each exported layer has an `id` and
`"source": "dataset"`. Add your data as a source named `dataset`, or rename the
source, and the layers draw as they do here. Label layers use the
CARTO/OpenMapTiles font stack (`Montserrat Regular`, …), so swap `text-font`
if your glyph server differs. A style with shape or icon markers also needs
its images: **Download sprite** zips the layers with a MapLibre sprite
holding exactly the icons they use (1x and 2x, uploads included). Unzip it
next to your style and set the style's `"sprite"` to that folder's URL plus
`/sprite`.

## Architecture

```
app/convex/layerStyles/            backend: api.layerStyles.styles.*
  validators.ts                    the style document + limits (shared with the client)
  tables.ts                        the `layerStyles` table, spread into convex/schema.ts
  styles.ts                        listForMap · set · reset (auth, map existence, visibility rule, structural checks)
  icons.ts                         uploaded marker icons: generateUploadUrl · create · list · remove
  styles.test.ts, icons.test.ts
app/src/features/layer-styles/     frontend
  use-layer-styles.tsx             the one integration hook the map page calls
  components/styled-layer.tsx      draws one dataset from its style (row or tile source)
  components/style-panel.tsx       the docked editor (+ controls.tsx, advanced-section.tsx)
  components/style-menu.tsx        the `⋯` menu on dataset rows
  components/marker-section.tsx    Marker picker, icon grid + uploads, Marker options, per-category icons
  components/marker-swatch.tsx     a tinted marker icon (legend, picker, class rows)
  lib/compile.ts                   editor settings → MapLibre fragments
  lib/expressions.ts               fields a style reads; tile-path feature-state rewrite
  lib/classify.ts, renderers.ts    distinct values, equal-interval/quantile breaks, default field
  lib/palettes.ts, legend.ts       category palette + ramps; legend classes
  lib/exchange.ts                  MapLibre validation, import (unknown icons listed), export
  lib/icons.ts                     icon names a style draws; deleted-upload fallback to circles
  lib/icon-images.ts               sprite/catalog/upload loading; map.addImage
  lib/sdf.ts                       signed distance fields (sprite build + tintable uploads)
  lib/uploads.ts                   upload checks + browser rasterizing
  lib/sprite-export.ts             "Download sprite" (packing + zip)
  sprite/sources.ts, build.ts      the built-in sprite's icon list and its bun build script
app/public/sprites/layer-styles/   the built sprite (committed)
```

**Core extension slots** (core imports nothing from the module):

- `LayersMap` `extension?: LayersMapExtension`. `renderLayer(args)` returns
  a node that draws the dataset (`args.source` is the row features or the
  tile URL), or `undefined` to keep the default. `legendFor(renderId)` returns
  legend classes.
- `MapLayerPanel` `datasetActions?: DatasetActionsSlot`, a control beside each
  dataset row's eye.
- Optional legend hooks: a `LayersMapLegendClass` may carry a `marker` node
  drawn instead of its color square, and `legendSwatchFor(renderId)` may
  replace an unclassed dataset's dot.

**Render paths.** Row-path datasets get the style's field values merged into
feature properties. Tile-path datasets (large, with a PMTiles archive) carry
only `entryId`. Their field values are written as feature-state, and paint
expressions are rewritten from `get` to `feature-state`. MapLibre doesn't
allow feature-state in `layout` or `filter`, so labels and attribute filters
are dropped on tiles (the panel explains this). Only datasets whose style
reads fields load entry rows, plus the dataset open in the editor, which needs
its fields and values.

**Access.** Any signed-in user can read and write styles on any map, like the
maps themselves (ADR 0009), and upload, use and delete marker icons. `set` refuses unknown maps and render ids the
writer can't see (stage 8). Rows for removed maps or datasets are inert.

## Follow-ups

Tracked in [#169](https://github.com/whoiscadenyoung/json-data-manager/issues/169).

**Data-driven markers on tile-path datasets.** Tile features carry only
`entryId`, so style values arrive as feature-state, which MapLibre allows in
paint only. `icon-image` and `icon-size` are layout properties, so on tiles
per-category icons fall back to the marker's icon and graduated class sizes
to the base size. Options, cheapest first:

1. **One symbol layer per icon (or size class), chosen by opacity.** At render
   time, the tile path splits the marker layer into one layer per distinct
   icon with a fixed `icon-image`, each showing only its own features through
   `"icon-opacity": ["match", ["feature-state", field], …, 1, 0]` (paint, so
   feature-state is allowed). Class sizes work the same way. The expanded
   layers ignore placement so invisible copies don't collide. Stored and
   exported JSON stay one layer. Recommended first step.
2. **Styled fields in the tile archive** (`includeProperties`, also the
   labels/filters follow-up from #159). `["get", field]` then works natively,
   for icons, sizes, labels and filters alike. Costs an archive rebuild when
   the styled fields change, plus bigger tiles. This is the long-term fix.
3. **Client-side tiling**, GeoLibre's approach: it cuts vector tiles in the
   browser with every property kept, and never styles through feature-state.
   It's a poor fit here, because our tile path exists for geometry too large
   to load.

For comparison, RustGIS draws with its own renderer and computes a symbol
per feature row, so the restriction doesn't apply to it. Its markers are five
shapes plus font glyphs.

**Hardening:**

- Register icons through MapLibre's missing-image resolver (GeoLibre's
  pattern) so they regenerate on their own after any `setStyle`.
- Deleted uploads: refuse deleting an icon a saved style uses, or soft-delete
  it, instead of the current fall back to circles.
- Sprite weight: about 740 KB at 2x. Try a better PNG encoder, or split the
  sprite per family.
- `convex dev`'s own typecheck is red on `main` (layer-style tests import
  `src/` code that uses the `#convex/*` alias).

## Removing layer styles

1. Delete `app/convex/layerStyles/`, `app/src/features/layer-styles/` and
   `app/public/sprites/layer-styles/`.
2. In `app/convex/schema.ts`, remove the `layerStyleTables` import and its
   spread.
3. In `app/src/routes/maps/$mapId.tsx`, remove the `useLayerStyles` import and
   call, and use `colorBySchema` where `styledColorBySchema` was. Then drop
   `extension`, `datasetActions`, `layerStyles.panel` and
   `layerStyles.loaders`.
4. Optionally remove the module's packages from `app/package.json`; nothing
   else uses them: `@maplibre/maplibre-gl-style-spec`, `fflate`, `potpack`,
   and the dev-only sprite tooling `lucide-static`, `@mapbox/maki`,
   `@resvg/resvg-js`, `pngjs`, `@types/pngjs`.
5. Regenerate Convex code (`bunx convex dev --once`). The `layerStyles` and
   `layerStyleIcons` tables' rows go away with the schema; uploaded icon
   files stay in file storage until deleted from the dashboard.

The `LayersMap`/`MapLayerPanel` slots can stay; they're inert without a
module.
