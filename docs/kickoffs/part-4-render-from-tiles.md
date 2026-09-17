# Kickoff — Part 4: render maps from tile archives (issue #62)

Part 4 of 5 implementing #58 — the visible payoff, measured on the FY22 Action
Plan dataset (450 features, 46.55 MB of GeoJSON text today). Read the
user-expectation memory entries BEFORE touching map UI; they encode hard-won
user feedback.

## Read first
1. `docs/memory/MEMORY.md`, then **`loading-indicator-ui-expectations.md`** and
   **`ui-polish-expectations.md`** — chips persist until completeness, maps are
   never unmounted/skeletoned mid-session, latch after first complete render
2. `geometry-tile-breakdown.md` (you are #62 — chip semantics + hot-swap rules)
3. Issue **#62** — full design + measured acceptance criteria

**Amend before handing off:** confirm parts 1–3 shipped (protocol name/exports
of `@caden/geometry-archive`, `useMapTileArchiveMeta` signature, manager API,
threshold constant) from package source + memory.

## Task

- **Protocol registration (once)** in `app/src/components/ui/map.tsx` init:
  `maplibregl.addProtocol("pmtiles", protocol.tile)` with the reference
  `pmtiles` npm `Protocol` (reader; roundtrip-tested against our writer in
  part 1).
- **Source selection helper** (e.g. `app/src/lib/layer-source.ts`): dataset
  above `MAP_TILE_ARCHIVE_MIN_BYTES` ∧ archive present → `{kind: "vector",
  url: "pmtiles://" + meta.url}`; otherwise → today's row path
  (`useGeometriesBySchemas` + loaders). The row path stays the fallback for
  above-threshold datasets whose archive isn't ready yet (first view before
  the rebuild lands) — hot-swaps to tiles when it arrives.
- **Wire consumers:** `layers-map.tsx` (+ `routes/maps/$mapId.tsx`),
  `routes/datasets/$schemaId/index.tsx` (`datasets-map.tsx`),
  `group-map.tsx` (+ `routes/groups/$groupId.tsx`). Collection extent maps
  stay bbox-only (#49 — no geometry loads).
- **map.tsx:** accept a vector-tile source alongside existing geojson sources;
  styling mirrors current fill/line/circle. Point datasets above threshold =
  circle layer from tiles; **clustering stays a below-threshold (row-path)
  feature**.
- **Hit-testing:** tiles carry id-only props — click/hover reports `entryId`;
  popup/inspect content loads on demand via entry queries (#52 direction).
- **Hot-swap on rebuild:** new version/url → remove + re-add source, re-apply
  layers. NEVER unmount the map, never re-skeleton (established philosophy).
- **Chip/completeness for the tile path:** completeness = archive meta loaded
  ∧ `meta.version` current ∧ map reached `idle` after source added. Do NOT
  gate on individual tile fetches; Exhausted gating stays ROW-PATH-ONLY
  (`servedGeometries` semantics unchanged for those datasets). Below-threshold
  datasets render exactly as today; SMART's 13 KB stays instant via rows.

## Verification (devtools, FY22 Action Plan)
- [ ] Map open: network shows only range requests against the archive —
      target ≤5% of today's 46.55 MB (part 1's measured ratio calibrates this)
- [ ] No main-thread `JSON.parse` of geometry payloads (performance recording)
- [ ] Layer show/hide instant; map never unmounts across toggles/rebuilds
- [ ] Entry edit → rebuild → source hot-swaps without unmount or skeleton
- [ ] Below-threshold dataset unchanged; entry details still row path

## Done
- [ ] All measured criteria green + PR merged
- [ ] Memory updated (actual byte ratio + any chip-semantics surprises) + **STOP**
      (part 5 = #63 next)
