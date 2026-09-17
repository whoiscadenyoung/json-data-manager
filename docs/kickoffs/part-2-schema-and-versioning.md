# Kickoff — Part 2: schema fields, version invalidation, meta API (issue #60)

Part 2 of 5 implementing #58. Server plumbing only — after this part the app
behaves exactly as today, but schema rows can point at a current archive and
every geometry write bumps a version. No generation (part 3), no rendering
(part 4).

## Read first
1. `docs/memory/MEMORY.md`, then `geometry-tile-breakdown.md` (you are #60)
2. `docs/memory/convex-dev-restart-config-race.md` (dev-deployment verification
   notes: `bunx convex run` from `app/`, retry on config-load race)
3. Issue **#60** — your task, full design + acceptance criteria
4. Skim: issue #58 (parent), part 1's issue (#59) for what `@caden/geometry-archive`
   provides (nothing you depend on directly yet)

**Amend before handing off:** confirm the actual `@caden/geometry-archive` API
and measured compression ratio from part 1's PR (check
`docs/memory/geometry-tile-breakdown.md` — it should have been updated; else
read the package source).

## Task (files)

`packages/json-cms/src/component/schema.ts` — `schemas` table:

```ts
mapTileCacheVersion: v.optional(v.number()),           // absent = 0
mapTileArchiveStorageId: v.optional(v.id("_storage")),
mapTileArchiveBytes: v.optional(v.number()),
mapTileArchiveMaxZoom: v.optional(v.number()),
```

`packages/json-cms/src/component/lib.ts`:
- `bumpMapTileCacheVersion(ctx, schemaId)` helper; patch it into EVERY path
  that already maintains `featureCount`/`boundingBox` (entry insert/replace/
  delete, import chunk insert, simplify batch, `deleteEntriesBySchema`,
  clear). Unconditional — not threshold-gated.
- `setMapTileArchive` internal mutation: `{schemaId, expectedVersion,
  storageId, bytes, maxZoom}`. If `expectedVersion !== current` → **delete the
  incoming blob and no-op** (stale rebuild self-discards — this guard is the
  correctness mechanism, not the client debounce). On match: delete the
  superseded archive blob (if any) and patch all four fields.
  `ctx.storage.delete` works in mutations — existing pattern `lib.ts:1496`.
- `deleteEntriesBySchema`/clear: delete the archive blob + reset fields.
- Threshold constant next to `GEOMETRY_PAGE_BYTE_BUDGET`:
  `MAP_TILE_ARCHIVE_MIN_BYTES = 262_144`.

Read path:
- `getMapTileArchiveMeta` query → `{storageId, version, bytes, maxZoom, url}`;
  `ctx.storage.getUrl` works in queries (precedent `resolveGeometryOutput`,
  `lib.ts:1066`). Expose via `exposeApi` in `app/convex/` (shape of `geometries.ts`).
- `useMapTileArchiveMeta(schemaId)` react hook in the react package, following
  existing hook conventions there.

## Hard constraints
- Components cannot call `.paginate()`; actions can't read the db (use
  `ctx.runQuery`); `storage.get` is action-only. Don't fight these — they're
  documented in `lib.ts` doc comments.
- After `packages/json-cms` edits: `bun run build` in `packages/json-cms`
  (the app consumes dist). Restart the app dev session if needed.
- Verify against the live local dev deployment via `bunx convex run` from
  `app/` (read-only calls through the exposed API).

## Tests (convex-test)
- Version bump on every listed write path (incl. import chunks + simplify).
- `setMapTileArchive`: install + old-blob delete; **stale `expectedVersion`
  discards incoming blob, row untouched**; `deleteEntriesBySchema`/clear drops
  blob + fields; legacy rows with absent fields read fine.

## Done
- [x] `bun test` green + component build green
- [x] Verified live: `setMapTileArchive` round trip + meta query via `bunx convex run`
- [x] PR merged + memory updated + **STOP** (part 3 = #61 next)
