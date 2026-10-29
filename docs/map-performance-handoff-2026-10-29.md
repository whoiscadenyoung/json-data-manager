# Map performance handoff — 2026-10-29

Umbrella: #182. Audit: `docs/map-performance-audit-2026-10-28.md`. Memory: `docs/memory/map-performance-audit-2026-10.md`.

## State

| Issue                              | Status                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #183 paginator sizing              | merged (#191)                                                                                                                                                                     |
| #184 build backoff + failure state | merged (#192)                                                                                                                                                                     |
| #185 wait for first tile archive   | merged (#193)                                                                                                                                                                     |
| #186 cheaper row path              | partly merged (#194): 500-row pages + 250 ms throttled loader reports. **Open:** one-shot reads + a single `mapTileCacheVersion` live signal instead of N live page subscriptions |
| #187 server-side archive builds    | not started                                                                                                                                                                       |
| #188 clustering / density          | not started (related: #169)                                                                                                                                                       |

#185 decision (`app/src/features/maps/lib/layer-source.ts`): a geospatial dataset with `featureCount >= TILE_WAIT_MIN_FEATURES` (5000) that has never had an archive (`mapTileArchiveBuiltVersion` undefined, version > 0) returns the existing `pending` decision, which holds the row fetch. It falls back to rows when a build failure is recorded or the below-threshold skip memo matches. Stale-but-built archives keep rows.

## Measured (#185 verification, isolated local backend, fresh 20k points)

- Cold open (dataset page nav to tiles rendered): **16.5 s** (was ~32 s). Target in #182 is under 10 s.
- Peak JS heap 331 MB (was 517 MB). Max main-thread lag 58 ms.
- Breakdown: ~12 s is the worker's one-shot row fetch (500-row pages), ~4 s is the build itself.
- Not measured: the `/maps` workspace, the 50k file, cloud timings.

## Next tasks, in order

### 1. Redundant second tile build (small, start here)

After the first build reached `done`, the log showed `scheduled → fetching → building → uploading → installing → done` again immediately (another ~16 s of fetch). Observed via `console.debug` `[tile-archive] <id> → <state>` in dev. Find out why: suspects are the import's `ensureMapTileArchive` queued trailing behind the manager's `schedule`, or the version moving after the first build's snapshot. Look at `packages/maps/src/build-scheduler.ts` (`TileArchiveScheduler`, `ensure`, `schedule`) and `useMapTileArchiveManager` in `app/src/features/maps/lib/tile-archive.ts`. Fix should make a build that installs at the current version suppress an already-queued trailing run for the same version.

### 2. #187 server-side archive builds (biggest win)

Build at import completion and after edits on the server so the browser stops fetching every row. This is what should get 20k cold opens under 10 s. Needs a design pass first: the builder currently lives in a web worker (`tile-archive.worker.ts`) using the same code as `packages/maps`; check what can run in a Convex action (size/time limits, storage upload) before choosing. Keep the client path as the fallback (#184 backoff, skip memo, version guard `setMapTileArchive expectedVersion` all stay valid).

### 3. #186 remainder

One-shot reads (`forEachDatasetGeometryPage`) plus one live signal. Low value after #185 (row path is now only <5k features, derived layers, stale or failed archives). Touches every `SchemaGeometriesLoader`/`useGeometriesBySchemas` consumer. Do only if the row path matters again.

### 4. #188 clustering / density

Rendering feature for dense point layers, not load time. Read #169 first.

## Verification recipe (isolated backend — do NOT touch the cloud dev deployment)

Gotchas are in `docs/memory/map-performance-audit-2026-10.md` and `docs/memory/better-auth-setup.md`. What worked on 2026-10-28/29:

1. Back up `app/.env.local` first. `convex dev --once --env-file` rewrites it to local URLs; restore it after.
2. Run the backend binary directly: cwd `app/.convex/local/default/`, `~/.cache/convex/binaries/<newest>/convex-local-backend --port 3312 --site-proxy-port 3313 --instance-secret <config.json instanceSecret> --instance-name <config.json deploymentName> --local-storage <fresh dir> <fresh>.sqlite3`.
3. Env file with `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3312` and `CONVEX_SELF_HOSTED_ADMIN_KEY=<config.json adminKey>`. Then `bunx convex env set --env-file … SITE_URL http://localhost:3400`, same for `BETTER_AUTH_SECRET`, then `bunx convex dev --once --env-file …`.
4. Sign-up is closed: `bunx convex run --env-file … auth:createAccount '{"email":…,"password":…,"name":…}'`, then POST `/api/auth/sign-in/email` from the page.
5. `VITE_CONVEX_URL=http://127.0.0.1:3312 VITE_CONVEX_SITE_URL=http://127.0.0.1:3313 SITE_URL=http://localhost:3400 bunx vite dev --port 3400`.
6. Generate 20k points (GeoJSON FeatureCollection, ~3.5 MB), serve it from a scratch Bun server with `access-control-allow-origin: *`, then in the page: fetch the blob → `DataTransfer` → `input[type=file].files` → dispatch `change` on `/datasets/create` → "Import data". Set the title and click "Create dataset".
7. Install the timer/monitor in the page BEFORE clicking create so it spans the SPA navigation. A cold open is only valid when the build is scheduled as the dataset page opens (check the `[tile-archive] … scheduled` timestamp against the navigation timestamp).
8. The app resolves `@caden/json-cms/react` types from the gitignored `packages/json-cms/dist`. After changing that package run `bun run build` in `packages/json-cms` before `tsc` in `app/`.
9. Tests: `bunx vitest run` (not `bun test`) from `app/`; lint with `bunx oxlint`, format with `bunx oxfmt` (paths must not contain `..`, so run them from the package dir).

Commit with the `/commit` skill (AGENTS.md rule); end commit messages and PR bodies with the attribution lines.

## Update (end of session, 2026-10-29)

- Redundant second tile build: fixed and merged (#195). Import latency 48.7 s to 17.3 s (#195). Row-fetch badge and import progress: merged (#196).
- #187 server-side archive builds: phase 1 built and measured, then dropped. The V8 runtime runs out of memory at 64 MB for 20k points, and a `"use node"` action made the cold open 28.6 s against 16.5 s. See `map-server-archive-build-design-2026-10-29.md`.
- The 12 s row read is a per-document database cost, so the packed snapshot (`map-geometry-snapshot-design-2026-10-29.md`) was designed and shelved.
- #186 remainder and #188 clustering: still not started.
- Next: `published-map-load-options-2026-10-29.md` lists the options and the likely order; `postgres-supabase-backend-notes-2026-10-29.md` covers the database variant.
