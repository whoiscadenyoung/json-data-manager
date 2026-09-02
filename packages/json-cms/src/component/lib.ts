import { WorkflowManager } from "@convex-dev/workflow";
import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
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

export const createSchema = mutation({
  args: {
    schema: v.any(),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    if (!args.schema.title || !args.schema.description) {
      throw new ConvexError("Schema must have 'title' and 'description' properties");
    }

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
      description: args.schema.description,
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

    // Delete all entries associated with this schema first
    const entries = await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();

    await Promise.all(entries.map(async (entry) => ctx.db.delete(entry._id)));

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

export const createEntry = mutation({
  args: {
    data: v.any(),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    const entryId = await ctx.db.insert("entries", {
      data: args.data,
      schemaId: args.schemaId,
    });

    return entryId;
  },
  returns: v.id("entries"),
});

export const createEntriesBulk = mutation({
  args: {
    dataArray: v.array(v.any()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    const ids = await Promise.all(
      args.dataArray.map(async (data) =>
        ctx.db.insert("entries", { data, schemaId: args.schemaId }),
      ),
    );

    return ids;
  },
  returns: v.array(v.id("entries")),
});

export const updateEntry = mutation({
  args: {
    data: v.any(),
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    await ctx.db.patch(args.entryId, { data: args.data });
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

    await ctx.db.delete(args.entryId);
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

    const entries = await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();

    await Promise.all(entries.map(async (entry) => ctx.db.delete(entry._id)));

    return entries.length;
  },
  returns: v.number(),
});

// Internal mutations for advanced use cases

export const insertEntryInternal = internalMutation({
  args: {
    data: v.any(),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const entryId = await ctx.db.insert("entries", {
      data: args.data,
      schemaId: args.schemaId,
    });

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
    await ctx.db.delete(args.entryId);
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

/** Insert one chunk of entries in a single transaction. */
export const insertEntriesChunkInternal = internalMutation({
  args: {
    dataArray: v.array(v.any()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    await Promise.all(
      args.dataArray.map(async (data) =>
        ctx.db.insert("entries", { data, schemaId: args.schemaId }),
      ),
    );
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
