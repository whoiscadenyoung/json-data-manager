import { WorkflowManager } from "@convex-dev/workflow";
import { ConvexError, v } from "convex/values";

import { isGeometryCompatibleWithDatasetType } from "../shared/geojson/coalesce.js";
import { GeoParseError, GeometryError } from "../shared/geojson/error.js";
import { computeBbox, unionBbox } from "../shared/geojson/geometry.js";
import { assertGeometry } from "../shared/geojson/geometry.js";
import type { BoundingBox } from "../shared/geojson/geometry.js";
import type { Geometry } from "../shared/geojson/types.js";
import { geometryArgsValidator, geometryTypeValidator } from "../shared/geojson/validators.js";
import type { GeometryTypeArg } from "../shared/geojson/validators.js";
import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";

const SCHEMA_SIZE_LIMIT = 102_400, // 100 KB
  // Number of entries inserted per batch/workflow step. Kept well under Convex's
  // Per-transaction write limit so a single dataset can be arbitrarily large.
  IMPORT_BATCH_SIZE = 500,
  // Durable workflow engine (nested component) that drives batched imports.
  workflow = new WorkflowManager(components.workflow),
  schemaValidator = schema.tables.schemas.validator.extend({
    _creationTime: v.number(),
    _id: v.id("schemas"),
  }),
  entryValidator = schema.tables.entries.validator.extend({
    _creationTime: v.number(),
    _id: v.id("entries"),
  }),
  geometryValidator = schema.tables.geometries.validator.extend({
    _creationTime: v.number(),
    _id: v.id("geometries"),
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
      ...geometries.map(async (geometry) => ctx.db.delete(geometry._id)),
    ]);

    await ctx.db.delete(args.schemaId);
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
 * List the full-geometry rows for a schema — the ONLY read path that pulls
 * full coordinate payloads. Reserved for map rendering; the properties table
 * (`listEntries`) never touches this table.
 */
export const listGeometries = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    return ctx.db
      .query("geometries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
  },
  returns: v.array(geometryValidator),
});

export const getEntry = query({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => ctx.db.get(args.entryId),
  returns: v.union(v.null(), entryValidator),
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

/**
 * Wraps `assertGeometry`, translating its custom error classes into a
 * `ConvexError` — `GeometryError`/`GeoParseError` don't serialize usefully
 * across the Convex function boundary, `ConvexError` does.
 */
function assertGeometryForConvex(geometry: unknown): Geometry {
  try {
    return assertGeometry(geometry);
  } catch (err) {
    if (err instanceof GeometryError || err instanceof GeoParseError) {
      throw new ConvexError(err.message);
    }
    throw err;
  }
}

/**
 * Validates `geometry` against the schema doc's `kind`/`geometryType` and
 * returns the parsed `Geometry`, or `undefined` when no geometry was
 * provided. Absent geometry is always fine; a standard (non-geospatial)
 * schema can never carry one; a geospatial schema requires the geometry to
 * structurally validate and be compatible with the schema's locked
 * `geometryType`.
 */
function validateEntryGeometry(
  geometry: unknown,
  schemaDoc: { kind?: "standard" | "geospatial"; geometryType?: GeometryTypeArg },
): Geometry | undefined {
  if (geometry === undefined) {
    return undefined;
  }
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError("Cannot attach geometry to a standard dataset.");
  }
  const parsed = assertGeometryForConvex(geometry);
  if (!isGeometryCompatibleWithDatasetType(parsed.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Geometry type "${parsed.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
  return parsed;
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
  geometry: Geometry,
): Promise<BoundingBox | undefined> {
  const bbox = computeBbox(geometry),
    geometryId = await ctx.db.insert("geometries", {
      bbox,
      entryId,
      geometry,
      schemaId,
      type: geometry.type,
    });
  await ctx.db.patch(entryId, { geometryId, geometryType: geometry.type });
  return bbox;
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
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    featureCount?: number;
    boundingBox?: number[];
  },
  rows: Array<{ data: unknown; geometry?: unknown }>,
): Promise<Array<Id<"entries">>> {
  const parsedGeometries = rows.map((row) => validateEntryGeometry(row.geometry, schemaDoc));

  let addedCount = 0,
    unionedBbox: BoundingBox | undefined;

  const ids = await Promise.all(
    rows.map(async ({ data }, i) => {
      const entryId = await ctx.db.insert("entries", { data, schemaId }),
        parsed = parsedGeometries[i];
      if (parsed !== undefined) {
        const bbox = await attachGeometry(ctx, entryId, schemaId, parsed);
        addedCount += 1;
        unionedBbox = unionBbox(unionedBbox, bbox);
      }
      return entryId;
    }),
  );

  if (addedCount > 0) {
    await applyGeometryStatsDelta(ctx, schemaId, schemaDoc, addedCount, unionedBbox);
  }

  return ids;
}

/**
 * Deletes an entry and, if it has one, its associated `geometries` row —
 * decrementing the owning schema's `featureCount` (bbox left untouched, see
 * its doc comment). Silently no-ops if the entry doesn't exist.
 */
async function deleteEntryCascading(ctx: MutationCtx, entryId: Id<"entries">): Promise<void> {
  const existing = await ctx.db.get(entryId);
  if (!existing) {
    return;
  }
  if (existing.geometryId !== undefined) {
    const schemaDoc = await ctx.db.get(existing.schemaId);
    await ctx.db.delete(existing.geometryId);
    if (schemaDoc) {
      await applyGeometryStatsDelta(ctx, existing.schemaId, schemaDoc, -1, undefined);
    }
  }
  await ctx.db.delete(entryId);
}

/**
 * Deletes the entry's existing `geometries` row (if any), clears its
 * pointer fields, and decrements the schema's `featureCount`. No-ops if the
 * entry has no geometry. Bbox is left untouched (see its doc comment).
 */
async function clearEntryGeometry(
  ctx: MutationCtx,
  entry: { _id: Id<"entries">; schemaId: Id<"schemas">; geometryId?: Id<"geometries"> },
  schemaDoc: { featureCount?: number; boundingBox?: number[] },
): Promise<void> {
  if (entry.geometryId === undefined) {
    return;
  }
  await ctx.db.delete(entry.geometryId);
  await ctx.db.patch(entry._id, { geometryId: undefined, geometryType: undefined });
  await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, -1, undefined);
}

/**
 * Replaces (or newly attaches) an entry's geometry with `parsed`. Patches
 * the existing `geometries` row in place when the entry already had one
 * (no `featureCount` change, since this is a replace, not an add);
 * otherwise attaches a new one and increments `featureCount`. Either way
 * expands the schema's `boundingBox`.
 */
async function replaceEntryGeometry(
  ctx: MutationCtx,
  entry: { _id: Id<"entries">; schemaId: Id<"schemas">; geometryId?: Id<"geometries"> },
  schemaDoc: { featureCount?: number; boundingBox?: number[] },
  parsed: Geometry,
): Promise<void> {
  if (entry.geometryId !== undefined) {
    const bbox = computeBbox(parsed);
    await ctx.db.patch(entry.geometryId, { bbox, geometry: parsed, type: parsed.type });
    await ctx.db.patch(entry._id, { geometryType: parsed.type });
    await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, 0, bbox);
    return;
  }
  const bbox = await attachGeometry(ctx, entry._id, entry.schemaId, parsed);
  await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, 1, bbox);
}

export const createEntry = mutation({
  args: {
    data: v.any(),
    geometry: v.optional(geometryArgsValidator),
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
    entries: v.array(v.object({ data: v.any(), geometry: v.optional(geometryArgsValidator) })),
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
    geometry: v.optional(v.union(geometryArgsValidator, v.null())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    await ctx.db.patch(args.entryId, { data: args.data });

    if (args.geometry === undefined) {
      return;
    }

    const schemaDoc = await ctx.db.get(existing.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    if (args.geometry === null) {
      await clearEntryGeometry(ctx, existing, schemaDoc);
      return;
    }

    const parsed = validateEntryGeometry(args.geometry, schemaDoc);
    if (parsed !== undefined) {
      await replaceEntryGeometry(ctx, existing, schemaDoc, parsed);
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
      ...geometries.map(async (geometry) => ctx.db.delete(geometry._id)),
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
    geometry: v.optional(geometryArgsValidator),
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
    await ctx.db.patch(args.entryId, { data: args.data });
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
// The client uploads the row payload to file storage and calls `startImport`,
// Which records an `imports` status doc and kicks off a durable workflow. The
// Workflow inserts entries in batches (each an independently-retried step) and
// Updates the status doc so the client can render live progress.
// ---------------------------------------------------------------------------

const importValidator = schema.tables.imports.validator.extend({
  _creationTime: v.number(),
  _id: v.id("imports"),
});

/** Generate a short-lived URL the client POSTs the serialized rows to. */
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

/** Create the status doc and start the durable import workflow. */
export const startImport = mutation({
  args: {
    schemaId: v.id("schemas"),
    storageId: v.id("_storage"),
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
        storageId: args.storageId,
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.lib.importWorkflow,
        {
          importId,
          schemaId: args.schemaId,
          storageId: args.storageId,
          total: args.total,
        },
        {
          context: { importId },
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
 * Runs after the import workflow finishes. On success the workflow already
 * marked the import `completed`; here we only need to record failures/cancels.
 */
export const handleImportComplete = internalMutation({
  args: {
    context: v.any(),
    result: v.any(),
    workflowId: v.string(),
  },
  handler: async (ctx, args) => {
    const result = args.result;
    if (result && result.kind === "success") {
      return;
    }
    const importId = args.context ? args.context.importId : undefined;
    if (!importId) {
      return;
    }
    let error = "Import failed.";
    if (result && result.kind === "canceled") {
      error = "Import was canceled.";
    } else if (result && typeof result.error === "string") {
      error = result.error;
    }
    await ctx.db.patch(importId, { error, status: "failed" });
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
 * Read the payload blob, slice `[offset, offset+limit)`, and insert that chunk.
 * Runs as a workflow step so a failed batch is retried in isolation. Returns
 * the number of rows inserted.
 */
export const insertChunkFromStorage = internalAction({
  args: {
    schemaId: v.id("schemas"),
    // A `_storage` id — passed as a plain string because system-table ids can't
    // Be journaled/validated as `v.id("_storage")` through the workflow engine.
    storageId: v.string(),
    offset: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // `storageId` arrives as a string (system-table ids can't be journaled as
    // `v.id` through the workflow); actions have no `normalizeId`, so brand it here.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const blob = await ctx.storage.get(args.storageId as Id<"_storage">);
    if (!blob) {
      throw new ConvexError("Import payload not found in storage");
    }
    // The uploaded blob is always an array of `{ data, geometry? }` rows —
    // Uniform regardless of dataset kind; a standard dataset's rows simply
    // Never carry `geometry`.
    const parsed: unknown = JSON.parse(await blob.text()),
      rows = Array.isArray(parsed) ? parsed : [],
      chunk = rows.slice(args.offset, args.offset + args.limit);
    if (chunk.length === 0) {
      return 0;
    }

    await ctx.runMutation(internal.lib.insertEntriesChunkInternal, {
      dataArray: chunk,
      schemaId: args.schemaId,
    });
    return chunk.length;
  },
  returns: v.number(),
});

/**
 * Insert one chunk of entries in a single transaction. Each row's geometry is
 * validated server-side too (defense-in-depth: the client is expected to
 * have already validated before uploading) — the whole chunk is rejected if
 * any row's geometry is invalid or incompatible, rather than silently
 * dropping bad rows.
 */
export const insertEntriesChunkInternal = internalMutation({
  args: {
    dataArray: v.array(v.object({ data: v.any(), geometry: v.optional(v.any()) })),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    await insertEntryBatch(ctx, args.schemaId, schemaDoc, args.dataArray);
    return null;
  },
  returns: v.null(),
});

/** Durable workflow: insert all rows in batches, updating progress as it goes. */
export const importWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    schemaId: v.id("schemas"),
    storageId: v.string(), // `_storage` id as a string (see insertChunkFromStorage)
    total: v.number(),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0;
    // Batches run sequentially so memory stays bounded and progress lands
    // incrementally; parallelizing the steps would defeat both.
    for (let offset = 0; offset < args.total; offset += IMPORT_BATCH_SIZE) {
      // oxlint-disable-next-line no-await-in-loop
      const inserted = await step.runAction(internal.lib.insertChunkFromStorage, {
        limit: IMPORT_BATCH_SIZE,
        offset,
        schemaId: args.schemaId,
        storageId: args.storageId,
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
