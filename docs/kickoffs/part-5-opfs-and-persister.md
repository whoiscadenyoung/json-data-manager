# Kickoff — Part 5: OPFS pin + TanStack Query persister (issue #63)

Part 5 of 5 implementing #58 — the final increment. Goal: repeat opens of an
unchanged dataset fetch **zero geometry bytes**, and lightweight app state
opens instantly across sessions.

## Read first
1. `docs/memory/MEMORY.md`, then `geometry-tile-breakdown.md` (you are #63)
2. Issue **#63** — full design + verification list
3. Skim issue #58's Phase 2 section (layered-cache rationale)

**Amend before handing off:** confirm part 4 shipped — where the protocol is
registered, how source selection resolves `meta` (so the OPFS source plugs in
at the same seam), and which queries exist whose keys identify "light"
namespaces (for the persister filter).

## Task A — OPFS pin (tile archives)

- Layout: OPFS root → `tile-archives/{schemaId}/{version}.pmtiles`.
  Version-keyed paths make invalidation trivial and keep other tabs' still-
  valid old versions readable.
- Write: after part 3 installs an archive, fetch it once and write to OPFS via
  the **async OPFS API** (`getFileHandle().createWritable()` on the main
  thread). Sync access handles are worker-only and unnecessary — MapLibre's
  `addProtocol` resolves on the main thread. Request
  `navigator.storage.persist()` opportunistically.
- Read: implement the pmtiles `Source` interface (same as `FetchSource`) with
  an OPFS-backed implementation: serve byte ranges from the local copy when
  present, fall back to network (which backfills). Lookup = small in-memory
  meta→path map rebuilt from a directory scan at boot.
- Eviction: keep only the current version per schema; LRU budget across
  schemas (default **256 MB**, tunable constant) checked against
  `navigator.storage.estimate` + our own accounting. `deleteEntriesBySchema`/
  clear prunes that schema's OPFS entries on next meta observation.

## Task B — TanStack Query persister (light state ONLY)

`@tanstack/react-query` is already installed in the app.
- Wrap the app's QueryClient with **`PersistQueryClientProvider`** +
  `createAsyncStoragePersister` backed by `idb-keyval` (the docs' IndexedDB
  persister recipe: `persistClient`/`restoreClient`/`removeClient`).
- `buster` = tiny new query returning **max `mapTileCacheVersion` across
  schemas** (add it to part 2's API surface) — any geometry write bumps some
  version, invalidating persisted state exactly when data changed.
- `dehydrateOptions` filter to **light namespaces only** (schema rows, entries
  pages, meta/feature counts). Geometry payloads never enter the query cache
  (tile path bypasses it) — the filter makes that invariant explicit.
- `maxAge` 7 days; set the QueryClient `gcTime` ≥ `maxAge` (docs gotcha:
  gcTime < maxAge silently discards restored cache).

## Verification
- [ ] Second app open, no edits: zero archive bytes fetched (OPFS hit) —
      devtools network; map renders immediately
- [ ] Entry edit + rebuild → new version fetched once, old OPFS entry pruned
- [ ] LRU budget enforced (seed > budget with synthetic archives)
- [ ] Cold start: persisted light state renders tables instantly; a geometry
      write bumps the buster → persisted light state re-fetches once
- [ ] Multi-tab: two tabs on different versions converge on pruning without
      thrashing

## Non-goals
- No offline editing/sync (OPFS is a read cache); no service worker; no
  TanStack DB (optional future table-path increment, documented in #58).

## Done
- [ ] All verification criteria green + PR merged
- [ ] Memory updated (`geometry-tile-breakdown.md`: what shipped + measured
      repeat-open behavior)
- [ ] **STOP** — then close #58 (all five parts landed) and #51 (GeoJSON blob
      fallback no longer needed)
