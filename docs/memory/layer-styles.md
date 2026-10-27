---
name: layer-styles
description: 2026-10-26 GIS basic-tier train (#158, #159–#166) and the layer-styles module (#159) — optional, MapLibre style-spec JSON, extension slots in LayersMap/MapLayerPanel; tile-path feature-state limits; sandbox verification recipe; 2026-10-27 #168 point markers (SDF sprite, uploads) + gotchas
metadata:
  type: project
---

**GIS basic-tier train (2026-10-26):** a gap review against GeoLibre, RustGIS
(opengeos, v0.3 Oct 2026), ArcGIS Online and QGIS was filed as umbrella #158.
The ordered children are #159 styling, #160 formats + CRS, #161 spatial SQL,
#162 filter/selection, #163 draw/edit, #164 basemaps/external layers, and
#165 app-builder cross-filter + public sharing. #166 is the tier-2/3
backlog. The user's standing rule for this train: **base workflows stay
style-free**. Every GIS capability is an optional, removable module (ADR 0011
pattern) reached from collapsed entry points. Prefer interoperable formats
(MapLibre style spec, OGC/GDAL formats, ST_ SQL).

**#159 shipped as the layer-styles module** (docs/layer-styles.md, ADR 0012):

- `app/convex/layerStyles/` + `app/src/features/layer-styles/`.
- Core gained two **extension slots** that import nothing: `LayersMap`
  `extension` (renderLayer/legendFor) and `MapLayerPanel` `datasetActions`.
  Only `routes/maps/$mapId.tsx` wires `useLayerStyles`.
- Styles are stored as MapLibre layer fragments plus optional `editor`
  settings, per `(mapId, renderId)`.
- Edits preview instantly and save with a 400 ms debounce.
- The editor is a **docked sidebar card, not a Sheet**: the Sheet's
  `bg-black/80` backdrop hid the live map preview, so it was moved during
  browser verification.

Gotchas:

- Geometry rows and tile features carry only `{entryId, schemaId}`, never
  entry data. Data-driven styles need entry rows loaded separately
  (`useEntryRowsBySchemas`). Tiles get the values as feature-state, which
  MapLibre allows in paint only, so labels and data filters are dropped on the
  tile path.
- Categories `match` on `to-string` (labels must be unique strings; booleans
  can't be match labels).
- Use `["in", ["geometry-type"], ["literal", [...]]]` to cover Multi*
  geometries.
- `validateStyleMin` needs a `glyphs` URL for symbol layers to validate.
- Default category field = first text field with 2–12 distinct, repeated
  values. Alphabetical-first picked `area_acres` and made every park its own
  class.
- `api.d.ts` can be hand-edited when no deployment exists (codegen is
  alphabetical and deterministic; verified identical later).

**#168 point markers — MERGED 2026-10-27 (PR #170), ADR 0013.** Follow-ups
in #169 (tile-path per-category icons/class sizes: per-icon layers chosen by
feature-state `icon-opacity` first, styled fields in the tile archive later;
missing-image resolver; deleted-upload policy; sprite weight; the `convex dev`
typecheck). Comparison done the same day: GeoLibre keeps every property in
client-cut geojson-vt tiles and bakes colored canvas markers (no SDF, no
feature-state); RustGIS has its own renderer that computes a symbol per row.
**Next in the train: #160**, split as proposed in a comment on that issue
(#160a = Shapefile/KML/GPX/CSV-WKT + proj4js and an EPSG prompt; #160b =
GPKG/FlatGeobuf/GeoParquet and exports through DuckDB spatial, landing with the
first step of #161).

Details: shapes / curated Lucide /
all of Maki ship as one committed SDF sprite in
`app/public/sprites/layer-styles/` (built by hand with
`bun src/features/layer-styles/sprite/build.ts`: resvg + our own EDT in
`lib/sdf.ts`); markers compile to a `symbol` layer, icons namespaced
`shape-|lucide-|maki-|user-<id>`; uploads = `layerStyleIcons` table + Convex
storage, browser-rasterized PNG only. Gotchas:

- `ImageBitmap.close()` zeroes `width`/`height` — read them first (the
  sprite silently failed to decode until this was fixed).
- A thrown `ConvexError` rolls back `ctx.storage.delete` too; `icons.create`
  deletes a refused upload and _returns_ `{ ok: false, error }`.
- convex-test's `storage.store` records no `contentType`; tests patch the
  `_storage` row (`icons.test.ts` `storeFile`).
- `map.setSprite`/`addSprite` namespace names (`id:name`), which breaks
  exported JSON — register only used images with `map.addImage` before
  `addLayer`.
- pngjs encodes much worse than PIL; the 2x SDF sheet is ~740 KB (grey+alpha,
  deflate 9). Lazy-loaded; only HiDPI fetches it.
- MapLibre 6's dist is ESM-only (`maplibre-gl.mjs`) — the plain-MapLibre
  interop fixture (`fixtures/plain-maplibre.html` + `prepare-fixture.ts`)
  imports it as a module.
- PRE-EXISTING (not fixed): `convex dev`'s own typecheck fails on main
  because `convex/layerStyles/*.test.ts` import `src/` files that use the
  `#convex/*` alias and `Object.hasOwn` (convex/tsconfig has neither). Start
  the dev backend with `--typecheck=disable`; CI's app `tsc` is unaffected.

**Sandbox verification recipe (worked 2026-10-26):**

1. From `app/`, run `CONVEX_AGENT_MODE=anonymous bunx convex dev` (backend on
   :3210).
2. Set `convex env set SITE_URL http://localhost:3000` and set
   `BETTER_AUTH_SECRET`.
3. Run `convex run auth:createAccount` and `convex run appBuilder/examples:seed`.
   This gives "Example: National Parks", whose points have region,
   visitors_millions and area_acres.
4. Start the app with `bunx vite dev --port 3000`.
5. Drive it with global Playwright: `NODE_PATH=/opt/node22/lib/node_modules`,
   SwiftShader args, and an init script that disables `backdrop-filter`, or
   screenshots of open dialogs time out.

CARTO basemaps and glyphs are blocked by the sandbox proxy. On 2026-10-27
the map did NOT fire `load` at all (nothing drew) until Playwright
`context.route(/cartocdn\.com/)` stubbed `tiles.json` (TileJSON with a stub
tile URL), `sprite*.json` (`{}`), `sprite*.png` (1×1 PNG) and everything else
(204). Labels still can't be checked visually. Public functions run from the
CLI with `bunx convex run --identity '{"subject":"<authId>"}' maps:create …`
(the authId `auth:createAccount` returns) — handy for creating a map and
adding a layer without driving the UI. The tile path and
polygon/line rendering were unit-tested only.
