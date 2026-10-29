# Alternate Postgres / self-hosted Supabase backend — notes (2026-10-29)

Umbrella #182. **Exploration notes only. No code or architecture changes are planned yet.** Context: `docs/published-map-load-options-2026-10-29.md`. The statements about Supabase and Postgres below come from general knowledge, not from this session's research or benchmarks; verify before relying on them.

## Why consider it

Realtime multi-user editing remains the preferred direction, and Convex's per-document read cost (about 1 ms per document, measured locally) is the bottleneck behind slow cold opens of large datasets. A Postgres-based variant of the app, possibly self-hosted Supabase on the VPS, could remove that cost while keeping live editing.

## What it would give

- **Reads and bulk writes:** reading 20k rows from an indexed table is typically tens of milliseconds, not ~12 s. Imports and mass edits become SQL statements instead of per-document writes.
- **PostGIS:** spatial indexes, server-side filtering by area or attribute, and tile generation per request with `ST_AsMVT`, cacheable by dataset version (the CARTO model). That could remove the archive build entirely for drafts, and cover edit-to-tile latency below what an archive rebuild allows.
- **Ecosystem:** Supabase bundles Postgres, auth, storage, row-level security and realtime. Martin or pg_tileserv can serve tiles directly from PostGIS.

## What it would not give

- **Faster or simpler multi-user editing than Convex.** Convex mutations are transactional with automatic conflict retry, and queries re-run and push to every client. Supabase Realtime streams row changes; the client merges them into local state, handles optimistic updates and ordering, and there is no built-in conflict resolution (last write wins unless versions are checked). Postgres Changes checks row-level security per subscriber, a known scaling limit.
- **Text or cell co-editing.** Neither product provides Google-Docs-style simultaneous editing of a cell; that needs a CRDT such as Yjs either way.
- **Anything for published artifacts.** Published maps are served from frozen archives under every option.

## What would change

- The `jsonCms` Convex component (`packages/json-cms`), its import workflows (`@convex-dev/workflow`), the `exposeApi` and auth hook contract (ADR 0007), and every query and mutation in `app/convex` would be rebuilt on SQL.
- Better Auth is hybrid-wired through a Convex component today (ADR 0006); the replacement would use Supabase Auth or Better Auth on Postgres.
- Live queries (`useQuery` throughout the app) would become a client state layer: for example TanStack Query with Realtime subscriptions, or a sync engine such as Replicache, Electric or Zero.
- Self-hosting: Supabase is a Docker stack of roughly ten services; self-hosted Convex is one backend. Operational cost on the VPS rises.

## How an alternate version could be approached

The app is built around a Convex component with a defined API surface, which is the natural seam.

1. Write an ADR first: the goal (read performance with live editing), the seam, and the triggers below. No code before the ADR.
2. Keep Convex as the primary backend. Evaluate a Postgres/PostGIS **read replica of geometry** only, fed from Convex writes, serving tiles or snapshots. Costs: dual writes, drift between stores, another service to run.
3. A full alternate backend (a second implementation of the data layer behind the same app) is a separate, much larger project. Only consider it if the replica proves the performance case and the dual-store cost is unacceptable.

## Spike plan (when approved)

1. Load the 20k-point file into Postgres with PostGIS on the VPS; time a full row read, an `ST_AsMVT` tile request at several zooms, and a filtered tile.
2. Subscribe to row changes with Supabase Realtime from two browsers; measure edit-to-render latency and see what the client must do to stay consistent, including a same-row concurrent edit.
3. Repeat at 100k and 1M rows to find where each approach breaks.
4. Compare against the server-built PMTiles archive option (A in the load-options doc) on the same data. Adopt Postgres only if it wins on something the archive path cannot do.

## Triggers to revisit

- Datasets of millions of rows.
- Maps that must filter on the server by attribute or area.
- Published or draft tiles that must reflect an edit within a second or two.
- The Convex per-document read cost stays unacceptable on the VPS after the archive-build and snapshot options are in.

## Open questions

- What is the real Convex read cost on a self-hosted VPS?
- How much of `jsonCms` (versions, tags, references, imports, publishing) depends on Convex semantics such as OCC retries or reactive queries?
- Is a replica acceptable if the lag is a few seconds, or does editing demand the primary store be the fast one?
