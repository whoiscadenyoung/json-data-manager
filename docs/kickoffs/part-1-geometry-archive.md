# Kickoff — Part 1: `@caden/geometry-archive` library (issue #59)

Part 1 of 5 implementing #58. Pure library + tests; **no behavior change to the
app ships with this part**. It goes first because writing PMTiles in-repo (the
reference `pmtiles` npm package is read-only) is the one genuinely risky piece.

## Read first
1. `docs/memory/MEMORY.md` (project memory index)
2. `docs/memory/geometry-tile-breakdown.md` (sequence + decisions; you are #59)
3. Issue **#59** — your task, full design + acceptance criteria
4. Skim: issue #58 (parent), `docs/gis-geometry-transport-survey.md`

## Task
New bun workspace package `packages/geometry-archive` (`@caden/geometry-archive`),
modeled on `packages/data-export` (name, `exports`, dist build, scripts):

```ts
const archiveBytes = await buildGeometryArchive({
  features,              // GeoJSON.Feature[] (full-res)
  minZoom: 0,
  maxZoom: 14,           // GEOMETRY_ARCHIVE_MAX_ZOOM
  includeProperties: [], // default [] — id-only projection
});
```

Pipeline: [geojson-vt](https://github.com/mapbox/geojson-vt) (per-zoom tile
index, pure JS) → [vt-pbf](https://github.com/mapbox/vt-pbf) (extent 4096,
buffer 64) → gzip (fflate or native CompressionStream) → PMTiles v3
serialization: 163-byte JSON header, Hilbert tile-id sort, dedup contiguous
identical tiles, root/leaf directories + EOS metadata JSON (zoom range,
`vector_layers`, compression, tileType MVT). Pure Uint8Array/DataView — no
Node APIs; it must run in a web worker later (part 3).

## Hard constraints
- `bun` only. Tests: `bun test`. Repo oxlint bans optional chaining.
- Do NOT touch `app/`, `packages/json-cms`, or any other existing package.
- No flat-container fallback code (recorded decision: commit to PMTiles v3).
- Tile features carry id-only properties (`entryId`) unless
  `includeProperties` is given; popups load on demand later (#52).

## Tests (bun test)
- **Roundtrip against the reference reader:** `pmtiles` (npm) as devDependency;
  read every archive back through its reader via an in-memory `Source`
  (same interface as `FetchSource`). Assert header zoom range/compression/
  tileType; sampled z/x/y tiles decode to expected MVT with id-only props;
  Hilbert ordering; dedup; gzip correctness.
- Tile-boundary fixture: features crossing tile boundaries appear in every
  intersecting tile (buffer handling).
- **Size benchmark:** dense ~450-feature fixture ≈ FY22 density → archive
  ≤10% of equivalent GeoJSON bytes. Record the ACTUAL ratio in the PR —
  part 4's byte targets calibrate on it.

## Done
- [ ] `bun test` green (roundtrip + boundaries + benchmark)
- [ ] PR open against `main`, merged, `git fetch --prune`, branch deleted
- [ ] Measured ratio + any API surprises appended to
      `docs/memory/geometry-tile-breakdown.md`
- [ ] STOP — part 2 (#60) is the next session's chunk
