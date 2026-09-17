# @caden/geometry-archive

Builds a **PMTiles v3** vector-tile archive (gzip-compressed MVT) from
GeoJSON features in pure JavaScript — no Node APIs, safe for browsers, web
workers, and Node. Pure library: features in, one `Uint8Array` archive out.

```ts
import { buildGeometryArchive } from "@caden/geometry-archive";

const archiveBytes = await buildGeometryArchive({
  features,              // GeoJSON.Feature[] (full-res, from the row path)
  minZoom: 0,            // default 0
  maxZoom: 14,           // default 14 — GEOMETRY_ARCHIVE_MAX_ZOOM
  includeProperties: [], // default [] — id-only projection
});
```

## How it works

Pipeline: [geojson-vt](https://github.com/mapbox/geojson-vt) (per-zoom tile
index) → [vt-pbf](https://github.com/mapbox/vt-pbf) (extent 4096, buffer 64,
MVT version 2) → gzip per tile (fflate) → PMTiles v3 container written
in-repo (the reference `pmtiles` npm package is read-only).

- **Property projection:** tile features carry only `entryId` (resolved from
  the feature's `_id`, falling back to `properties.entryId` then
  `properties._id`). `includeProperties` extends it with an allow-list of
  extra keys; popups/attributes stay on-demand via entry queries (#52).
- **Container:** 127-byte header, gzip'd root/leaf directories + JSON
  metadata, Hilbert tile-id ordering, run-length dedup of Hilbert-adjacent
  identical tiles plus global blob dedup, gzip tile compression.
- **Layer name:** the single source layer in every tile is `geojson`.
- **GeometryCollections** are flattened so each member is tiled under the
  same entry id. Features without finite coordinates are skipped.

## Scope note

Datasets are expected to be regionally bounded (like the app's imports);
a single world-spanning feature makes the per-feature tile enumeration
explode, matching geojson-vt's own practical limits.

## Development

```sh
bun test        # 16 tests incl. reference-reader roundtrip + leaf split
bun run build   # dist/ via tsc
```

Tests roundtrip every archive through the reference `pmtiles` reader
(in-memory `Source`) and decode MVT with `@mapbox/vector-tile` + `pbf`.
The size benchmark (FY22-shaped 450-feature fixture) measures the archive
against the equivalent GeoJSON text; see
`docs/memory/geometry-tile-breakdown.md` for the measured ratio.
