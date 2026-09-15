import { WorkflowManager } from "@convex-dev/workflow";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { extractPointGeometry } from "../shared/coordinate-columns.js";
import { isGeometryCompatibleWithDatasetType } from "../shared/geojson/coalesce.js";
import { GeoParseError, GeometryError } from "../shared/geojson/error.js";
import { unionBbox } from "../shared/geojson/geometry.js";
import type { BoundingBox } from "../shared/geojson/geometry.js";
import type { Geometry } from "../shared/geojson/types.js";
import { geometryTypeValidator } from "../shared/geojson/validators.js";
import type { GeometryTypeArg } from "../shared/geojson/validators.js";
import { extractReferences } from "../shared/reference.js";
import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
  inlineGeometryFieldsOrThrow,
  parseAndValidateGeometry,
  resolveGeometryStorage,
} from "./geometry_storage.js";
import type { ResolvedGeometry } from "./geometry_storage.js";
import schema from "./schema.js";

const SCHEMA_SIZE_LIMIT = 102_400, // 100 KB
  // Durable workflow engine (nested component) that drives batched imports.
  workflow = new WorkflowManager(components.workflow),
  collectionValidator = schema.tables.collections.validator.extend({
    _creationTime: v.number(),
    _id: v.id("collections"),
  }),
  groupValidator = schema.tables.groups.validator.extend({
    _creationTime: v.number(),
    _id: v.id("groups"),
  }),
  schemaValidator = schema.tables.schemas.validator.extend({
    _creationTime: v.number(),
    _id: v.id("schemas"),
  }),
  entryValidator = schema.tables.entries.validator.extend({
    _creationTime: v.number(),
    _id: v.id("entries"),
  }),
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
  // The fields a resolved geometry carries through the bulk-import path,
  // once `import_prep.ts` has already validated it and decided inline vs.
  // file storage — see `geometry_storage.ts`'s `ResolvedGeometry`.
  resolvedGeometryValidator = v.object({
    bbox: v.optional(v.array(v.number())),
    geometryJson: v.optional(v.string()),
    geometryStorageId: v.optional(v.id("_storage")),
    type: geometryTypeValidator,
  }),
  entryReferenceValidator = v.object({
    fieldName: v.string(),
    sourceEntry: entryValidator,
    sourceSchemaId: v.id("schemas"),
  });

// Schema queries

export const listSchemas = query({
  args: {},
  handler: async (ctx) => ctx.db.query("schemas").order("desc").collect(),
  returns: v.array(schemaValidator),
});

export const getSchema = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => ctx.db.get(args.schemaId),
  returns: v.union(v.null(), schemaValidator),
});

// Schema mutations

/** Throws unless a `kind`/`geometryType` pair is a valid combination for a schema doc. */
function assertKindAndGeometryType(
  kind: "standard" | "geospatial" | undefined,
  geometryType: GeometryTypeArg | undefined,
): void {
  if (kind === "geospatial" && geometryType === undefined) {
    throw new ConvexError("A geospatial dataset must specify a geometryType.");
  }
  if (kind !== "geospatial" && geometryType !== undefined) {
    throw new ConvexError("A standard dataset cannot specify a geometryType.");
  }
}

export const createSchema = mutation({
  args: {
    geometryType: v.optional(geometryTypeValidator),
    kind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    schema: v.any(),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    if (!args.schema.title || !args.schema.description) {
      throw new ConvexError("Schema must have 'title' and 'description' properties");
    }

    assertKindAndGeometryType(args.kind, args.geometryType);

    const schemaStr = JSON.stringify(args.schema);
    if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
      throw new ConvexError("Schema exceeds the 100 KB size limit.");
    }

    if (args.uiSchema !== undefined) {
      const uiSchemaStr = JSON.stringify(args.uiSchema);
      if (uiSchemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("UI Schema exceeds the 100 KB size limit.");
      }
    }

    const schemaId = await ctx.db.insert("schemas", {
      boundingBox: undefined,
      description: args.schema.description,
      featureCount: args.kind === "geospatial" ? 0 : undefined,
      geometryType: args.geometryType,
      kind: args.kind,
      schema: args.schema,
      title: args.schema.title,
      uiSchema: args.uiSchema,
    });

    return schemaId;
  },
  returns: v.id("schemas"),
});

export const updateSchema = mutation({
  args: {
    description: v.optional(v.string()),
    schema: v.optional(v.any()),
    schemaId: v.id("schemas"),
    title: v.optional(v.string()),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    const patch: Record<string, unknown> = {};

    if (args.schema === undefined) {
      if (args.title !== undefined) {
        patch.title = args.title;
      }
      if (args.description !== undefined) {
        patch.description = args.description;
      }
    } else {
      if (!args.schema.title || !args.schema.description) {
        throw new ConvexError("Schema must have 'title' and 'description' properties");
      }
      const schemaStr = JSON.stringify(args.schema);
      if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("Schema exceeds the 100 KB size limit.");
      }
      patch.schema = args.schema;
      patch.title = args.schema.title;
      patch.description = args.schema.description;
    }

    if (args.uiSchema !== undefined) {
      const uiSchemaStr = JSON.stringify(args.uiSchema);
      if (uiSchemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("UI Schema exceeds the 100 KB size limit.");
      }
      patch.uiSchema = args.uiSchema;
    }

    await ctx.db.patch(args.schemaId, patch);
  },
});

export const deleteSchema = mutation({
  args: {
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    // Delete all entries and geometries associated with this schema first
    const [entries, geometries] = await Promise.all([
      ctx.db
        .query("entries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
      ctx.db
        .query("geometries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
    ]);

    await Promise.all([
      ...entries.map(async (entry) => ctx.db.delete(entry._id)),
      ...geometries.map(async (geometry) => {
        await ctx.db.delete(geometry._id);
        await deleteGeometryStorageIfAny(ctx, geometry);
      }),
      deleteReferencesForSchema(ctx, args.schemaId),
    ]);

    await ctx.db.delete(args.schemaId);
  },
});

// Collection queries

export const listCollections = query({
  args: {},
  handler: async (ctx) => ctx.db.query("collections").order("desc").collect(),
  returns: v.array(collectionValidator),
});

export const getCollection = query({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) => ctx.db.get(args.collectionId),
  returns: v.union(v.null(), collectionValidator),
});

// Collection mutations

export const createCollection = mutation({
  args: {
    description: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) {
      throw new ConvexError("Collection must have a name");
    }
    return ctx.db.insert("collections", { description: args.description, name: args.name });
  },
  returns: v.id("collections"),
});

export const updateCollection = mutation({
  args: {
    collectionId: v.id("collections"),
    description: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.collectionId);
    if (!existing) {
      throw new ConvexError("Collection not found");
    }
    if (args.name !== undefined && !args.name.trim()) {
      throw new ConvexError("Collection must have a name");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.collectionId, patch);
  },
});

/**
 * Deletes a collection along with every group inside it. Datasets that
 * belonged to it (directly or via one of its groups) are not deleted — they
 * simply become uncategorized again (`collectionId`/`groupId` cleared).
 */
export const deleteCollection = mutation({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.collectionId);
    if (!existing) {
      throw new ConvexError("Collection not found");
    }

    const [groups, datasets] = await Promise.all([
      ctx.db
        .query("groups")
        .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
        .collect(),
      ctx.db
        .query("schemas")
        .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
        .collect(),
    ]);

    await Promise.all([
      ...groups.map(async (group) => ctx.db.delete(group._id)),
      ...datasets.map(async (dataset) =>
        ctx.db.patch(dataset._id, { collectionId: undefined, groupId: undefined }),
      ),
    ]);

    await ctx.db.delete(args.collectionId);
  },
});

// Group queries

export const listGroups = query({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) =>
    ctx.db
      .query("groups")
      .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
      .collect(),
  returns: v.array(groupValidator),
});

export const getGroup = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => ctx.db.get(args.groupId),
  returns: v.union(v.null(), groupValidator),
});

// Group mutations

export const createGroup = mutation({
  args: {
    collectionId: v.id("collections"),
    description: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) {
      throw new ConvexError("Group must have a name");
    }
    const collection = await ctx.db.get(args.collectionId);
    if (!collection) {
      throw new ConvexError("Collection not found");
    }
    return ctx.db.insert("groups", {
      collectionId: args.collectionId,
      description: args.description,
      name: args.name,
    });
  },
  returns: v.id("groups"),
});

export const updateGroup = mutation({
  args: {
    description: v.optional(v.string()),
    groupId: v.id("groups"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.groupId);
    if (!existing) {
      throw new ConvexError("Group not found");
    }
    if (args.name !== undefined && !args.name.trim()) {
      throw new ConvexError("Group must have a name");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.groupId, patch);
  },
});

/**
 * Deletes a group. Its datasets are not deleted — they fall back to being
 * directly in the group's collection (ungrouped), since `collectionId` is
 * left untouched.
 */
export const deleteGroup = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.groupId);
    if (!existing) {
      throw new ConvexError("Group not found");
    }

    const datasets = await ctx.db
      .query("schemas")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .collect();

    await Promise.all(
      datasets.map(async (dataset) => ctx.db.patch(dataset._id, { groupId: undefined })),
    );

    await ctx.db.delete(args.groupId);
  },
});

// Dataset <-> collection/group association

export const listSchemasByCollection = query({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) =>
    ctx.db
      .query("schemas")
      .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
      .collect(),
  returns: v.array(schemaValidator),
});

/**
 * Sets (or clears, via `null`) a dataset's top-level collection. Always
 * clears `groupId` too — a dataset moved directly under a collection is no
 * longer inside whichever group it may have belonged to.
 */
export const setSchemaCollection = mutation({
  args: {
    collectionId: v.union(v.id("collections"), v.null()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    if (args.collectionId === null) {
      await ctx.db.patch(args.schemaId, { collectionId: undefined, groupId: undefined });
      return;
    }

    const collection = await ctx.db.get(args.collectionId);
    if (!collection) {
      throw new ConvexError("Collection not found");
    }
    await ctx.db.patch(args.schemaId, { collectionId: args.collectionId, groupId: undefined });
  },
});

/**
 * Sets (or clears, via `null`) a dataset's group. Setting a group always
 * derives `collectionId` from the group itself, so a dataset can never end up
 * in a group without also being in that group's collection. Clearing the
 * group leaves `collectionId` as-is — the dataset falls back to being
 * directly in the collection rather than being removed from it.
 */
export const setSchemaGroup = mutation({
  args: {
    groupId: v.union(v.id("groups"), v.null()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    if (args.groupId === null) {
      await ctx.db.patch(args.schemaId, { groupId: undefined });
      return;
    }

    const group = await ctx.db.get(args.groupId);
    if (!group) {
      throw new ConvexError("Group not found");
    }
    await ctx.db.patch(args.schemaId, { collectionId: group.collectionId, groupId: args.groupId });
  },
});

// Entry queries

export const listEntries = query({
  args: { schemaId: v.id("schemas") },
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
      .collect();
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

// Convex caps a single query execution at reading ~16 MiB total across every
// document it touches — independent of, and much larger than, the ~900 KB
// per-document `INLINE_GEOMETRY_BYTE_LIMIT` a single `geometries` row can
// carry. A dataset with hundreds of rows near that inline limit can still
// blow the 16 MiB *cumulative* budget in one unpaginated `.collect()`, even
// though every individual row is safely under its own limit.
//
// `listGeometries` pages through results manually — `.withIndex(...).gt(
// "_creationTime", cursor).take(n)` — rather than using Convex's own
// `.paginate()`: components cannot call `.paginate()` at all ("paginate()
// is only supported in the app" — confirmed against a real deployment, not
// just a doc comment; see `paginateGeometriesBySchema`'s doc comment), so
// there's no `maximumBytesRead` safety net available here. Instead, the
// page size itself is capped low enough that even the worst case (every row
// at the maximum possible inline size) stays safely under budget.
const MAX_GEOMETRY_PAGE_ROWS = 8; // 8 * ~900 KB (INLINE_GEOMETRY_BYTE_LIMIT) ≈ 7.2 MB — safely under Convex's ~16 MiB per-execution read cap, with room for the schema-existence read and per-document overhead sharing the same execution.

/** One `geometries` row, as read directly off `ctx.db` (before `resolveGeometryOutput` normalizes it). */
interface GeometryDbRow {
  _creationTime: number;
  _id: Id<"geometries">;
  bbox?: number[];
  entryId: Id<"entries">;
  geometry?: unknown;
  geometryJson?: string;
  geometryStorageId?: Id<"_storage">;
  schemaId: Id<"schemas">;
  type: GeometryTypeArg;
}

/**
 * Manual cursor-based pagination over one schema's `geometries` rows.
 * Convex components cannot call `.paginate()` — confirmed at push time
 * against a real deployment ("paginate() is only supported in the app"),
 * not merely a documented restriction — so this hand-rolls the same shape
 * `.paginate()` would produce (`{page, isDone, continueCursor}`) using a
 * plain bounded index read instead. The cursor is just the last-returned
 * row's `_creationTime` (the index's implicit trailing sort key); resuming
 * means `.gt("_creationTime", cursor)` on the same index range.
 *
 * `numItems` is honored only up to `MAX_GEOMETRY_PAGE_ROWS` — never more,
 * regardless of what the caller requests — since a larger page could itself
 * exceed Convex's per-execution read budget (any single row can be up to
 * `INLINE_GEOMETRY_BYTE_LIMIT`, ~900 KB).
 */
async function paginateGeometriesBySchema(
  ctx: QueryCtx,
  schemaId: Id<"schemas">,
  paginationOpts: { cursor: string | null; numItems: number },
): Promise<{ continueCursor: string; isDone: boolean; page: GeometryDbRow[] }> {
  const afterCreationTime =
    paginationOpts.cursor === null || paginationOpts.cursor === ""
      ? undefined
      : Number(paginationOpts.cursor);
  if (afterCreationTime !== undefined && !Number.isFinite(afterCreationTime)) {
    throw new ConvexError("Invalid pagination cursor.");
  }

  const limit = Math.max(1, Math.min(paginationOpts.numItems, MAX_GEOMETRY_PAGE_ROWS)),
    page = await ctx.db
      .query("geometries")
      .withIndex("by_schema", (q) =>
        afterCreationTime === undefined
          ? q.eq("schemaId", schemaId)
          : q.eq("schemaId", schemaId).gt("_creationTime", afterCreationTime),
      )
      .order("asc")
      .take(limit);

  const lastRow = page[page.length - 1];
  return {
    // A short page (or an empty one) means we've reached the end of this
    // schema's rows; an exactly-full page might or might not be the end —
    // treat it as "not done" so the next call (which will come back empty)
    // is the one that actually confirms it, rather than guessing here.
    continueCursor: lastRow === undefined ? (paginationOpts.cursor ?? "") : String(lastRow._creationTime),
    isDone: page.length < limit,
    page,
  };
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

/** The `_id`s of every geospatial dataset directly or (via a group) indirectly in a collection. */
async function listGeospatialSchemaIdsByCollection(ctx: QueryCtx, collectionId: Id<"collections">) {
  const schemas = await ctx.db
    .query("schemas")
    .withIndex("by_collection", (q) => q.eq("collectionId", collectionId))
    .collect();
  return schemas.filter((schemaDoc) => schemaDoc.kind === "geospatial").map((s) => s._id);
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
 */
export const listEntriesByCollection = query({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) => {
    const schemaIds = await listGeospatialSchemaIdsByCollection(ctx, args.collectionId),
      rows = await Promise.all(
        schemaIds.map(async (schemaId) =>
          ctx.db
            .query("entries")
            .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
            .collect(),
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
 */
export const listEntriesForSchemas = query({
  args: { schemaIds: v.array(v.id("schemas")) },
  handler: async (ctx, args) => {
    const unique = [...new Set(args.schemaIds)],
      rows = await Promise.all(
        unique.map(async (schemaId) =>
          ctx.db
            .query("entries")
            .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
            .collect(),
        ),
      );
    return rows.flat();
  },
  returns: v.array(entryValidator),
});

/**
 * Reverse lookup: every other dataset's entry that currently references
 * `entryId`, via the `references` index (see schema.ts) — an indexed
 * lookup rather than a scan of every other dataset's entries.
 */
export const listReferencingEntries = query({
  args: { entryId: v.id("entries") },
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
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
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

// Entry mutations
//
// Geometry is never stored inline on `entries` — only a pointer
// (`geometryId`) plus a denormalized `geometryType` string live there. The
// heavy coordinate payload lives in the `geometries` table (see schema.ts),
// so reading a page of entries (the properties table) never pulls full
// geometries along for the ride. Every mutation below that adds/replaces/
// removes a geometry also keeps the owning schema's denormalized
// `featureCount`/`boundingBox` summary up to date (see schema.ts for the
// exact contract on each field).
//
// A geometry argument is always a JSON *string* here, never the nested-array
// `Geometry` shape directly — see geometry_storage.ts's doc comment for why
// (Convex's 8192-elements-per-array limit, which real-world GIS rings
// routinely exceed).

/** Deletes a geometry row's external storage blob, if it has one. No-ops otherwise — safe to call on a row about to be deleted or replaced. */
async function deleteGeometryStorageIfAny(
  ctx: MutationCtx,
  geometryDoc: { geometryStorageId?: Id<"_storage"> } | null,
): Promise<void> {
  if (geometryDoc && geometryDoc.geometryStorageId !== undefined) {
    await ctx.storage.delete(geometryDoc.geometryStorageId);
  }
}

/**
 * Validates a JSON-string geometry argument against the schema doc's
 * `kind`/`geometryType`, and resolves it to the fields a `geometries` row
 * needs. Returns `undefined` when no geometry was provided.
 *
 * Only called from plain mutations, which can't write to file storage — a
 * geometry whose JSON text is too large to store inline is rejected with a
 * clear error rather than silently dropped or truncated; the caller is
 * expected to use the bulk import flow instead (`startImport`), whose
 * action-backed prep step (`import_prep.ts`) can fall back to file storage.
 */
function validateEntryGeometry(
  geometryJsonArg: string | undefined,
  schemaDoc: { kind?: "standard" | "geospatial"; geometryType?: GeometryTypeArg },
): ResolvedGeometry | undefined {
  if (geometryJsonArg === undefined) {
    return undefined;
  }
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError("Cannot attach geometry to a standard dataset.");
  }
  let geometry: Geometry;
  try {
    geometry = parseAndValidateGeometry(geometryJsonArg);
  } catch (err) {
    if (err instanceof GeometryError || err instanceof GeoParseError) {
      throw new ConvexError(err.message);
    }
    throw err;
  }
  if (!isGeometryCompatibleWithDatasetType(geometry.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Geometry type "${geometry.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
  try {
    return inlineGeometryFieldsOrThrow(geometryJsonArg, geometry);
  } catch (err) {
    if (err instanceof GeometryError) {
      throw new ConvexError(err.message);
    }
    throw err;
  }
}

/**
 * `schemas.boundingBox` is a plain `v.array(v.number())` (Convex validators
 * can't express a fixed-length tuple), but every write to it always stores
 * exactly 4 numbers (see `applyGeometryStatsDelta`). This narrows the read
 * side back to the tuple shape `unionBbox` expects.
 */
function asBoundingBox(value: number[] | undefined): BoundingBox | undefined {
  if (value === undefined) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- always written as a 4-tuple by `applyGeometryStatsDelta`; the array validator can't express that statically.
  return value as BoundingBox;
}

/**
 * `resolvedGeometryValidator`'s `bbox` field is, like `schemas.boundingBox`
 * above, a plain `v.array(v.number())` (Convex validators can't express a
 * fixed-length tuple) — but it's always written as a 4-tuple by
 * `computeBbox`/`resolveGeometryStorage`. Narrows an already-resolved
 * geometry (as received from `insertEntriesChunkInternal`'s args) back to
 * the tuple-typed `ResolvedGeometry` shape the rest of this module uses.
 */
function asResolvedGeometry(value: {
  bbox?: number[];
  geometryJson?: string;
  geometryStorageId?: Id<"_storage">;
  type: GeometryTypeArg;
}): ResolvedGeometry {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    bbox: value.bbox as BoundingBox | undefined,
    geometryJson: value.geometryJson,
    geometryStorageId: value.geometryStorageId,
    type: value.type,
  };
}

/**
 * Folds a geometry add/remove/replace into a schema doc's denormalized
 * `featureCount`/`boundingBox` summary and patches it. `featureCount` is
 * kept exactly accurate (clamped at 0). `boundingBox` only ever grows (via
 * `unionBbox`) — see the field's doc comment in schema.ts for why deletes
 * don't shrink it back down.
 */
async function applyGeometryStatsDelta(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: { featureCount?: number; boundingBox?: number[] },
  countDelta: number,
  newBbox: BoundingBox | undefined,
): Promise<void> {
  const featureCount = Math.max(0, (schemaDoc.featureCount ?? 0) + countDelta),
    boundingBox = unionBbox(asBoundingBox(schemaDoc.boundingBox), newBbox);
  await ctx.db.patch(schemaId, { boundingBox, featureCount });
}

/**
 * Inserts a `geometries` row for `entryId` and patches the entry's pointer
 * fields (`geometryId`/`geometryType`) to reference it. Returns the new
 * row's own bbox for the caller to fold into the schema's summary.
 */
async function attachGeometry(
  ctx: MutationCtx,
  entryId: Id<"entries">,
  schemaId: Id<"schemas">,
  resolved: ResolvedGeometry,
): Promise<BoundingBox | undefined> {
  const geometryId = await ctx.db.insert("geometries", {
    bbox: resolved.bbox,
    entryId,
    geometryJson: resolved.geometryJson,
    geometryStorageId: resolved.geometryStorageId,
    schemaId,
    type: resolved.type,
  });
  await ctx.db.patch(entryId, { geometryId, geometryType: resolved.type });
  return resolved.bbox;
}

/**
 * Deletes every `references` row for `schemaId`, on either side of the
 * pointer: rows sourced from one of this schema's own entries (gone with
 * the schema), and rows targeting one of its entries from some other
 * dataset's entry (which would otherwise dangle, pointing at a deleted
 * entry). A row can appear in both queries for a schema that
 * self-references, hence the de-dupe.
 */
async function deleteReferencesForSchema(ctx: MutationCtx, schemaId: Id<"schemas">): Promise<void> {
  const [asSource, asTarget] = await Promise.all([
    ctx.db
      .query("references")
      .withIndex("by_source_schema", (q) => q.eq("sourceSchemaId", schemaId))
      .collect(),
    ctx.db
      .query("references")
      .withIndex("by_target_schema", (q) => q.eq("targetSchemaId", schemaId))
      .collect(),
  ]);
  const seen = new Set<Id<"references">>();
  await Promise.all(
    [...asSource, ...asTarget]
      .filter((row) => {
        if (seen.has(row._id)) {
          return false;
        }
        seen.add(row._id);
        return true;
      })
      .map(async (row) => ctx.db.delete(row._id)),
  );
}

/** Same as {@link deleteReferencesForSchema}, scoped to a single entry (both as source and as target). */
async function deleteReferencesForEntry(ctx: MutationCtx, entryId: Id<"entries">): Promise<void> {
  const [asSource, asTarget] = await Promise.all([
    ctx.db
      .query("references")
      .withIndex("by_source_entry", (q) => q.eq("sourceEntryId", entryId))
      .collect(),
    ctx.db
      .query("references")
      .withIndex("by_target_entry", (q) => q.eq("targetEntryId", entryId))
      .collect(),
  ]);
  const seen = new Set<Id<"references">>();
  await Promise.all(
    [...asSource, ...asTarget]
      .filter((row) => {
        if (seen.has(row._id)) {
          return false;
        }
        seen.add(row._id);
        return true;
      })
      .map(async (row) => ctx.db.delete(row._id)),
  );
}

/**
 * Re-derives an entry's outgoing `references` rows from its current `data`
 * against its schema's reference fields (see ../shared/reference.ts).
 * Simplest-correct approach: wipe this entry's existing rows and reinsert
 * from scratch, rather than diffing — a dataset entry only ever has a
 * handful of reference fields, so this is cheap and can't drift.
 *
 * A referenced id that doesn't normalize to a real `entries`/`schemas` id,
 * or whose target entry doesn't actually belong to the declared target
 * schema, is silently skipped — a stale/malformed reference in `data`
 * (e.g. the target entry was since deleted) shouldn't block saving the
 * source entry.
 */
async function syncEntryReferences(
  ctx: MutationCtx,
  entryId: Id<"entries">,
  sourceSchemaId: Id<"schemas">,
  schemaDoc: { schema: unknown },
  data: unknown,
): Promise<void> {
  const existing = await ctx.db
    .query("references")
    .withIndex("by_source_entry", (q) => q.eq("sourceEntryId", entryId))
    .collect();
  await Promise.all(existing.map(async (row) => ctx.db.delete(row._id)));

  await Promise.all(
    extractReferences(schemaDoc.schema, data).map(async (ref) => {
      const targetSchemaId = ctx.db.normalizeId("schemas", ref.targetSchemaId),
        targetEntryId = ctx.db.normalizeId("entries", ref.targetEntryId);
      if (!targetSchemaId || !targetEntryId) {
        return;
      }
      const targetEntry = await ctx.db.get(targetEntryId);
      if (!targetEntry || targetEntry.schemaId !== targetSchemaId) {
        return;
      }
      await ctx.db.insert("references", {
        fieldName: ref.fieldName,
        sourceEntryId: entryId,
        sourceSchemaId,
        targetEntryId,
        targetSchemaId,
      });
    }),
  );
}

/**
 * One row's geometry argument, as accepted by `insertEntryBatch`: either a
 * raw JSON string awaiting validation (the single-entry mutation paths —
 * `createEntry`/`updateEntry`/`createEntriesBulk`), or an already-resolved
 * `ResolvedGeometry` (the bulk-import path, whose `import_prep.ts` action
 * already validated + resolved it before this ever runs in a mutation).
 */
type PendingGeometry = string | ResolvedGeometry;

function isResolvedGeometry(value: PendingGeometry): value is ResolvedGeometry {
  return typeof value !== "string";
}

/** Re-validates just the cheap part (dataset-kind/geometry-type compatibility) for an already-resolved geometry. The expensive structural validation already happened in `import_prep.ts`. */
function checkResolvedGeometryCompatible(
  resolved: ResolvedGeometry,
  schemaDoc: { kind?: "standard" | "geospatial"; geometryType?: GeometryTypeArg },
): void {
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError("Cannot attach geometry to a standard dataset.");
  }
  if (!isGeometryCompatibleWithDatasetType(resolved.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Geometry type "${resolved.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
}

/**
 * Inserts a batch of `{data, geometry?}` rows as entries, attaching a
 * `geometries` row for any row that has one, and folds the whole batch's
 * count-added/bbox-expansion into a single `schemas` patch at the end
 * (not one patch per row). Every row's geometry is validated up front, so
 * the whole batch fails atomically before any inserts happen if one is bad.
 * Returns the inserted entry ids in the same order as `rows`.
 */
async function insertEntryBatch(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: {
    schema: unknown;
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    featureCount?: number;
    boundingBox?: number[];
  },
  rows: Array<{ data: unknown; geometry?: PendingGeometry }>,
): Promise<Array<Id<"entries">>> {
  const resolvedGeometries = rows.map((row) => {
    if (row.geometry === undefined) {
      return undefined;
    }
    if (isResolvedGeometry(row.geometry)) {
      checkResolvedGeometryCompatible(row.geometry, schemaDoc);
      return row.geometry;
    }
    return validateEntryGeometry(row.geometry, schemaDoc);
  });

  let addedCount = 0,
    unionedBbox: BoundingBox | undefined;

  const ids = await Promise.all(
    rows.map(async ({ data }, i) => {
      const entryId = await ctx.db.insert("entries", { data, schemaId }),
        resolved = resolvedGeometries[i];
      if (resolved !== undefined) {
        const bbox = await attachGeometry(ctx, entryId, schemaId, resolved);
        addedCount += 1;
        unionedBbox = unionBbox(unionedBbox, bbox);
      }
      await syncEntryReferences(ctx, entryId, schemaId, schemaDoc, data);
      return entryId;
    }),
  );

  if (addedCount > 0) {
    await applyGeometryStatsDelta(ctx, schemaId, schemaDoc, addedCount, unionedBbox);
  }

  return ids;
}

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
  if (existing.geometryId !== undefined) {
    const [schemaDoc, geometryDoc] = await Promise.all([
      ctx.db.get(existing.schemaId),
      ctx.db.get(existing.geometryId),
    ]);
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

/**
 * Replaces (or newly attaches) an entry's geometry with `resolved`. Patches
 * the existing `geometries` row in place when the entry already had one
 * (no `featureCount` change, since this is a replace, not an add) —
 * clearing whichever of `geometryJson`/`geometryStorageId` the new value
 * *doesn't* use, and deleting the old row's external storage blob (if it had
 * one) now that it's no longer referenced; otherwise attaches a new row and
 * increments `featureCount`. Either way expands the schema's `boundingBox`.
 */
async function replaceEntryGeometry(
  ctx: MutationCtx,
  entry: { _id: Id<"entries">; schemaId: Id<"schemas">; geometryId?: Id<"geometries"> },
  schemaDoc: { featureCount?: number; boundingBox?: number[] },
  resolved: ResolvedGeometry,
): Promise<void> {
  if (entry.geometryId !== undefined) {
    const existing = await ctx.db.get(entry.geometryId);
    await ctx.db.patch(entry.geometryId, {
      bbox: resolved.bbox,
      geometry: undefined,
      geometryJson: resolved.geometryJson,
      geometryStorageId: resolved.geometryStorageId,
      type: resolved.type,
    });
    await ctx.db.patch(entry._id, { geometryType: resolved.type });
    await deleteGeometryStorageIfAny(ctx, existing);
    await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, 0, resolved.bbox);
    return;
  }
  const bbox = await attachGeometry(ctx, entry._id, entry.schemaId, resolved);
  await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, 1, bbox);
}

export const createEntry = mutation({
  args: {
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

    const [entryId] = await insertEntryBatch(ctx, args.schemaId, schemaDoc, [
      { data: args.data, geometry: args.geometry },
    ]);

    return entryId;
  },
  returns: v.id("entries"),
});

export const createEntriesBulk = mutation({
  args: {
    entries: v.array(v.object({ data: v.any(), geometry: v.optional(v.string()) })),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    return insertEntryBatch(ctx, args.schemaId, schemaDoc, args.entries);
  },
  returns: v.array(v.id("entries")),
});

export const updateEntry = mutation({
  args: {
    data: v.any(),
    entryId: v.id("entries"),
    geometry: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    await ctx.db.patch(args.entryId, { data: args.data });

    const schemaDoc = await ctx.db.get(existing.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
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
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    await deleteEntryCascading(ctx, args.entryId);
  },
});

export const deleteEntriesBySchema = mutation({
  args: {
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    const [entries, geometries] = await Promise.all([
      ctx.db
        .query("entries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
      ctx.db
        .query("geometries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
    ]);

    await Promise.all([
      ...entries.map(async (entry) => ctx.db.delete(entry._id)),
      ...geometries.map(async (geometry) => {
        await ctx.db.delete(geometry._id);
        await deleteGeometryStorageIfAny(ctx, geometry);
      }),
      deleteReferencesForSchema(ctx, args.schemaId),
    ]);

    // The whole dataset's entries/geometries are gone, so — unlike a single
    // entry delete — the exact reset (rather than only-grow) is safe here.
    await ctx.db.patch(args.schemaId, {
      boundingBox: undefined,
      featureCount: schemaDoc.kind === "geospatial" ? 0 : undefined,
    });

    return entries.length;
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

// ---------------------------------------------------------------------------
// Batched, monitored dataset import
//
// Convex COMPONENTS cannot use the Node.js runtime (`"use node"` is an
// app-layer-only capability — components must stay portable/sandboxable),
// so no step running inside this component can ever safely download +
// `JSON.parse` a multi-tens-of-MB upload in one shot (the default action
// runtime caps out around 64 MB). Rather than doing that parse on the
// server at all, the CLIENT — which already fully parses the entire file
// in the browser for schema inference/validation before it ever calls
// `startImport` — splits the row payload into several already-small chunks
// itself (see `chunkRowsForImport` in the `react` package) and uploads each
// to its own storage blob via repeated `generateUploadUrl` + `fetch` POSTs.
//
// `startImport` then just records the resulting list of chunk storage ids
// and kicks off a durable workflow that, for each one, runs
// `insertChunkFromStorage` — an action that downloads ONE already-small
// chunk (safe in the default runtime), validates + resolves each row's
// geometry (inline vs. file storage — see `geometry_storage.ts`), and
// inserts it. No step ever holds more than one chunk's worth of data, and
// no geometry's coordinate payload ever crosses a Convex value boundary (a
// mutation argument or a document field) as a nested array larger than
// Convex's 8192-elements-per-array limit — it's always JSON text.
//
// Trade-off versus a single-pass, whole-import validation: since chunks are
// inserted as their step runs (not validated-then-committed atomically
// across the whole import), a bad row in a later chunk can leave earlier
// chunks already committed. This matches the pre-existing behavior before
// this file's `geometryJson`/`geometryStorageId` rework and is an accepted,
// documented trade-off of components being unable to use Node.
// ---------------------------------------------------------------------------

const importValidator = schema.tables.imports.validator.extend({
  _creationTime: v.number(),
  _id: v.id("imports"),
});

/** Generate a short-lived URL the client POSTs one chunk of serialized rows to. Called once per chunk. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
  returns: v.string(),
});

/** Read the import status doc (client subscribes to this for progress). */
export const getImportStatus = query({
  args: { importId: v.id("imports") },
  handler: async (ctx, args) => ctx.db.get(args.importId),
  returns: v.union(importValidator, v.null()),
});

/**
 * Create the status doc and start the durable import workflow. `storageIds`
 * is the ordered list of already-small, client-uploaded chunk blobs (see the
 * doc comment above) — each one gets its own `insertChunkFromStorage` step.
 */
export const startImport = mutation({
  args: {
    schemaId: v.id("schemas"),
    storageIds: v.array(v.id("_storage")),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const targetSchema = await ctx.db.get(args.schemaId);
    if (!targetSchema) {
      throw new ConvexError("Schema not found");
    }

    const importId = await ctx.db.insert("imports", {
        processed: 0,
        schemaId: args.schemaId,
        status: "pending",
        storageIds: args.storageIds,
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.lib.importWorkflow,
        {
          importId,
          schemaId: args.schemaId,
          storageIds: args.storageIds,
          total: args.total,
        },
        {
          // Carried through to `handleImportComplete` so a failed/canceled
          // import's not-yet-processed chunk blobs get cleaned up too (each
          // chunk deletes its own blob on success, inside the loop below).
          context: { importId, storageIds: args.storageIds },
          onComplete: internal.lib.handleImportComplete,
          startAsync: true,
        },
      );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
  returns: v.id("imports"),
});

/**
 * Best-effort delete of a storage blob referenced by a plain string id (the
 * form workflow steps pass storage ids in — see `insertChunkFromStorage`).
 * Swallows "already gone" rather than failing an otherwise-successful import
 * over cleanup.
 */
async function tryDeleteStorage(ctx: MutationCtx, storageId: string): Promise<void> {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see callers for why storage ids travel as plain strings here.
    await ctx.storage.delete(storageId as Id<"_storage">);
  } catch {
    // Already deleted, or never existed — fine, this is best-effort cleanup.
  }
}

/**
 * Runs after the import workflow finishes. On success every chunk already
 * deleted its own blob as it was consumed; here we only need to record
 * failures/cancels, and best-effort delete any chunk blobs the workflow
 * never got to (a failed/canceled import may have stopped partway through
 * `storageIds`) — deleting an already-consumed blob is a harmless no-op
 * (see `tryDeleteStorage`).
 */
export const handleImportComplete = internalMutation({
  args: {
    context: v.any(),
    result: v.any(),
    workflowId: v.string(),
  },
  handler: async (ctx, args) => {
    const result = args.result,
      context: unknown = args.context,
      importId =
        context && typeof context === "object" && "importId" in context
          ? (context as { importId?: unknown }).importId
          : undefined,
      storageIds =
        context && typeof context === "object" && "storageIds" in context
          ? (context as { storageIds?: unknown }).storageIds
          : undefined;

    if (result && result.kind === "success") {
      return;
    }

    if (Array.isArray(storageIds)) {
      await Promise.all(
        storageIds.map(async (id: unknown) => {
          if (typeof id === "string") {
            await tryDeleteStorage(ctx, id);
          }
        }),
      );
    }

    if (typeof importId !== "string") {
      return;
    }
    let error = "Import failed.";
    if (result && result.kind === "canceled") {
      error = "Import was canceled.";
    } else if (result && typeof result.error === "string") {
      error = result.error;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a string above; it's always the `Id<"imports">` `startImport` put into `context`.
    await ctx.db.patch(importId as Id<"imports">, { error, status: "failed" });
  },
});

/** Patch import progress/status. Called between workflow steps. */
export const updateImportProgress = internalMutation({
  args: {
    error: v.optional(v.string()),
    importId: v.id("imports"),
    processed: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.processed !== undefined) {
      patch.processed = args.processed;
    }
    if (args.status !== undefined) {
      patch.status = args.status;
    }
    if (args.error !== undefined) {
      patch.error = args.error;
    }
    await ctx.db.patch(args.importId, patch);
  },
});

/**
 * Validates one row's geometry (if any) against the schema's locked
 * `kind`/`geometryType`, and resolves it to inline-vs-storage form (see
 * `resolveGeometryStorage`). Shared by `insertChunkFromStorage`'s per-row
 * loop; extracted so that loop's own complexity stays manageable.
 */
async function resolveImportRowGeometry(
  ctx: { storage: { store(blob: Blob, options?: { sha256?: string }): Promise<Id<"_storage">> } },
  rowIndex: number,
  geometry: unknown,
  schemaDoc: { kind?: "standard" | "geospatial"; geometryType?: GeometryTypeArg },
): Promise<ResolvedGeometry> {
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError(`Row ${rowIndex}: cannot attach geometry to a standard dataset.`);
  }
  const geometryJson = JSON.stringify(geometry);
  let parsedGeometry: Geometry;
  try {
    parsedGeometry = parseAndValidateGeometry(geometryJson);
  } catch (err) {
    const message =
      err instanceof GeometryError || err instanceof GeoParseError ? err.message : "Invalid geometry.";
    throw new ConvexError(`Row ${rowIndex}: ${message}`);
  }
  if (!isGeometryCompatibleWithDatasetType(parsedGeometry.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Row ${rowIndex}: geometry type "${parsedGeometry.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
  return resolveGeometryStorage(ctx, parsedGeometry, geometryJson);
}

/**
 * Reads ONE already-small, client-uploaded chunk blob (raw `{data,
 * geometry?}[]` rows — see the module doc comment above for why chunking
 * happens client-side), validates + resolves each row's geometry, and
 * inserts the batch. Runs entirely in Convex's default action runtime — a
 * chunk is small enough by construction (see `chunkRowsForImport`) that this
 * never needs Node. Deletes its own chunk blob once the insert succeeds.
 * Runs as a workflow step so a failed chunk is retried in isolation.
 * Returns the number of rows inserted.
 */
export const insertChunkFromStorage = internalAction({
  args: {
    schemaId: v.id("schemas"),
    // A `_storage` id — passed as a plain string because system-table ids can't
    // Be journaled/validated as `v.id("_storage")` through the workflow engine.
    storageId: v.string(),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.runQuery(internal.lib.getSchemaInternal, {
      schemaId: args.schemaId,
    });
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- actions have no `normalizeId`; `storageId` is always a real `_storage` id, just untyped over the workflow boundary.
    const blob = await ctx.storage.get(args.storageId as Id<"_storage">);
    if (!blob) {
      throw new ConvexError("Import chunk not found in storage");
    }
    const parsed: unknown = JSON.parse(await blob.text()),
      rawRows = Array.isArray(parsed) ? parsed : [];

    const resolvedRows: Array<{ data: unknown; resolvedGeometry?: ResolvedGeometry }> = [];
    for (let i = 0; i < rawRows.length; i += 1) {
      const row = rawRows[i];
      if (typeof row !== "object" || row === null) {
        throw new ConvexError(`Row ${i} is not an object.`);
      }
      // The uploaded chunk is always `{ data, geometry? }[]` — validated below.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const { data, geometry } = row as { data: unknown; geometry?: unknown };
      if (geometry === undefined) {
        resolvedRows.push({ data });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- storage writes must land in row order; this loop is inherently sequential.
      const resolvedGeometry = await resolveImportRowGeometry(ctx, i, geometry, schemaDoc);
      resolvedRows.push({ data, resolvedGeometry });
    }

    if (resolvedRows.length > 0) {
      await ctx.runMutation(internal.lib.insertEntriesChunkInternal, {
        dataArray: resolvedRows,
        schemaId: args.schemaId,
      });
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    await ctx.storage.delete(args.storageId as Id<"_storage">);
    return resolvedRows.length;
  },
  returns: v.number(),
});

/**
 * Insert one pre-resolved batch of entries in a single transaction. Each
 * row's geometry was already structurally validated and resolved (inline
 * vs. file storage) by `insertChunkFromStorage` — this only re-checks the
 * cheap dataset-type-compatibility rule before writing.
 */
export const insertEntriesChunkInternal = internalMutation({
  args: {
    dataArray: v.array(
      v.object({ data: v.any(), resolvedGeometry: v.optional(resolvedGeometryValidator) }),
    ),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    await insertEntryBatch(
      ctx,
      args.schemaId,
      schemaDoc,
      args.dataArray.map((row) => ({
        data: row.data,
        geometry: row.resolvedGeometry === undefined ? undefined : asResolvedGeometry(row.resolvedGeometry),
      })),
    );
    return null;
  },
  returns: v.null(),
});

/** Durable workflow: insert each client-uploaded chunk in turn, updating progress as it goes. */
export const importWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    schemaId: v.id("schemas"),
    storageIds: v.array(v.string()), // `_storage` ids as strings (see insertChunkFromStorage)
    total: v.number(),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0;
    // Chunks run sequentially so memory stays bounded and progress lands
    // incrementally; parallelizing the steps would defeat both.
    for (const storageId of args.storageIds) {
      // oxlint-disable-next-line no-await-in-loop
      const inserted = await step.runAction(internal.lib.insertChunkFromStorage, {
        schemaId: args.schemaId,
        storageId,
      });
      processed += inserted;
      // oxlint-disable-next-line no-await-in-loop
      await step.runMutation(internal.lib.updateImportProgress, {
        importId: args.importId,
        processed,
      });
    }

    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed,
      status: "completed",
    });
  },
});

// ---------------------------------------------------------------------------
// Convert an already-imported "standard" dataset to geospatial in place,
// backfilling a Point geometry for every existing entry from two of its own
// data fields (e.g. "Latitude"/"Longitude" columns) — for a dataset like a
// TIGER export that already has coordinate columns but wasn't imported as
// GeoJSON. Reuses the same `imports` status doc / workflow-monitoring
// machinery as a fresh import (see the module doc comment above) so the
// client can show the same progress UI, even though no file upload is
// involved here — the coordinates already live in the entries' own `data`.
//
// A Point geometry's JSON text is always a few dozen bytes, nowhere near
// `INLINE_GEOMETRY_BYTE_LIMIT` — so unlike the general import path, this
// never needs file-storage fallback, which means every step here can be a
// plain mutation (no action needed just to reach `ctx.storage.store`).
// ---------------------------------------------------------------------------

const CONVERSION_BATCH_SIZE = 100; // Entries are thin (no geometry payload) — generous relative to MAX_GEOMETRY_PAGE_ROWS.

/** One `entries` row, as read directly off `ctx.db`. */
interface EntryDbRow {
  _creationTime: number;
  _id: Id<"entries">;
  data: unknown;
  geometryId?: Id<"geometries">;
  geometryType?: GeometryTypeArg;
  schemaId: Id<"schemas">;
}

/**
 * Manual cursor-based pagination over one schema's `entries` rows — the same
 * hand-rolled approach as `paginateGeometriesBySchema` (components can't call
 * `.paginate()`), sized for entries instead of geometries.
 */
async function paginateEntriesBySchema(
  ctx: QueryCtx,
  schemaId: Id<"schemas">,
  cursor: string | null,
  limit: number,
): Promise<{ continueCursor: string; isDone: boolean; page: EntryDbRow[] }> {
  const afterCreationTime = cursor === null || cursor === "" ? undefined : Number(cursor);
  if (afterCreationTime !== undefined && !Number.isFinite(afterCreationTime)) {
    throw new ConvexError("Invalid pagination cursor.");
  }

  const page = await ctx.db
    .query("entries")
    .withIndex("by_schema", (q) =>
      afterCreationTime === undefined
        ? q.eq("schemaId", schemaId)
        : q.eq("schemaId", schemaId).gt("_creationTime", afterCreationTime),
    )
    .order("asc")
    .take(limit);

  const lastRow = page[page.length - 1];
  return {
    continueCursor: lastRow === undefined ? (cursor ?? "") : String(lastRow._creationTime),
    isDone: page.length < limit,
    page,
  };
}

/**
 * Converts one page of a schema's entries: builds a Point geometry from
 * `data[latField]`/`data[lonField]` for each (via `extractPointGeometry`,
 * shared with the client-side coordinate-column picker), skipping any row
 * whose coordinates are missing/invalid rather than failing the whole batch
 * — a dataset backfilled this way commonly has some ungeocodable rows.
 * Reuses `replaceEntryGeometry` per row so `featureCount`/`boundingBox` stay
 * correct; re-reads the schema doc each time since it's patched every
 * iteration this same execution (reads see this transaction's own writes).
 */
export const convertEntriesBatchInternal = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const { page, isDone, continueCursor } = await paginateEntriesBySchema(
      ctx,
      args.schemaId,
      args.cursor,
      CONVERSION_BATCH_SIZE,
    );

    let geocoded = 0;
    for (const entry of page) {
      const point = extractPointGeometry(entry.data, args.latField, args.lonField);
      if (point === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- each iteration depends on the previous one's featureCount/boundingBox patch.
      const schemaDoc = await ctx.db.get(args.schemaId);
      if (!schemaDoc) {
        throw new ConvexError("Schema not found");
      }
      const resolved = inlineGeometryFieldsOrThrow(JSON.stringify(point), point);
      // oxlint-disable-next-line no-await-in-loop
      await replaceEntryGeometry(ctx, entry, schemaDoc, resolved);
      geocoded += 1;
    }

    return { continueCursor, examined: page.length, geocoded, isDone };
  },
  returns: v.object({
    continueCursor: v.string(),
    examined: v.number(),
    geocoded: v.number(),
    isDone: v.boolean(),
  }),
});

/** Durable workflow: convert a standard dataset's entries page by page, updating progress as it goes. */
export const geospatialConversionWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0,
      cursor: string | null = null,
      isDone = false;
    // Sequential for the same reason `importWorkflow` is: memory stays
    // bounded and progress lands incrementally as each page completes.
    while (!isDone) {
      // Explicitly typed (rather than inferred from the call) to avoid a
      // circular type reference: `internal.lib` is typed from this same
      // module, and `geospatialConversionWorkflow` — currently being
      // type-checked — is one of its exports.
      const result: { continueCursor: string; examined: number; geocoded: number; isDone: boolean } =
        // oxlint-disable-next-line no-await-in-loop
        await step.runMutation(internal.lib.convertEntriesBatchInternal, {
          cursor,
          latField: args.latField,
          lonField: args.lonField,
          schemaId: args.schemaId,
        });
      processed += result.examined;
      cursor = result.continueCursor;
      isDone = result.isDone;
      // oxlint-disable-next-line no-await-in-loop
      await step.runMutation(internal.lib.updateImportProgress, { importId: args.importId, processed });
    }

    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed,
      status: "completed",
    });
  },
});

/** The property names declared on a schema doc's JSON Schema, or `{}` if it's malformed/propertyless. */
function schemaPropertyNames(schemaDoc: { schema: unknown }): Record<string, unknown> {
  const { schema: jsonSchema } = schemaDoc;
  if (
    jsonSchema &&
    typeof jsonSchema === "object" &&
    "properties" in jsonSchema &&
    typeof jsonSchema.properties === "object" &&
    jsonSchema.properties !== null
  ) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the `typeof === "object"` check above; a JSON Schema's `properties` is always a plain object.
    return jsonSchema.properties as Record<string, unknown>;
  }
  return {};
}

/** Throws unless `latField`/`lonField` are a usable, distinct pair of this schema's own properties. */
function assertConversionFieldsValid(
  schemaDoc: { kind?: "standard" | "geospatial"; schema: unknown },
  latField: string,
  lonField: string,
): void {
  if (schemaDoc.kind === "geospatial") {
    throw new ConvexError("This dataset is already geospatial.");
  }
  if (!latField.trim() || !lonField.trim()) {
    throw new ConvexError("Choose latitude and longitude columns.");
  }
  if (latField === lonField) {
    throw new ConvexError("Latitude and longitude must be different columns.");
  }
  const properties = schemaPropertyNames(schemaDoc);
  if (!(latField in properties) || !(lonField in properties)) {
    throw new ConvexError("Latitude/longitude fields must be properties of this dataset's schema.");
  }
}

/**
 * Flips a "standard" dataset to "geospatial" (locked to Point) and starts a
 * durable workflow that backfills a Point geometry for every existing entry
 * from its own `latField`/`lonField` data columns. The schema's `kind`
 * changes immediately (so the map tab/entry form appear right away); entries
 * without valid coordinates in those columns are simply left without
 * geometry, same as any other geometry-less row.
 */
export const startGeospatialConversion = mutation({
  args: {
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertConversionFieldsValid(schemaDoc, args.latField, args.lonField);

    await ctx.db.patch(args.schemaId, {
      boundingBox: undefined,
      featureCount: 0,
      geometryType: "Point",
      kind: "geospatial",
    });

    const importId = await ctx.db.insert("imports", {
        processed: 0,
        schemaId: args.schemaId,
        status: "pending",
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.lib.geospatialConversionWorkflow,
        { importId, latField: args.latField, lonField: args.lonField, schemaId: args.schemaId },
        { context: { importId }, onComplete: internal.lib.handleImportComplete, startAsync: true },
      );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
  returns: v.id("imports"),
});
