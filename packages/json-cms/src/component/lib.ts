import { v, ConvexError } from "convex/values";
import { WorkflowManager } from "@convex-dev/workflow";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server.js";
import { internal, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";

const SCHEMA_SIZE_LIMIT = 102400; // 100 KB

// Number of entries inserted per batch/workflow step. Kept well under Convex's
// per-transaction write limit so a single dataset can be arbitrarily large.
const IMPORT_BATCH_SIZE = 500;

// Durable workflow engine (nested component) that drives batched imports.
const workflow = new WorkflowManager(components.workflow);

const schemaValidator = schema.tables.schemas.validator.extend({
  _id: v.id("schemas"),
  _creationTime: v.number(),
});

const entryValidator = schema.tables.entries.validator.extend({
  _id: v.id("entries"),
  _creationTime: v.number(),
});

// Schema queries

export const listSchemas = query({
  args: {},
  returns: v.array(schemaValidator),
  handler: async (ctx) => {
    return await ctx.db.query("schemas").order("desc").collect();
  },
});

export const getSchema = query({
  args: { schemaId: v.id("schemas") },
  returns: v.union(v.null(), schemaValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.schemaId);
  },
});

// Schema mutations

export const createSchema = mutation({
  args: {
    schema: v.any(),
    uiSchema: v.optional(v.any()),
  },
  returns: v.id("schemas"),
  handler: async (ctx, args) => {
    if (!args.schema.title || !args.schema.description) {
      throw new ConvexError(
        "Schema must have 'title' and 'description' properties",
      );
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
      title: args.schema.title,
      description: args.schema.description,
      schema: args.schema,
      uiSchema: args.uiSchema,
    });

    return schemaId;
  },
});

export const updateSchema = mutation({
  args: {
    schemaId: v.id("schemas"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    schema: v.optional(v.any()),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    const patch: Record<string, unknown> = {};

    if (args.schema !== undefined) {
      if (!args.schema.title || !args.schema.description) {
        throw new ConvexError(
          "Schema must have 'title' and 'description' properties",
        );
      }
      const schemaStr = JSON.stringify(args.schema);
      if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("Schema exceeds the 100 KB size limit.");
      }
      patch.schema = args.schema;
      patch.title = args.schema.title;
      patch.description = args.schema.description;
    } else {
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
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

    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }

    await ctx.db.delete(args.schemaId);
  },
});

// Entry queries

export const listEntries = query({
  args: { schemaId: v.id("schemas") },
  returns: v.array(entryValidator),
  handler: async (ctx, args) => {
    // Verify schema exists
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new ConvexError("Schema not found");
    }

    return await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .order("desc")
      .collect();
  },
});

export const getEntry = query({
  args: { entryId: v.id("entries") },
  returns: v.union(v.null(), entryValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.entryId);
  },
});

// Internal queries/mutations for use within the component

export const getSchemaInternal = internalQuery({
  args: { schemaId: v.id("schemas") },
  returns: v.union(v.null(), schemaValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.schemaId);
  },
});

export const getEntryInternal = internalQuery({
  args: { entryId: v.id("entries") },
  returns: v.union(v.null(), entryValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.entryId);
  },
});

// Entry mutations

export const createEntry = mutation({
  args: {
    schemaId: v.id("schemas"),
    data: v.any(),
  },
  returns: v.id("entries"),
  handler: async (ctx, args) => {
    // Verify schema exists
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new ConvexError("Schema not found");
    }

    const entryId = await ctx.db.insert("entries", {
      schemaId: args.schemaId,
      data: args.data,
    });

    return entryId;
  },
});

export const createEntriesBulk = mutation({
  args: {
    schemaId: v.id("schemas"),
    dataArray: v.array(v.any()),
  },
  returns: v.array(v.id("entries")),
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new ConvexError("Schema not found");
    }

    const ids = await Promise.all(
      args.dataArray.map((data) =>
        ctx.db.insert("entries", { schemaId: args.schemaId, data }),
      ),
    );

    return ids;
  },
});

export const updateEntry = mutation({
  args: {
    entryId: v.id("entries"),
    data: v.any(),
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
  returns: v.number(),
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new ConvexError("Schema not found");
    }

    const entries = await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();

    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }

    return entries.length;
  },
});

// Internal mutations for advanced use cases

export const insertEntryInternal = internalMutation({
  args: {
    schemaId: v.id("schemas"),
    data: v.any(),
  },
  returns: v.id("entries"),
  handler: async (ctx, args) => {
    const entryId = await ctx.db.insert("entries", {
      schemaId: args.schemaId,
      data: args.data,
    });

    return entryId;
  },
});

export const patchEntryInternal = internalMutation({
  args: {
    entryId: v.id("entries"),
    data: v.any(),
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
// which records an `imports` status doc and kicks off a durable workflow. The
// workflow inserts entries in batches (each an independently-retried step) and
// updates the status doc so the client can render live progress.
// ---------------------------------------------------------------------------

const importValidator = schema.tables.imports.validator.extend({
  _id: v.id("imports"),
  _creationTime: v.number(),
});

/** Generate a short-lived URL the client POSTs the serialized rows to. */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/** Read the import status doc (client subscribes to this for progress). */
export const getImportStatus = query({
  args: { importId: v.id("imports") },
  returns: v.union(importValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.importId);
  },
});

/** Create the status doc and start the durable import workflow. */
export const startImport = mutation({
  args: {
    schemaId: v.id("schemas"),
    storageId: v.id("_storage"),
    total: v.number(),
  },
  returns: v.id("imports"),
  handler: async (ctx, args) => {
    const targetSchema = await ctx.db.get(args.schemaId);
    if (!targetSchema) {
      throw new ConvexError("Schema not found");
    }

    const importId = await ctx.db.insert("imports", {
      schemaId: args.schemaId,
      storageId: args.storageId,
      total: args.total,
      processed: 0,
      status: "pending",
    });

    const workflowId = await workflow.start(
      ctx,
      internal.lib.importWorkflow,
      {
        importId,
        schemaId: args.schemaId,
        storageId: args.storageId,
        total: args.total,
      },
      {
        onComplete: internal.lib.handleImportComplete,
        context: { importId },
        startAsync: true,
      },
    );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
});

/**
 * Runs after the import workflow finishes. On success the workflow already
 * marked the import `completed`; here we only need to record failures/cancels.
 */
export const handleImportComplete = internalMutation({
  args: {
    workflowId: v.string(),
    context: v.any(),
    result: v.any(),
  },
  handler: async (ctx, args) => {
    if (args.result?.kind === "success") return;
    const importId = args.context?.importId;
    if (!importId) return;
    await ctx.db.patch(importId, {
      status: "failed",
      error:
        args.result?.kind === "canceled"
          ? "Import was canceled."
          : (args.result?.error ?? "Import failed."),
    });
  },
});

/** Patch import progress/status. Called between workflow steps. */
export const updateImportProgress = internalMutation({
  args: {
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
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.processed !== undefined) patch.processed = args.processed;
    if (args.status !== undefined) patch.status = args.status;
    if (args.error !== undefined) patch.error = args.error;
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
    // be journaled/validated as `v.id("_storage")` through the workflow engine.
    storageId: v.string(),
    offset: v.number(),
    limit: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const blob = await ctx.storage.get(args.storageId as Id<"_storage">);
    if (!blob) {
      throw new ConvexError("Import payload not found in storage");
    }
    const rows = JSON.parse(await blob.text()) as unknown[];
    const chunk = rows.slice(args.offset, args.offset + args.limit);
    if (chunk.length === 0) return 0;

    await ctx.runMutation(internal.lib.insertEntriesChunkInternal, {
      schemaId: args.schemaId,
      dataArray: chunk,
    });
    return chunk.length;
  },
});

/** Insert one chunk of entries in a single transaction. */
export const insertEntriesChunkInternal = internalMutation({
  args: {
    schemaId: v.id("schemas"),
    dataArray: v.array(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const data of args.dataArray) {
      await ctx.db.insert("entries", { schemaId: args.schemaId, data });
    }
    return null;
  },
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
      status: "processing",
      processed: 0,
    });

    let processed = 0;
    for (let offset = 0; offset < args.total; offset += IMPORT_BATCH_SIZE) {
      const inserted = await step.runAction(internal.lib.insertChunkFromStorage, {
        schemaId: args.schemaId,
        storageId: args.storageId,
        offset,
        limit: IMPORT_BATCH_SIZE,
      });
      processed += inserted;
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
