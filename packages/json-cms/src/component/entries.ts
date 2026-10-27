import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { geometryTypeValidator } from "../shared/geojson/validators.js";
import type { GeometryTypeArg } from "../shared/geojson/validators.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
  DELETE_BYTE_RESERVE,
  DELETE_ROW_BYTE_ESTIMATE,
  finishClear,
  runDeletePhases,
  transactionReadRemaining,
} from "./internal/deleteBudget.js";
import { paginateEntriesBySchema } from "./internal/entryPages.js";
import {
  applyEntryCountDelta,
  applyGeometryStatsDelta,
  assertEntryDataSize,
  deleteGeometryStorageIfAny,
  deleteReferencesForEntry,
  insertEntryBatch,
  replaceEntryGeometry,
  syncEntryReferences,
  validateEntryGeometry,
} from "./internal/entryWrites.js";
import { paginateGeometriesBySchema } from "./internal/geometryPages.js";
import { clampLimit, isVisibleToViewer } from "./internal/schemaViews.js";
import {
  assertDataWritable,
  boundWriteValidator,
  entryValidator,
  schemaValidator,
} from "./internal/shared.js";

// Hard cap on `listEntriesForIds` — one indexed `get` per id, but an
// unbounded id list would still be an unbounded read.
const LIST_ENTRIES_FOR_IDS_MAX = 200,
  // The normalized shape every reader of `geometries` gets back — see
  // `resolveGeometryOutput`. Exactly one of `geometryJson`/`geometryUrl` is
  // set (barring a row with no geometry payload at all, which shouldn't
  // happen but isn't asserted against here).
  geometryOutputValidator = v.object({
    _creationTime: v.number(),
    _id: v.id("geometries"),
    bbox: v.optional(v.array(v.number())),
    entryId: v.id("entries"),
    geometryJson: v.optional(v.string()),
    geometryUrl: v.optional(v.string()),
    schemaId: v.id("schemas"),
    type: geometryTypeValidator,
  }),
  entryReferenceValidator = v.object({
    fieldName: v.string(),
    sourceEntry: entryValidator,
    sourceSchemaId: v.id("schemas"),
  });

// Entry queries

export const listEntries = query({
  // Required limit (issue #128): the read is bounded to `limit` of the
  // dataset's rows on the `by_schema` index (no filter after the take — the
  // index IS the read bound). Anything rendered per page or read to the end
  // belongs on the paginated `listEntriesPage`.
  args: { limit: v.number(), schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    return ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .order("desc")
      .take(clampLimit(args.limit));
  },
  returns: v.array(entryValidator),
});

/**
 * Normalizes one `geometries` row into the shape every reader gets back:
 * exactly one of `geometryJson` (parseable inline text) or `geometryUrl` (a
 * fetchable URL, for a geometry too large to store inline) is set. This
 * transparently handles all on-disk forms a row can be in — new rows carry
 * `geometryJson`/`geometryStorageId`; a pre-migration row may still carry
 * only the legacy inline `geometry` field — so callers never need to know
 * which one a given row has.
 *
 * `ctx.storage.getUrl` is available from a `query` (unlike `ctx.storage.get`,
 * which reads blob content and is action-only) — that's what makes it
 * possible to resolve a storage-backed geometry to something a client can
 * fetch directly, without needing an action-backed read path.
 */
async function resolveGeometryOutput(
  ctx: QueryCtx,
  row: {
    _creationTime: number;
    _id: Id<"geometries">;
    bbox?: number[];
    entryId: Id<"entries">;
    // Untyped here (not the `Geometry` union) — Convex's own `bbox` field on
    // this legacy sub-shape is a plain `v.array(v.number())`, which doesn't
    // structurally match the `geojson` package's strict-tuple `BBox` type;
    // this function only ever re-serializes it, never inspects its shape.
    geometry?: unknown;
    geometryJson?: string;
    geometryStorageId?: Id<"_storage">;
    schemaId: Id<"schemas">;
    type: GeometryTypeArg;
  },
): Promise<{
  _creationTime: number;
  _id: Id<"geometries">;
  bbox?: number[];
  entryId: Id<"entries">;
  geometryJson?: string;
  geometryUrl?: string;
  schemaId: Id<"schemas">;
  type: GeometryTypeArg;
}> {
  const base = {
    _creationTime: row._creationTime,
    _id: row._id,
    bbox: row.bbox,
    entryId: row.entryId,
    schemaId: row.schemaId,
    type: row.type,
  };
  if (row.geometryJson !== undefined) {
    return { ...base, geometryJson: row.geometryJson };
  }
  if (row.geometryStorageId !== undefined) {
    const url = await ctx.storage.getUrl(row.geometryStorageId);
    return url === null ? base : { ...base, geometryUrl: url };
  }
  if (row.geometry !== undefined) {
    return { ...base, geometryJson: JSON.stringify(row.geometry) };
  }
  return base;
}

/**
 * List the full-geometry rows for a schema, one page at a time — the ONLY
 * read path that pulls full coordinate payloads. Reserved for map
 * rendering; the properties table (`listEntries`) never touches this table.
 * Callers must page through with `paginationOpts.cursor` until `isDone` —
 * see `useAllPaginated` in the `react` package (also used internally by
 * `useGeometries`), which does this for you.
 */
export const listGeometries = query({
  args: { paginationOpts: paginationOptsValidator, schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    const result = await paginateGeometriesBySchema(ctx, args.schemaId, args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(result.page.map(async (row) => resolveGeometryOutput(ctx, row))),
    };
  },
  returns: paginationResultValidator(geometryOutputValidator),
});

/**
 * The single geometry attached to one entry (1:1 — see the `geometries`
 * table's doc comment), or `null` when the entry has none. Lets entry-level
 * views (entry details) fetch one geometry without dragging in the whole
 * dataset's paginated set.
 */
export const getEntryGeometry = query({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => {
    const geometry = await ctx.db
      .query("geometries")
      .withIndex("by_entry", (q) => q.eq("entryId", args.entryId))
      .unique();
    if (geometry === null) {
      return null;
    }
    return resolveGeometryOutput(ctx, geometry);
  },
  returns: v.union(v.null(), geometryOutputValidator),
});

/**
 * The `_id`s of every geospatial dataset in a collection, via its
 * `schemaCollections` membership rows. Each row carries a denormalized
 * `kind` (see schema.ts), so the common case reads only the membership rows —
 * no `schemas` doc fetch per membership (issue #54's collection-level N+1).
 * Rows from before the denormalization have no `kind` and fall back to one
 * schema-doc read, so results are identical either way; the
 * `backfillDatasetSummaries` maintenance mutation stamps them in one pass.
 */
async function listGeospatialSchemaIdsByCollection(ctx: QueryCtx, collectionId: Id<"collections">) {
  const memberships = await ctx.db
    .query("schemaCollections")
    .withIndex("by_collection", (q) => q.eq("collectionId", collectionId))
    .collect();
  const ids = await Promise.all(
    memberships.map(async (row) => {
      if (row.kind !== undefined) {
        return row.kind === "geospatial" ? row.schemaId : null;
      }
      const schemaDoc = await ctx.db.get(row.schemaId);
      return schemaDoc !== null && schemaDoc.kind === "geospatial" ? row.schemaId : null;
    }),
  );
  return ids.filter((id): id is Id<"schemas"> => id !== null);
}

/**
 * The subset of `schemaIds` visible to `viewerId` (stage 8, #104) — the
 * batch/cross-dataset entry reads' shared filter: a foreign draft or
 * `publishedVisibility: "author"` row contributes nothing, so a batch read
 * answers the VISIBLE subset instead of leaking another user's rows or
 * crashing the caller's whole query on one invisible id (the reference
 * pickers' invariant: an invisible target renders as no candidates, never
 * as a broken form).
 */
async function visibleSchemaIds(
  ctx: QueryCtx,
  schemaIds: Array<Id<"schemas">>,
  viewerId: string,
): Promise<Set<Id<"schemas">>> {
  const visible = new Set<Id<"schemas">>();
  await Promise.all(
    schemaIds.map(async (schemaId) => {
      const doc = await ctx.db.get(schemaId);
      if (doc !== null && isVisibleToViewer(doc, viewerId)) {
        visible.add(schemaId);
      }
    }),
  );
  return visible;
}

// NOTE on the collection-level map view: there is deliberately no
// `listGeometriesByCollection` aggregate query. Convex allows at most ONE
// `.paginate()` call per query execution ("Only a single paginated query is
// allowed per function execution" — a hard platform limit, not a style
// preference); a collection's geometries are spread across several
// independently-indexed schemas (`geometries` has no `collectionId` of its
// own to scan in one index-scoped pass), so aggregating them server-side
// would need either multiple `.paginate()` calls in one execution (not
// allowed) or a denormalized `collectionId` on every `geometries` row kept
// in sync on every schema re-org (an expensive cascading update, itself
// subject to the very same resource limits this fix exists to respect).
// Instead, the client already has the collection's geospatial schema ids
// (from `listSchemasByCollection` / its own `datasets` list) and calls the
// already-paginated `listGeometries` once per schema, merging client-side —
// see `useAllPaginated` and the collection map route for the pattern.

/**
 * Aggregated entry rows for every geospatial dataset in a collection — joined
 * client-side for feature-detail popups on the collection map view.
 *
 * `limit` (REQUIRED since issue #128 — the old omitted cap read as
 * MAX_SAFE_INTEGER, an unbounded read) caps rows taken PER DATASET (issue
 * #54): a collection spans several datasets, and a dataset past Convex's
 * ~16 MiB per-execution read budget would fail the whole query. Callers that
 * legitimately want everything pass an explicit bound (the group export
 * passes `LIST_LIMIT_MAX`-style caps per dataset or reads `listEntriesPage`
 * to exhaustion instead).
 */
export const listEntriesByCollection = query({
  args: { collectionId: v.id("collections"), limit: v.number(), viewerId: v.string() },
  handler: async (ctx, args) => {
    // Viewer-scoped like its dataset-listing sibling `listSchemasByCollection`
    // (stage 8, #104): a creator may add their own draft or author-only row to
    // a shared collection, and this read then serves that dataset's rows —
    // the invisible ids are filtered out, never returned to another viewer.
    const geospatialIds = await listGeospatialSchemaIdsByCollection(ctx, args.collectionId),
      schemaIds = [...(await visibleSchemaIds(ctx, geospatialIds, args.viewerId))],
      rows = await Promise.all(
        schemaIds.map(async (schemaId) =>
          ctx.db
            .query("entries")
            .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
            .take(clampLimit(args.limit)),
        ),
      );
    return rows.flat();
  },
  returns: v.array(entryValidator),
});

export const getEntry = query({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => ctx.db.get(args.entryId),
  returns: v.union(v.null(), entryValidator),
});

/**
 * Entries from several datasets at once, flattened into one list (each row
 * still carries its own `schemaId`). Powers building a reference field's
 * candidate picker without one round trip per referenced dataset.
 *
 * `limit` (REQUIRED since issue #128 — the old omitted cap read as
 * MAX_SAFE_INTEGER, an unbounded read) caps rows taken PER DATASET (issue
 * #54) — same rationale as `listEntriesByCollection`. The map workspace's
 * popup lookup passes a cap; callers that genuinely need every row page
 * `listEntriesPage` instead.
 */
export const listEntriesForSchemas = query({
  args: {
    limit: v.number(),
    schemaIds: v.array(v.id("schemas")),
    viewerId: v.string(),
  },
  handler: async (ctx, args) => {
    // Viewer-scoped (stage 8, #104): the batch read answers rows from the
    // VISIBLE subset only — an invisible reference target contributes no
    // candidates instead of its rows (or a whole-query denial).
    const visible = await visibleSchemaIds(ctx, [...new Set(args.schemaIds)], args.viewerId),
      rows = await Promise.all(
        [...visible].map(async (schemaId) =>
          ctx.db
            .query("entries")
            .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
            .take(clampLimit(args.limit)),
        ),
      );
    return rows.flat();
  },
  returns: v.array(entryValidator),
});

/** Largest number of rows one `listEntriesPage` page may return — entries are
 * thin (see CONVERSION_BATCH_SIZE's note), so a fixed row cap is the honest
 * read bound; payload-budgeted chunking would only matter for pathological
 * `data` payloads that already break every other entries read today. */
const MAX_ENTRY_PAGE_ROWS = 500;

/**
 * Server-side paginated view of one dataset's entries (issue #54): the
 * entries-table equivalent of `listGeometries`. Entries pages keep every
 * query execution bounded no matter how big the dataset grows — an unbounded
 * read of a 20k-row import would blow the ~16 MiB per-execution cap (Convex
 * components cannot call `.paginate()`; see `paginateEntriesBySchema`).
 * Ordered newest-first by default, matching the pre-pagination table;
 * `order: "asc"` serves the callers whose pre-pagination read was the plain
 * ascending index scan (the group export's byte-identical off-path, 3a).
 */
export const listEntriesPage = query({
  args: {
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    paginationOpts: paginationOptsValidator,
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    const { page, isDone, continueCursor } = await paginateEntriesBySchema(
      ctx,
      args.schemaId,
      args.paginationOpts.cursor,
      Math.max(1, Math.min(args.paginationOpts.numItems, MAX_ENTRY_PAGE_ROWS)),
      args.order ?? "desc",
    );
    return { continueCursor, isDone, page };
  },
  returns: paginationResultValidator(entryValidator),
});

/**
 * Entries by id — the reference-field label lookup (issue #54): the entries
 * table resolves the human-readable labels for exactly the entries its loaded
 * rows reference, instead of loading every row of every referenced dataset
 * just to label a handful of links. Missing/deleted ids are simply absent
 * from the result; callers render the raw id as a fallback.
 */
export const listEntriesForIds = query({
  args: { entryIds: v.array(v.id("entries")), viewerId: v.string() },
  handler: async (ctx, args) => {
    if (args.entryIds.length > LIST_ENTRIES_FOR_IDS_MAX) {
      throw new ConvexError(`entryIds exceeds ${LIST_ENTRIES_FOR_IDS_MAX} items`);
    }
    const seen = new Set(args.entryIds),
      docs = (
        await Promise.all([...seen].map(async (entryId) => await ctx.db.get(entryId)))
      ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    // Label lookups filter, never throw (stage 8, #104): an entry whose
    // dataset is invisible to the viewer is simply unlabeled — the caller
    // renders the raw id as the documented fallback.
    const visible = await visibleSchemaIds(
      ctx,
      docs.map((entry) => entry.schemaId),
      args.viewerId,
    );
    return docs.filter((entry) => visible.has(entry.schemaId));
  },
  returns: v.array(entryValidator),
});

/**
 * Reverse lookup: every other dataset's entry that currently references
 * `entryId`, via the `references` index (see schema.ts) — an indexed
 * lookup rather than a scan of every other dataset's entries.
 */
export const listReferencingEntries = query({
  args: { entryId: v.id("entries"), viewerId: v.string() },
  handler: async (ctx, args) => {
    const refs = await ctx.db
        .query("references")
        .withIndex("by_target_entry", (q) => q.eq("targetEntryId", args.entryId))
        .collect(),
      results = await Promise.all(
        refs.map(async (ref) => {
          const sourceEntry = await ctx.db.get(ref.sourceEntryId);
          return sourceEntry
            ? { fieldName: ref.fieldName, sourceEntry, sourceSchemaId: ref.sourceSchemaId }
            : null;
        }),
      );
    // Stage 8 (#104): the referencing panel names OTHER datasets' rows — a
    // source the viewer cannot see (a foreign draft, an author-visibility
    // row) contributes nothing; drafts-over-published-sources are the
    // designed authoring pattern, so this read filters rather than denies.
    const visible = await visibleSchemaIds(
      ctx,
      results.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.sourceSchemaId),
      args.viewerId,
    );
    return results.filter(
      (r): r is NonNullable<typeof r> => r !== null && visible.has(r.sourceSchemaId),
    );
  },
  returns: v.array(entryReferenceValidator),
});

// Internal queries/mutations for use within the component

export const getSchemaInternal = internalQuery({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => ctx.db.get(args.schemaId),
  returns: v.union(v.null(), schemaValidator),
});

export const getEntryInternal = internalQuery({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => ctx.db.get(args.entryId),
  returns: v.union(v.null(), entryValidator),
});

/**
 * Deletes an entry and, if it has one, its associated `geometries` row (and
 * that row's external storage blob, if any) — decrementing the owning
 * schema's `featureCount` (bbox left untouched, see its doc comment).
 * Silently no-ops if the entry doesn't exist.
 */
async function deleteEntryCascading(ctx: MutationCtx, entryId: Id<"entries">): Promise<void> {
  const existing = await ctx.db.get(entryId);
  if (!existing) {
    return;
  }
  const [schemaDoc, geometryDoc] = await Promise.all([
    ctx.db.get(existing.schemaId),
    existing.geometryId !== undefined ? ctx.db.get(existing.geometryId) : Promise.resolve(null),
  ]);
  if (schemaDoc) {
    await applyEntryCountDelta(ctx, existing.schemaId, schemaDoc, -1);
  }
  if (existing.geometryId !== undefined) {
    await ctx.db.delete(existing.geometryId);
    await deleteGeometryStorageIfAny(ctx, geometryDoc);
    if (schemaDoc) {
      await applyGeometryStatsDelta(ctx, existing.schemaId, schemaDoc, -1, undefined);
    }
  }
  await deleteReferencesForEntry(ctx, entryId);
  await ctx.db.delete(entryId);
}

/**
 * Deletes the entry's existing `geometries` row (if any, and its external
 * storage blob, if any), clears its pointer fields, and decrements the
 * schema's `featureCount`. No-ops if the entry has no geometry. Bbox is left
 * untouched (see its doc comment).
 */
async function clearEntryGeometry(
  ctx: MutationCtx,
  entry: { _id: Id<"entries">; schemaId: Id<"schemas">; geometryId?: Id<"geometries"> },
  schemaDoc: { featureCount?: number; boundingBox?: number[] },
): Promise<void> {
  if (entry.geometryId === undefined) {
    return;
  }
  const existing = await ctx.db.get(entry.geometryId);
  await ctx.db.delete(entry.geometryId);
  await deleteGeometryStorageIfAny(ctx, existing);
  await ctx.db.patch(entry._id, { geometryId: undefined, geometryType: undefined });
  await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, -1, undefined);
}

// Entry mutations (geometry/summary contract: see internal/entryWrites.ts)

export const createEntry = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    data: v.any(),
    geometry: v.optional(v.string()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);

    const [entryId] = await insertEntryBatch(ctx, args.schemaId, schemaDoc, [
      { data: args.data, geometry: args.geometry },
    ]);

    return entryId;
  },
  returns: v.id("entries"),
});

export const createEntriesBulk = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    entries: v.array(v.object({ data: v.any(), geometry: v.optional(v.string()) })),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);

    return insertEntryBatch(ctx, args.schemaId, schemaDoc, args.entries);
  },
  returns: v.array(v.id("entries")),
});

export const updateEntry = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    data: v.any(),
    entryId: v.id("entries"),
    geometry: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    const schemaDoc = await ctx.db.get(existing.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    // Checked before any write so a rejected call leaves the entry untouched
    // (the transaction would roll back anyway; failing fast is clearer).
    assertDataWritable(schemaDoc, args.boundWrite);
    assertEntryDataSize(args.data);

    await ctx.db.patch(args.entryId, { data: args.data });

    await syncEntryReferences(ctx, args.entryId, existing.schemaId, schemaDoc, args.data);

    if (args.geometry === undefined) {
      return;
    }

    if (args.geometry === null) {
      await clearEntryGeometry(ctx, existing, schemaDoc);
      return;
    }

    const resolved = validateEntryGeometry(args.geometry, schemaDoc);
    if (resolved !== undefined) {
      await replaceEntryGeometry(ctx, existing, schemaDoc, resolved);
    }
  },
});

export const deleteEntry = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    // The schema doc is normally present; an orphaned entry (its dataset
    // already gone) may still be cleaned up.
    const schemaDoc = await ctx.db.get(existing.schemaId);
    if (schemaDoc !== null) {
      assertDataWritable(schemaDoc, args.boundWrite);
    }

    await deleteEntryCascading(ctx, args.entryId);
  },
});

export const deleteEntriesBySchema = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);

    // The tile archive's blob goes with the data — like the source-file blob
    // in `deleteSchema`, nothing outside the schema doc references it. The
    // four cache FIELDS reset in the clear's finisher, but
    // `mapTileCacheVersion` is bumped monotonically instead (issue #129,
    // revising the recorded exact-reset decision): a rebuild snapshotted at
    // the pre-clear version N — or an OPFS pin keyed (schemaId, N) — must
    // never be satisfiable by post-clear data, and a reset to 0 would let a
    // re-import climb right back to N and pass the `expectedVersion` guard.
    // Bumped, N is retired forever.
    if (schemaDoc.mapTileArchiveStorageId !== undefined) {
      await ctx.storage.delete(schemaDoc.mapTileArchiveStorageId);
    }

    const deleted = { entries: 0 },
      { complete } = await runDeletePhases(ctx, args.schemaId, "entries", finishClear, deleted);
    if (complete) {
      return deleted.entries;
    }
    // The drain continues across scheduled transactions (`clearEntriesStep`);
    // report the dataset's own pre-clear count — the total this call set out
    // to delete (`entryCount` is kept exact by the entry mutations, so it is
    // what the single-transaction clear would have returned).
    return schemaDoc.entryCount ?? deleted.entries;
  },
  returns: v.number(),
});

// Internal mutations for advanced use cases

export const insertEntryInternal = internalMutation({
  args: {
    data: v.any(),
    geometry: v.optional(v.string()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    const [entryId] = await insertEntryBatch(ctx, args.schemaId, schemaDoc, [
      { data: args.data, geometry: args.geometry },
    ]);

    return entryId;
  },
  returns: v.id("entries"),
});

export const patchEntryInternal = internalMutation({
  args: {
    data: v.any(),
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    assertEntryDataSize(args.data);
    const existing = await ctx.db.get(args.entryId);
    await ctx.db.patch(args.entryId, { data: args.data });
    if (!existing) {
      return;
    }
    const schemaDoc = await ctx.db.get(existing.schemaId);
    if (schemaDoc) {
      await syncEntryReferences(ctx, args.entryId, existing.schemaId, schemaDoc, args.data);
    }
  },
});

export const deleteEntryInternal = internalMutation({
  args: {
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    await deleteEntryCascading(ctx, args.entryId);
  },
});

// One-off maintenance for the denormalized summaries (issue #54): stamps
// `entryCount` onto every dataset and `kind` onto every collection-membership
// row that predates the fields. Idempotent — counts are recomputed from the
// entries themselves, so re-running also repairs any drift (the incremental
// maintainers keep it exact; this is the bootstrap/repair path).
//
// Bounds (issue #128 — the old form read every entry of every schema in ONE
// mutation, past the per-transaction read caps on any real catalog): the
// membership stamping stays one bounded pass (thin rows, catalog-scale
// table), and the entry counting walks schemas one at a time through the
// `by_creation_time` system index, counting each dataset's entries in
// paginated chunks and handing off to `backfillDatasetSummariesStep` — a
// fresh transaction — whenever the read budget runs low. The public mutation
// returns the stats for the work that completed synchronously (all of it for
// a fixture-sized catalog); the scheduled hops land the rest, so the count
// converges without anyone watching.

/** Entry rows examined per pagination chunk while counting one schema. */
const BACKFILL_CHUNK_ROWS = 500,
  // Hand off to a scheduled continuation once the remaining read budget
  // falls under this (the delete drain's reserve — same headroom logic).
  BACKFILL_BYTE_RESERVE = DELETE_BYTE_RESERVE;

/** The drain's resumable position: the schemas before `schemaCreationTime` are done, `schemaId`'s count reached `entryCursor` having seen `counted` rows. */
interface BackfillState {
  counted: number;
  entryCursor: string | null;
  membershipsPatched: number;
  schemaCreationTime: number;
  schemaId: Id<"schemas"> | null;
  schemasPatched: number;
}

/**
 * Counts one chunk of `schemaId`'s entries through the shared entries
 * paginator (which reads full entry docs — the count's honest cost), up to
 * the budget. Returns the advanced cursor state; `complete` when the
 * schema's index is exhausted.
 */
async function countSchemaEntries(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  state: Pick<BackfillState, "counted" | "entryCursor">,
): Promise<Pick<BackfillState, "counted" | "entryCursor"> & { complete: boolean }> {
  let counted = state.counted,
    cursor = state.entryCursor;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each chunk resumes from the previous chunk's budget; inherently sequential.
    const remaining = await transactionReadRemaining(ctx);
    if (remaining !== null && remaining < BACKFILL_BYTE_RESERVE) {
      return { complete: false, counted, entryCursor: cursor };
    }
    // oxlint-disable-next-line no-await-in-loop -- each chunk resumes from the previous chunk's cursor; inherently sequential.
    const { continueCursor, isDone, page } = await paginateEntriesBySchema(
      ctx,
      schemaId,
      cursor,
      Math.max(
        1,
        Math.min(
          BACKFILL_CHUNK_ROWS,
          remaining === null
            ? BACKFILL_CHUNK_ROWS
            : Math.floor((remaining - BACKFILL_BYTE_RESERVE) / DELETE_ROW_BYTE_ESTIMATE),
        ),
      ),
      "asc",
    );
    counted += page.length;
    cursor = continueCursor === "" ? null : continueCursor;
    if (isDone) {
      return { complete: true, counted, entryCursor: null };
    }
  }
}

/** The shared drain behind `backfillDatasetSummaries` and its scheduled continuation: stamps membership kinds (first hop only), then walks schemas in creation order, counting and patching each until done or out of budget. */
async function runBackfillHops(
  ctx: MutationCtx,
  state: BackfillState,
  stampMemberships: boolean,
): Promise<BackfillState & { done: boolean }> {
  const s: BackfillState = { ...state };
  if (stampMemberships) {
    const memberships = await ctx.db.query("schemaCollections").collect();
    await Promise.all(
      memberships.map(async (row) => {
        if (row.kind !== undefined) {
          return;
        }
        const schemaDoc = await ctx.db.get(row.schemaId);
        if (!schemaDoc) {
          return;
        }
        await ctx.db.patch(row._id, { kind: schemaDoc.kind ?? "standard" });
        s.membershipsPatched += 1;
      }),
    );
  }
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each hop resumes from the previous hop's budget; inherently sequential.
    const remaining = await transactionReadRemaining(ctx);
    if (remaining !== null && remaining < BACKFILL_BYTE_RESERVE) {
      return { ...s, done: false };
    }
    if (s.schemaId === null) {
      // oxlint-disable-next-line no-await-in-loop -- see above.
      const [next] = await ctx.db
        .query("schemas")
        .withIndex("by_creation_time", (q) => q.gt("_creationTime", s.schemaCreationTime))
        .take(1);
      if (next === undefined) {
        return { ...s, done: true };
      }
      s.schemaId = next._id;
      s.schemaCreationTime = next._creationTime;
      // Pre-read the stored count so the patch below only lands on drift.
      s.counted = 0;
      s.entryCursor = null;
    }
    // One doc read per schema visit; a resuming visit re-reads it the same way.
    // oxlint-disable-next-line no-await-in-loop -- one schema per hop stretch; inherently sequential.
    const schemaDoc = await ctx.db.get(s.schemaId);
    if (schemaDoc === null) {
      // Deleted mid-backfill — move on.
      s.schemaId = null;
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one schema per hop stretch; inherently sequential.
    const count = await countSchemaEntries(ctx, s.schemaId, {
      counted: s.counted,
      entryCursor: s.entryCursor,
    });
    s.counted = count.counted;
    s.entryCursor = count.entryCursor;
    if (!count.complete) {
      return { ...s, done: false };
    }
    if (schemaDoc.entryCount !== s.counted) {
      // oxlint-disable-next-line no-await-in-loop -- see above.
      await ctx.db.patch(s.schemaId, { entryCount: s.counted });
      s.schemasPatched += 1;
    }
    s.schemaId = null;
  }
}

/** Continuation hop for `backfillDatasetSummaries` (issue #128): resumes the schema walk at the given state until done. */
export const backfillDatasetSummariesStep = internalMutation({
  args: {
    counted: v.number(),
    entryCursor: v.union(v.string(), v.null()),
    membershipsPatched: v.number(),
    schemaCreationTime: v.number(),
    schemaId: v.union(v.id("schemas"), v.null()),
    schemasPatched: v.number(),
  },
  handler: async (ctx, args) => {
    const { done, ...state } = await runBackfillHops(
      ctx,
      {
        counted: args.counted,
        entryCursor: args.entryCursor,
        membershipsPatched: args.membershipsPatched,
        schemaCreationTime: args.schemaCreationTime,
        schemaId: args.schemaId,
        schemasPatched: args.schemasPatched,
      },
      false,
    );
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.entries.backfillDatasetSummariesStep, state);
    }
  },
  returns: v.null(),
});

/**
 * Public (not internal) so a host app can wrap it — component internals are
 * only reachable inside the component. Hosts should put their own auth gate
 * in front, as `app/convex/schemas.ts` does.
 */
export const backfillDatasetSummaries = mutation({
  args: {},
  handler: async (ctx) => {
    const { done, membershipsPatched, schemasPatched, ...rest } = await runBackfillHops(
      ctx,
      {
        counted: 0,
        entryCursor: null,
        membershipsPatched: 0,
        schemaCreationTime: -1,
        schemaId: null,
        schemasPatched: 0,
      },
      true,
    );
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.entries.backfillDatasetSummariesStep, {
        ...rest,
        membershipsPatched,
        schemasPatched,
      });
    }
    return { membershipsPatched, schemasPatched };
  },
  returns: v.object({ membershipsPatched: v.number(), schemasPatched: v.number() }),
});
