# Code Review — 2026-09-30

> **Tracking:** every finding below is filed under umbrella issue **#123** (children #124–#139, mapping at the end). Trust-model decision: published artifacts are co-editable by design — [ADR 0009](./decisions/0009-trusted-collaborator-catalog.md). This document is a dated record; status lives on the issues.

Scope: full repo at `537549e` (post-roadmap, stages 0–9 merged). Six parallel Sonnet 5.5 reviewers covered these areas:

- authz/publish
- sync/derived
- component packages
- client libs/SQL
- frontend
- tests/CI/deps

A verify workflow then ran four adversarial Sonnet skeptics against the 21 highest-severity claims. **19 were confirmed and 2 were rated plausible (A3, A6). None were refuted.** The skeptics re-rated severity, and those ratings are the ones used below.

## Gates

| Check                              | Result                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bun run lint` (oxlint type-aware) | ✅ clean                                                                                                    |
| `bunx tsc --noEmit` (app)          | ✅ clean                                                                                                    |
| app tests                          | ✅ 315 / 315                                                                                                |
| json-cms tests (+typecheck)        | ✅ 333 / 333                                                                                                |
| data-export tests                  | ✅ 19 / 19 (**not run in CI**)                                                                              |
| geometry-archive tests             | ✅ 16 / 16                                                                                                  |
| `bun run fmt:check`                | ❌ **61 files unformatted** (18 app/convex, 17 app/src/lib, rest scattered). CI omits this step on purpose. |

---

## Verified findings (ranked)

### High

**S4 — Derived-chain retention breaks permanently after the first retirement.**
`app/convex/consumption.ts:309-346, 455-466`

- `completedAttemptsFor` collects _all_ `publishAttempts` for the anchor with no status filter.
- Retired attempts keep a `publishedSchemaId` that points at a deleted row, and `versionsToRetire` hands those ids back.
- `deleteSchema` then throws "Schema not found" and rolls back `afterPublishCompleted`.
- Effect: `recordChainDelta` and retention both stop working for that chain. Chains grow without bound, and diffs stop being recorded. Publishes themselves still succeed.
- Fix: filter to `status === "completed"` and to rows that still exist, or mark the attempt retired when retiring it. Make the retire loop tolerate not-found.

**E1 — PMTiles run-length dedupe covers gaps, which makes tiles unreachable.**
`packages/geometry-archive/src/assemble.ts:93-102`

- `deduplicateTiles` merges byte-identical tiles into one run without checking that `tile.tileId === prev.tileId + prev.runLength`.
- Identical tiles at ids 10 and 20 become one entry `{10, runLength 2}`. Tile 20 then disappears, and id 11 resolves to the wrong blob.
- Gaps are common because empty tiles are skipped, and interior tiles of large polygons are often identical. The first reviewer reproduced this: 20 of 215 tiles were missing for a U-shaped polygon.
- Visible effect: holes in rendered maps.
- Fix: extend a run only when the ids are consecutive, and add a gap test.

### Medium — security / authorization

The storage-id chain (A1, A2, A5) shares one root cause. `tile_archives.metas` returns `storageId` and `version` for **any** dataset to any signed-in user. At the same time, three write paths accept client-supplied storage ids without checking where they came from.

| ID                         | Location                                                                  | Issue                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1                         | `app/convex/tile_archives.ts:38-60`                                       | `install` calls `auth(ctx)` with no operation, so the visibility, ownership and read-only checks are skipped. Any signed-in user can replace any dataset's tile archive, drafts included. The `expectedVersion` guard is readable via `metas`.                                                                                           |
| A2                         | `app/convex/publish.ts:390-435`                                           | `registerChunk` accepts any `v.string()` storage id. `resetUpload` and the freeze-failure path then pass it to `deleteStorageBlobs`, so a user can delete other datasets' blobs.                                                                                                                                                         |
| A5                         | `packages/json-cms/src/component/lib.ts:3002-3062`, `client/index.ts:745` | `startImport` accepts foreign `sourceFile.storageId` / `storageIds`. `getSourceFileUrl` will serve the victim's blob, and deleting your own dataset deletes theirs.                                                                                                                                                                      |
| A3 _(resolved: by design)_ | `app/convex/auth.ts:176-200`                                              | Writes are denied only for drafts and `publishedVisibility: "author"` rows, so any signed-in user can edit a published dataset. **Decided 2026-09-30: co-editable by design** (ADR 0009); opt-in locking → #124.                                                                                                                         |
| A4                         | `app/convex/bindings.ts:85-115`                                           | `unbind` has no ownership check, so any signed-in user can delete a bound dataset. Cleanup stops at `.take(1000)` and orphans the rest. `commits` and `syncRuns` (and their blobs) are never deleted.                                                                                                                                    |
| E4                         | `app/src/lib/analysis-duckdb.ts:64-91`                                    | DuckDB-WASM external access is never disabled (`enable_external_access`, autoinstall, `lock_configuration`). A shared analysis containing `read_csv('https://…')` runs in the viewer's browser, which allows exfiltration via query strings.                                                                                             |
| E3                         | `packages/json-cms/src/shared/transform/sql.ts:307-334`                   | The one-statement gate tracks quotes but not comments. For example, `SELECT 1 /* ' */; DROP …` passes. The head check also accepts `WITH … DELETE/INSERT`. Rated Low on its own because the database is ephemeral, but combined with E4 it allows stacking arbitrary statements. Use `extractStatements` and require exactly one SELECT. |
| A6 _(plausible, Low)_      | `packages/json-cms/src/client/index.ts:498-544`                           | The map-layer mutations give the auth hook no map or layer id. This matches the documented decision that maps are shared, but it blocks any future per-map ownership.                                                                                                                                                                    |

Other unverified security items from the reviewers:

- **Emails exposed:** `users.profile` and `users.profileByAuthId` return full rows, including email, to any signed-in user. `listProfiles` deliberately omits email, so these two contradict it.
- **Open signup:** `auth.ts:79` enables email/password with no verification, rate limiting or `disableSignUp`. The "sign-in gate" is therefore open to anyone who registers.
- **Filing others' datasets:** `bundles.recordMember` / `promoteCollection` trust a client-supplied `publishedSchemaId`. A project owner can file another user's draft into a shared collection.
- **Arbitrary table export:** data-export `startExport` takes client `tableNames` into a generic `ctx.db.query(table)`. With a lax hook, any table can be exported, including users and sessions. Add a required `allowedTables` option.
- **Localhost fallback:** `SITE_URL` falls back to localhost for `baseURL` and `trustedOrigins` when the env var is missing. It should fail closed instead.

### Medium — correctness / data integrity

| ID  | Location                                                                                                    | Issue                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `app/convex/sources.ts:127,228` + `sync.ts:1061-1082`                                                       | `listRows` stops at `.take(1000)`, and the full-pass sweep then **deletes every mapping it didn't see**. A source with more than 1,000 rows loses the excess silently, on every run.                                                                                 |
| S2  | `sources.ts:156-160` + `sync.ts:457-484,1140`                                                               | `commitsSince` stops at `.take(500)`, but the cursor is stamped from `newestCommit()`. With more than 500 pending commits, the extra commits are skipped until the next weekly reconcile.                                                                            |
| S3  | `sync.ts:437-490`                                                                                           | `collectRows` has no try/catch, so a failure leaves the run in `collecting` forever. The revive logic keeps rescheduling the same failing collect.                                                                                                                   |
| S5  | `sync.ts:813-849,1025-1045`                                                                                 | `tally.added` / `tally.updated` are never incremented. Run, activity and dashboard counts always show 0.                                                                                                                                                             |
| E2  | `packages/json-cms/src/component/lib.ts:744-770, 2795-2818`                                                 | `deleteSchema` / `deleteEntriesBySchema` `.collect()` everything and delete it in one mutation. Datasets of roughly 8k+ entries with geometry **cannot be deleted or cleared**. Unbind, retention and sync paths all inherit this. Batch the deletes and reschedule. |
| F2  | `packages/json-cms/src/react/ui/dataset-importer.tsx:160-190`, `app/src/routes/datasets/create.tsx:293-392` | A failed import is a dead end: a red bar, no retry or back, and the pre-created dataset stays in the catalog. Each retry creates another orphan.                                                                                                                     |
| F1  | `app/src/routes/__root.tsx:47-70`                                                                           | There is no app-wide sign-in gate; only `/projects` checks auth. Signed-out users see endless skeletons, error screens or a false "Not Found". Add an `_authed` layout route.                                                                                        |

Other unverified correctness items worth a look:

- **Mixed publish snapshot:** `publish.ts` `resumePlan` compares only chunk counts. Retrying after editing a draft can freeze a version that mixes old and new chunks. Add a content hash to the plan.
- **Stale archive can pass the guard:** `deleteEntriesBySchema` resets `mapTileCacheVersion` to 0 instead of bumping it. After a clear and re-import, a stale archive can pass the `expectedVersion` guard.
- **Import rows lost as "completed":** `insertChunkFromStorage` treats a non-array chunk as 0 rows and deletes the blob. The import is still marked `completed`, because `processed` is never compared with `total`.
- **Import retries not idempotent:** a chunk step that crashes after insert but before the blob delete duplicates rows or fails the import. There is no workflow retry config, and there is no rollback.
- **Simplify lost update:** simplify apply overwrites geometry edits made during the batch, and its bare `catch {}` reports `completed` on storage errors.
- **Stale references:** `updateSchema` never re-syncs the `references` table, so reverse lookups go stale. It also skips `assertDataWritable`, so the schema of a frozen or bound dataset can be rewritten.
- **Partial rows from sync:** a sync `update` op with a missing mapping "degrades to an add" using only the changed fields, which creates partial rows.
- **Delta truncation:** stored `tagDeltas` are silently wrong above 2,000 rows (`VERSION_DIFF_LIMIT` truncation on both sides).
- **Read limits:** `sourceBadges`, `consumedBy` and `derivedDatasets.summaries` do N+1 resolution per row with no shared memo, and can hit query read limits at catalog scale. The `listSchemas*` family `.collect()`s full 100 KB+ schema docs.
- **Orphaned host rows:** host rows are orphaned on `deleteSchema`, including `projectArtifacts`, `consumerReferences`, `versionPolicies`, `datasetActivity` and `tagDeltas`.

### Low

| ID  | Location                                                                        | Issue                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3  | `app/src/components/transform-editor.tsx:611-628`, `analysis-panel.tsx:347-366` | When an autosave completes, it clears `dirty` even if the user edited during the save, so that edit is lost.                                                                                                                                                                  |
| F4  | `app/src/routes/datasets/$schemaId/edit.tsx:229-232`                            | The description is still `min(1)` required, which contradicts the optional-description decision.                                                                                                                                                                              |
| F5  | `.github/workflows/ci.yml`                                                      | data-export tests and typecheck never run, and there is no `fmt:check`. Both omissions are documented as deliberate, but the fmt debt is growing.                                                                                                                             |
| E5  | `sql.ts:210-218`                                                                | Every SQL string column is trimmed and lowercased, so published SQL output loses its casing ("Aldine" becomes "aldine"). This is documented as intentional, but it is a product-quality problem. Consider keeping the original text and adding a hidden canonical key column. |

---

## Other notable (unverified) items by area

**Client libs / analysis**

- **Stale tables:** the long-lived DuckDB engine never drops tables from earlier runs. Stale side tables still resolve, so an analysis preview and its publish can disagree.
- **No cancel or timeout:** a runaway query such as `range(1e12)` pins the worker forever.
- **Unsafe value normalization:** only `bigint` values are normalized. DECIMAL, LIST and STRUCT results can throw `DataCloneError`.
- **Cached engine failure:** a rejected `enginePromise` is cached forever, so one failed WASM fetch breaks SQL until reload.
- **Cache eviction:** OPFS eviction doesn't protect the archive in use, so archives larger than the budget thrash.
- **Small datasets:** geospatial datasets under 256 KB are "stale" forever and get rescheduled on every summary update.
- **Unbounded fetches:** the tile-archive worker fires unbounded concurrent geometry fetches.
- **False cycle reports:** `specInputsOf` shares its visited set across siblings, so a diamond-shaped DAG is reported as a cycle.

**Frontend**

- **Error handling:**
  - Export dialog: no catch.
  - `SchemaEditor` save: rethrows into an unhandled rejection.
  - About 38 sites show `error.message` instead of `ConvexError.data`, so users see "Server Error".
- **Stuck states:**
  - `QueryErrorBoundary` never resets on navigation.
  - `signin.tsx` stays busy if the auth call throws.
- **Missing delete confirmation:** saved transforms, analyses, dashboard links and map layers.
- **Performance:** `validation-pane.tsx` validates the entire import synchronously on every schema keystroke.
- **Latent API bug:** `useGeometries` (json-cms react) keys completion on `isLoading`, not `status === "Exhausted"`.
- **Leftovers:** the page title is still "TanStack Start Starter", and devtools render in production.
- **Components worth splitting:** `visual-builder.tsx` (1198 lines), `schema-editor.tsx` (1014) and `datasets/$schemaId/index.tsx` (1009).

**Tests / deps / docs**

- **No behavioral tests** for:
  - `sync.ts` (1309 lines), `tags.ts` (749) and `sources.ts`.
  - `freezeVersion` (`versioning.ts:325`), confirmed.
  - `dashboard`, `bindings`, `tile_archives`, `users` and `schemas`. These are tested only for the sign-in gate.
- **`"latest"` dependency ranges** in `app/package.json:45-51`: TanStack start, router, form and devtools.
- **Prerelease dependencies with caret ranges:** `nitro ^3.0.260610-beta` and `@duckdb/duckdb-wasm ^1.33.1-dev57.0`.
- **Version drift:**
  - vitest: 3.x in app, 4.x in the packages.
  - typescript: 7.0.2 in app and json-cms, 5.9.3 in data-export and geometry-archive.
  - convex-test: three different versions.
  - `@convex-dev/workflow`: caret in data-export, pinned in json-cms.
- **Wrong guidelines path:** `CLAUDE.md:48` / `AGENTS.md:48` pointed at `apps/web/convex/...`. _Fixed 2026-09-30_ to `app/convex/_generated/ai/guidelines.md` (the file exists and is tracked; the reviewer's "missing" claim was wrong).
- **Tooling files in git:** 34 `.zcode/` files are tracked, including stale workflow drafts, and 138 `SKILL.md` files are duplicated across six trees.
- **Secrets:** none tracked. `app/.env` (dev deploy key) and `exports/` are both gitignored.

## Done well

- `auth()` is a single choke point. `actorId` / `viewerId` always come from the hook, never from args, and denials look the same as "not found". Privileged functions are internal or host-only, and the exposeApi surface has no drift from `ComponentApi`.
- The sync apply path checkpoints inside the transaction, with keyed idempotent writes and blob cleanup on both success and failure.
- The Hilbert codec, directory varints and header layout match the reference `pmtiles` reader, checked on 20k random samples.
- `applySql` never throws and reports truncation, and publish refuses truncated results. The pure helpers (`derivedSpec`, coercion, `planEviction`) are well isolated and tested.
- There is no XSS surface: no `innerHTML`/`setHTML`, and map popups render through React portals. Search-param navigation consistently uses the merge form.

## Suggested fix order

1. **E1** (map holes) and **S4** (retention/deltas silently dead): small, contained fixes.
2. **The storage-id chain (A1, A2, A5):** stop leaking `storageId` from `metas`, gate `install` with a schema operation, and track issued upload ids server-side.
3. **Write ownership (A3/A4):** decided co-editable by design (ADR 0009); locking is #124, and signup gating (#136) keeps the trust assumption true.
4. **DuckDB lockdown (E3, E4):** disable external access, lock the configuration, and parse statements properly.
5. **Sync caps (S1, S2, S3):** never sweep after a truncated read, set the cursor from the payload, and fail runs cleanly.
6. **Batched deletes (E2):** unblock large-dataset deletion.
7. **UX dead ends (F1, F2):** add an auth layout and a recovery path for failed imports.
8. **Hygiene:** run `oxfmt`, add data-export to CI, pin the `latest`/prerelease dependencies, add sync, tags and `freezeVersion` tests, and fix the guidelines path.

## Issue mapping

| Issue | Covers                                                                        |
| ----- | ----------------------------------------------------------------------------- |
| #123  | Umbrella, fix order, ground rules                                             |
| #124  | Dataset access modes (private/locked vs public/editable) — A3/A4/A6 follow-up |
| #125  | E1 PMTiles run-length gaps                                                    |
| #126  | S4 retention + delta truncation + retireVersion pins                          |
| #127  | S1/S2/S3/S5 + other sync items                                                |
| #128  | E2 batched deletes, host cascade, unbounded collects, read amplification      |
| #129  | F2 failed-import UX + import/simplify/updateSchema integrity                  |
| #130  | Publish resume snapshot mixing, plan validation                               |
| #131  | A1/A2/A5 storage-id provenance                                                |
| #132  | E3/E4 DuckDB-WASM lockdown                                                    |
| #133  | Analysis engine robustness, E5 casing decision, transform helpers             |
| #134  | Tile cache / worker / tiler performance                                       |
| #135  | F1/F3/F4 + frontend items                                                     |
| #136  | Signup gating, email exposure, SITE_URL fail-closed                           |
| #137  | data-export allowlist, streaming, idempotency                                 |
| #138  | Test coverage (sync, tags, sources, freezeVersion, gate-only modules)         |
| #139  | fmt debt, CI coverage, dependency pinning, tracked tooling                    |
