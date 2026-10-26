# Layer styles

> Status: **implemented** (2026-10-26, #159 under the GIS basic-tier
> umbrella #158). Decision record:
> [ADR 0012](./decisions/0012-layer-styles-optional-module.md).

Optional cartography for saved maps: color a dataset by category or by
numeric classes, set outlines, sizes, labels and zoom ranges, and move
styles in and out as standard **MapLibre style-spec JSON**. Maps work
exactly as before if nobody opens it.

## What a user can do

| Step                  | How                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open the style editor | Map page → a dataset row in **Layers** (a dataset layer, or a dataset under a collection/group layer) → **⋯** → **Style…**. The panel docks above the layer list; the map stays visible and previews every change live.      |
| Single symbol         | **Symbology → Single**: one color, plus fill opacity.                                                                                                                                                                        |
| Categories            | **Symbology → Categories**: pick a field. Classes are generated from its most frequent values (up to 12, the rest go to **Other**), and each color is editable. It starts on a text field with a handful of repeated values. |
| Graduated             | **Symbology → Graduated**: pick a numeric field, the method (quantile or equal interval), the number of classes (3–7) and a color ramp. Features with no value show as **No data**.                                          |
| Outlines & sizes      | Collapsed section: polygon outline color and width, line width, point size.                                                                                                                                                  |
| Labels                | Collapsed section: label field, size, text and halo colors.                                                                                                                                                                  |
| Zoom range            | Collapsed section: show from / hide past zoom levels.                                                                                                                                                                        |
| Advanced              | Collapsed section: the style as MapLibre layers. **Copy**, **Download** (`<dataset>-style.json`), or paste MapLibre JSON (one layer, an array, or a whole style.json) and **Apply JSON**. Validation errors are listed.      |
| Reset                 | **Reset to default** in the panel, or **⋯ → Reset style**: the dataset draws in the map's assigned color again.                                                                                                              |
| Legend                | Styled datasets with classes list their classes in the map legend; others keep their single swatch. A single-symbol color also shows on the layer row's dot.                                                                 |

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
geometry-type filter: polygon fill, polygon outline, line, point circle, and
(optional) a symbol label layer. Category colors are a `match` on
`["to-string", ["get", field]]`. Graduated colors are a `step` on
`["to-number", ["get", field], 0]`, wrapped in a no-data `case`.

**Using an exported style elsewhere:** each exported layer has an `id` and
`"source": "dataset"`. Add your data as a source named `dataset`, or rename the
source, and the layers draw as they do here. Label layers use the
CARTO/OpenMapTiles font stack (`Montserrat Regular`, …), so swap `text-font`
if your glyph server differs.

## Architecture

```
app/convex/layerStyles/            backend: api.layerStyles.styles.*
  validators.ts                    the style document + limits (shared with the client)
  tables.ts                        the `layerStyles` table, spread into convex/schema.ts
  styles.ts                        listForMap · set · reset (auth, map existence, visibility rule, structural checks)
  styles.test.ts
app/src/features/layer-styles/     frontend
  use-layer-styles.tsx             the one integration hook the map page calls
  components/styled-layer.tsx      draws one dataset from its style (row or tile source)
  components/style-panel.tsx       the docked editor (+ controls.tsx, advanced-section.tsx)
  components/style-menu.tsx        the `⋯` menu on dataset rows
  lib/compile.ts                   editor settings → MapLibre fragments
  lib/expressions.ts               fields a style reads; tile-path feature-state rewrite
  lib/classify.ts, renderers.ts    distinct values, equal-interval/quantile breaks, default field
  lib/palettes.ts, legend.ts       category palette + ramps; legend classes
  lib/exchange.ts                  MapLibre validation, import, export
```

**Core extension slots** (core imports nothing from the module):

- `LayersMap` `extension?: LayersMapExtension`. `renderLayer(args)` returns
  a node that draws the dataset (`args.source` is the row features or the
  tile URL), or `undefined` to keep the default. `legendFor(renderId)` returns
  legend classes.
- `MapLayerPanel` `datasetActions?: DatasetActionsSlot`, a control beside each
  dataset row's eye.

**Render paths.** Row-path datasets get the style's field values merged into
feature properties. Tile-path datasets (large, with a PMTiles archive) carry
only `entryId`. Their field values are written as feature-state, and paint
expressions are rewritten from `get` to `feature-state`. MapLibre doesn't
allow feature-state in `layout` or `filter`, so labels and attribute filters
are dropped on tiles (the panel explains this). Only datasets whose style
reads fields load entry rows, plus the dataset open in the editor, which needs
its fields and values.

**Access.** Any signed-in user can read and write styles on any map, like the
maps themselves (ADR 0009). `set` refuses unknown maps and render ids the
writer can't see (stage 8). Rows for removed maps or datasets are inert.

## Removing layer styles

1. Delete `app/convex/layerStyles/` and `app/src/features/layer-styles/`.
2. In `app/convex/schema.ts`, remove the `layerStyleTables` import and its
   spread.
3. In `app/src/routes/maps/$mapId.tsx`, remove the `useLayerStyles` import and
   call, and use `colorBySchema` where `styledColorBySchema` was. Then drop
   `extension`, `datasetActions`, `layerStyles.panel` and
   `layerStyles.loaders`.
4. Optionally remove `@maplibre/maplibre-gl-style-spec` from
   `app/package.json`. Nothing else uses it.
5. Regenerate Convex code (`bunx convex dev --once`). The `layerStyles` table's
   rows go away with the schema.

The `LayersMap`/`MapLayerPanel` slots can stay; they're inert without a
module.
