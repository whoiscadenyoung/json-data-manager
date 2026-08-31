import { cancel, getStatus, start as startWorkflow } from "@convex-dev/workflow";
import type { WorkflowId } from "@convex-dev/workflow";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { action, mutation, query } from "./_generated/server.js";
import schema from "./schema.js";
import { exportStatus } from "./schema.js";

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 8192;

const exportValidator = schema.tables.exports.validator.extend({
  _id: v.id("exports"),
  _creationTime: v.number(),
});

const exportFileValidator = schema.tables.exportFiles.validator.extend({
  _id: v.id("exportFiles"),
  _creationTime: v.number(),
});

/**
 * Kick off an export snapshot of the given tables.
 *
 * `readerHandle` is a serialized function handle for a host query that pages
 * through a table (produced by the client `exportReader` helper). The component
 * calls it from the workflow to stream each table's documents.
 */
export const start = mutation({
  args: {
    tableNames: v.array(v.string()),
    readerHandle: v.string(),
    label: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  returns: v.id("exports"),
  handler: async (ctx, args) => {
    if (args.tableNames.length === 0) {
      throw new ConvexError("Provide at least one table name to export.");
    }
    const batchSize = Math.min(Math.max(1, args.batchSize ?? DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE);

    const requestedAt = Date.now();
    const exportId = await ctx.db.insert("exports", {
      label: args.label,
      status: "pending",
      tableNames: args.tableNames,
      readerHandle: args.readerHandle,
      format: "jsonl",
      batchSize,
      requestedAt,
    });

    const workflowId = await startWorkflow(
      ctx,
      internal.workflows.exportWorkflow,
      {
        exportId,
        readerHandle: args.readerHandle,
        tableNames: args.tableNames,
        batchSize,
      },
      {
        onComplete: internal.workflows.onComplete,
        context: { exportId },
        // Start via the workpool rather than running the first step inline, so
        // the mutation returns promptly and the workflow makes progress on its
        // own schedule.
        startAsync: true,
      },
    );

    await ctx.db.patch(exportId, {
      status: "running",
      startedAt: Date.now(),
      workflowId,
    });

    return exportId;
  },
});

/**
 * Cancel a running export. The workflow's `onComplete` handler records the
 * canceled status.
 */
export const cancelExport = mutation({
  args: { exportId: v.id("exports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.exportId);
    if (!exp) {
      throw new ConvexError("Export not found");
    }
    if (exp.workflowId && exp.status === "running") {
      await cancel(ctx, components.workflow, exp.workflowId as WorkflowId);
    }
    return null;
  },
});

/**
 * Delete an export and all of its stored files (including the manifest).
 */
export const deleteExport = mutation({
  args: { exportId: v.id("exports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.exportId);
    if (!exp) {
      throw new ConvexError("Export not found");
    }
    if (exp.status === "running") {
      throw new ConvexError("Cancel the export before deleting it (it is still running).");
    }

    const files = await ctx.db
      .query("exportFiles")
      .withIndex("by_export", (q) => q.eq("exportId", args.exportId))
      .collect();
    for (const file of files) {
      await ctx.storage.delete(file.storageId);
      await ctx.db.delete(file._id);
    }
    if (exp.manifestStorageId) {
      await ctx.storage.delete(exp.manifestStorageId);
    }
    await ctx.db.delete(args.exportId);
    return null;
  },
});

// Queries

export const getExport = query({
  args: { exportId: v.id("exports") },
  returns: v.union(v.null(), exportValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.exportId);
  },
});

export const listExports = query({
  args: {
    status: v.optional(exportStatus),
    limit: v.optional(v.number()),
  },
  returns: v.array(exportValidator),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    if (args.status !== undefined) {
      const status = args.status;
      return await ctx.db
        .query("exports")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("exports").order("desc").take(limit);
  },
});

export const getExportFiles = query({
  args: { exportId: v.id("exports") },
  returns: v.array(exportFileValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("exportFiles")
      .withIndex("by_export", (q) => q.eq("exportId", args.exportId))
      .collect();
  },
});

/**
 * Signed download URLs for an export's files and its manifest. URLs are
 * time-limited by Convex file storage.
 */
export const getDownloadUrls = query({
  args: { exportId: v.id("exports") },
  returns: v.object({
    manifestUrl: v.union(v.null(), v.string()),
    files: v.array(
      v.object({
        tableName: v.string(),
        path: v.string(),
        rowCount: v.number(),
        sizeBytes: v.number(),
        url: v.union(v.null(), v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.exportId);
    const files = await ctx.db
      .query("exportFiles")
      .withIndex("by_export", (q) => q.eq("exportId", args.exportId))
      .collect();

    return {
      manifestUrl: exp?.manifestStorageId ? await ctx.storage.getUrl(exp.manifestStorageId) : null,
      files: await Promise.all(
        files.map(async (f) => ({
          tableName: f.tableName,
          path: f.path,
          rowCount: f.rowCount,
          sizeBytes: f.sizeBytes,
          url: await ctx.storage.getUrl(f.storageId),
        })),
      ),
    };
  },
});

/**
 * Live workflow status straight from the workflow component (more granular than
 * the export row's `status`, e.g. which steps are in progress). Pass the
 * `workflowId` from the export row.
 */
export const workflowStatus = action({
  args: { workflowId: v.string() },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> => {
    return await getStatus(ctx, components.workflow, args.workflowId as WorkflowId);
  },
});
