# 13. Point markers: shapes and icons as a MapLibre SDF sprite, plus uploads

- Status: accepted
- Date: 2026-10-27
- Extends: [ADR 0012](./0012-layer-styles-optional-module.md)

## Context

After #159 every styled point still drew as a MapLibre `circle`. There were
no marker shapes, no icons and no way to use your own symbols. The Advanced
JSON accepted a `symbol` layer with `icon-image`, but the map never loaded
any images, so it drew nothing (#168, part 1b of the GIS basic tier #158).

The constraints carry over from ADR 0012: styling stays an optional,
removable module; the stored format stays plain MapLibre style JSON; and
exports must work in other MapLibre tools.

## Decision

- **Same module, same entry point.** Everything lives in
  `app/src/features/layer-styles/` and `app/convex/layerStyles/`. Core
  gained only two optional legend hooks (`LayersMapLegendClass.marker`,
  `LayersMapExtension.legendSwatchFor`) and still imports nothing from the
  module. The Symbology section gets a **Marker** picker (Circle · Shape ·
  Icon), shown only for datasets that may have points (geometry type
  unknown, mixed or point). Size, rotation, overlap and class sizes sit in a
  collapsed **Marker options** section.
- **Three tiers.**
  1. Shapes: circle (still the `circle` layer), square, triangle, diamond,
     star, cross and pin.
  2. Icons: a curated Lucide set (the app's icon library, ISC; the default
     family) plus all of Maki (Mapbox's CC0 POI icons, the OpenMapTiles
     vocabulary).
  3. Uploads: users' own SVG/PNG icons.
- **Built-in icons ship as a standard MapLibre sprite.** `sprite.json` +
  `sprite.png` and `@2x` live in `app/public/sprites/layer-styles/`, plus a
  `catalog.json` for the picker's search. The sprite is served from our own
  origin, so there's no icon CDN.
  - Every image is an **SDF** (`"sdf": true`), so `icon-color` and
    `icon-halo-*` tint it. Category and graduated colors work on icons
    exactly as on circles.
  - A bun script (`sprite/build.ts`) builds the sprite with resvg and our own
    distance transform (`lib/sdf.ts`, the tiny-sdf algorithm, matching
    MapLibre's SDF encoding). It is run by hand and its output is committed,
    so neither CI nor the app build needs a native rasterizer.
  - The app loads the sprite lazily (the first style or picker that needs an
    icon) and registers only the images a layer uses, with `map.addImage`,
    before adding that layer. MapLibre's own `setSprite`/`addSprite` would
    prefix names (`id:name`) and break exported JSON.
- **The stored format stays plain MapLibre JSON.** A shape or icon marker
  compiles to a `symbol` layer: `icon-image` (one name, or a `match` on the
  category field for per-category icons), `icon-size`, `icon-color` (the
  existing color expression), `icon-rotate` and `icon-allow-overlap`.
  - Icon names are namespaced: `shape-triangle`, `lucide-school`,
    `maki-hospital`, `user-<id>`. The backend accepts only these forms in the
    editor settings.
  - The editor remembers its choices in `editor.marker` (kind, icon, size,
    rotation, overlap, optional graduated `sizeScale`) and
    `categories[i].icon`.
- **Exports carry their icons.** Advanced → **Download sprite** zips a
  sprite (1x and 2x) holding only the icons the style uses, uploads
  included, with the layers JSON and a README. Applying pasted JSON that
  names unknown icons fails with their names listed, instead of drawing
  blanks.
- **Uploads.**
  - Uploaded icons live in Convex file storage plus a `layerStyleIcons`
    table, scoped like styles: any signed-in user can upload, use and delete
    them (ADR 0009).
  - The browser rasterizes the file and stores only a small PNG (≤ 128 px,
    stored at 2x). An SVG is drawn through an `<img>` from a blob URL, which
    never runs scripts or fetches external resources, and its markup is
    never put in the DOM or stored. Limits: 256 KB per file, PNG input
    ≤ 128 px, 500 icons in total.
  - "Tintable" (on by default) stores an SDF so single-color glyphs take
    the style's colors. With it off, logos and photos render as-is.
  - `create` re-checks the stored file's type and size and the declared
    dimensions. A refused upload's file is deleted, and the refusal is
    _returned_ rather than thrown, because a throw would roll the deletion
    back.
  - A style naming a deleted upload draws those points as circles in the
    same colors, and the panel says so.

## Consequences

- The sprite is about 230 KB at 1x and 740 KB at 2x (SDF gradients compress
  poorly). It loads only when a style uses an icon or the picker opens, the
  browser caches it, and only HiDPI screens fetch the 2x sheet. Adding
  icons means editing `sprite/sources.ts` and rerunning the script.
- **Tile-path datasets:** `icon-image` and `icon-size` are layout
  properties, and MapLibre doesn't allow feature-state there. A single icon
  works on tiles, and colors still ride feature-state `icon-color`.
  Per-category icons fall back to the marker's own icon, and class sizes to
  the base size, until the category field is in the tile archive (the same
  `includeProperties` follow-up as labels and filters in #159). The panel
  says so.
  Options to close this gap (one symbol layer per icon chosen by
  feature-state opacity, or styled fields in the archive) are in #169 and in
  `docs/layer-styles.md` "Follow-ups".
- Uploads are shared and deletable by every signed-in collaborator, matching
  the rest of the catalog. A stricter owner-only rule would be a later
  policy change, not a format change.
- Out of scope: line and fill patterns, 3D/extruded symbols, animated
  markers.
