# 12. Layer styles: an optional module storing MapLibre style-spec JSON

- Status: accepted
- Date: 2026-10-26

## Context

Saved maps drew every dataset in one auto-assigned color with a fixed 20%
fill (`assignDatasetColors`, `layers-map.tsx`). There was no styling by
category or value ranges, no labels, and no zoom ranges, which is the first
gap in the GIS basic-tier review (#158, #159).

The product owner set two constraints:

- Managing data, datasets and map views must never require touching style
  options. Styling must feel like an optional extension, reached from a
  collapsed menu or sidebar section.
- Styles should be transferable to other tools, as GeoLibre does by using
  MapLibre GL styles.

The design is in [`../layer-styles.md`](../layer-styles.md).

## Decision

- **A removable feature module, the ADR 0011 pattern.** The backend lives in
  `app/convex/layerStyles/` (`api.layerStyles.styles.*`, its own
  `layerStyles` table spread into the schema with one line). The frontend
  lives in `app/src/features/layer-styles/`, with one integration hook
  (`useLayerStyles`).
- **Core exposes extension slots and never imports the module.**
  - `LayersMap` takes an optional `extension` (`renderLayer` draws a dataset
    instead of the default renderer, or answers `undefined`; `legendFor`
    adds legend classes).
  - `MapLayerPanel` takes an optional `datasetActions` slot (a control beside
    a dataset row's eye).
  - Only the map page wires the module. Without it, or with no saved style,
    maps render exactly as before.
- **The only entry point is a `⋯` menu → Style…** on dataset rows. It opens a
  panel docked in the map's sidebar above the layer list, not a modal, so the
  live preview stays visible. Only Symbology is expanded; Outlines & sizes,
  Labels, Zoom range and Advanced are collapsed.
- **The stored format is MapLibre style-spec JSON.** A style is
  `{ version: 1, layers, editor? }`.
  - `layers` are MapLibre layer fragments (`type`
    fill/line/circle/symbol, `paint`, `layout`, `filter`, `minzoom`,
    `maxzoom`). They carry their own geometry-type filters but no
    `id`/`source` wiring, which the renderer supplies per map.
  - `editor` optionally keeps the simple editor's settings (single /
    categories / graduated, plus outline, label and zoom options), so the
    panel can reopen them. `layers` are always compiled from it.
  - A style imported or hand-edited as JSON has no `editor` and is shown as a
    "Custom MapLibre style".
  - Export and import use plain MapLibre layers (one layer, an array, or a
    whole style.json), validated with `@maplibre/maplibre-gl-style-spec`.
- **Scope is `(mapId, renderId)`.** The same dataset can look different on two
  maps, and each dataset under a collection or group layer is styled
  separately. A row whose map or dataset is gone is inert (the stale
  override-key rule), not cascaded.
- **Access follows maps (ADR 0009).** Any signed-in user can style any map,
  because maps are shared catalog organization. The render id must be visible
  to the writer: a dataset they can see, or a saved derived dataset (their own
  autosave too). That is the stage-8 rule: an invisible id never enters shared
  state.
- **Data-driven values are loaded on demand.** Only datasets whose style reads
  a field (`["get", field]`) load entry rows, through the row seam
  (`useEntryRowsBySchemas`).
  - Row path: the values are merged into the GeoJSON features.
  - Tile path: features carry only `entryId`, so values are written as
    MapLibre feature-state, and paint `get`s are rewritten to
    `feature-state`.
- **Edits preview immediately and save debounced (400 ms).** Last write wins
  per `(map, dataset)`; there is no revision counter.

## Consequences

- Exported styles drop into any MapLibre app once `source` is pointed at the
  data. Our own renderer re-validates nothing beyond MapLibre's `addLayer`: a
  fragment MapLibre rejects is skipped and the rest still draws.
- **Tile-path limitation:** MapLibre allows feature-state only in `paint`.
  Labels and attribute filters therefore can't render for datasets drawn from
  a tile archive; the panel says so, and the layers still export.
  Follow-up: write style fields into the archive (`includeProperties`).
- Styled datasets use a MapLibre layer per fragment and lose the default
  renderer's hover highlight. Point clustering stays a default-renderer
  feature.
- Field values for a styled dataset are fetched as full entry rows. This is
  fine at catalog sizes today; a field-projection read is the scale fix if
  needed.
- App-builder map widgets don't use saved styles yet (#165).
