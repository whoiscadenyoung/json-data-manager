import { WorkflowManager } from "@convex-dev/workflow";
import { vWorkflowId } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalAction, internalMutation, internalQuery } from "./_generated/server.js";

/**
 * The workflow manager, bound to the workflow component mounted inside this
 * component (see convex.config.ts).
 */
export const workflow = new WorkflowManager(components.workflow);

// The shape the host-provided reader returns for one page of a table.
type ReaderPage = {
  page: unknown[];
  isDone: boolean;
  continueCursor: string;
};

// A host-provided table reader, invoked by serialized function handle. It takes
// a table name + pagination cursor and returns one page of documents.
type ReaderRef = FunctionReference<
  "query",
  "internal",
  { table: string; cursor: string | null; numItems: number },
  ReaderPage
>;

type TableResult = {
  tableName: string;
  storageId: Id<"_storage">;
  rowCount: number;
  sizeBytes: number;
};

type ManifestFile = {
  tableName: string;
  path: string;
  rowCount: number;
  sizeBytes: number;
  schema: unknown;
};

/**
 * Export a single table to one newline-delimited JSON file in component
 * storage. The table is streamed in `batchSize` pages so no single query has to
 * read the whole table; the file is stored once the last page is read.
 *
 * This is the unit of durability/retry in the workflow: if a table fails
 * midway, only this step re-runs.
 */
export const exportTable = internalAction({
  args: {
    exportId: v.id("exports"),
    tableName: v.string(),
    readerHandle: v.string(),
    batchSize: v.number(),
  },
  returns: v.object({
    tableName: v.string(),
    storageId: v.id("_storage"),
    rowCount: v.number(),
    sizeBytes: v.number(),
  }),
  handler: async (ctx, args): Promise<TableResult> => {
    // A serialized function handle is a branded string that doubles as a
    // FunctionReference at runtime; the cast restores its call signature.
    const reader = args.readerHandle as unknown as ReaderRef;

    const lines: string[] = [];
    let rowCount = 0;
    let cursor: string | null = null;
    // Guard against a misbehaving reader that never reports done.
    for (;;) {
      const result: ReaderPage = await ctx.runQuery(reader, {
        table: args.tableName,
        cursor,
        numItems: args.batchSize,
      });
      for (const doc of result.page) {
        lines.push(JSON.stringify(doc));
        rowCount += 1;
      }
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    // Trailing newline keeps the file a clean JSONL stream (one doc per line).
    const content = lines.length > 0 ? lines.join("\n") + "\n" : "";
    const blob = new Blob([content], { type: "application/x-ndjson" });
    const sizeBytes = blob.size;
    const storageId = await ctx.storage.store(blob);

    await ctx.runMutation(internal.workflows.recordFile, {
      exportId: args.exportId,
      tableName: args.tableName,
      path: `${args.tableName}/documents.jsonl`,
      storageId,
      rowCount,
      sizeBytes,
    });

    return { tableName: args.tableName, storageId, rowCount, sizeBytes };
  },
});

/**
 * Record a single written table file and roll its counts into the export.
 */
export const recordFile = internalMutation({
  args: {
    exportId: v.id("exports"),
    tableName: v.string(),
    path: v.string(),
    storageId: v.id("_storage"),
    rowCount: v.number(),
    sizeBytes: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const exp = await ctx.db.get(args.exportId);
    // Copy the table's captured schema + version onto the file row, so each
    // file is self-describing for read-back.
    const schema = exp && exp.schemas ? exp.schemas[args.tableName] : undefined;
    await ctx.db.insert("exportFiles", {
      exportId: args.exportId,
      tableName: args.tableName,
      path: args.path,
      storageId: args.storageId,
      rowCount: args.rowCount,
      sizeBytes: args.sizeBytes,
      schemaVersion: exp ? exp.schemaVersion : undefined,
      schema,
    });

    if (exp) {
      await ctx.db.patch(args.exportId, {
        totalRows: (exp.totalRows ?? 0) + args.rowCount,
        totalBytes: (exp.totalBytes ?? 0) + args.sizeBytes,
      });
    }
    return null;
  },
});

/**
 * Write a `_manifest.json` describing the export folder: the export date, the
 * tables it contains, their file paths, and per-table counts. Mirrors the shape
 * of a `convex export` snapshot so downstream tooling can discover the files.
 */
export const finalize = internalAction({
  args: { exportId: v.id("exports") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const files = await ctx.runQuery(internal.workflows.filesForManifest, {
      exportId: args.exportId,
    });

    const manifest = {
      version: 1 as const,
      exportId: args.exportId,
      exportedAt: files.exportedAt,
      exportedAtISO: new Date(files.exportedAt).toISOString(),
      format: "jsonl" as const,
      schemaVersion: files.schemaVersion,
      tables: files.files.map((f: ManifestFile) => ({
        table: f.tableName,
        path: f.path,
        rowCount: f.rowCount,
        sizeBytes: f.sizeBytes,
        // Convex `validator.json` for the table at export time (null if the
        // table had no declared schema).
        schema: f.schema,
      })),
      totalRows: files.files.reduce((n: number, f: ManifestFile) => n + f.rowCount, 0),
      totalBytes: files.files.reduce((n: number, f: ManifestFile) => n + f.sizeBytes, 0),
    };

    const blob = new Blob([JSON.stringify(manifest, null, 2)], {
      type: "application/json",
    });
    const manifestStorageId = await ctx.storage.store(blob);

    await ctx.runMutation(internal.workflows.attachManifest, {
      exportId: args.exportId,
      manifestStorageId,
    });
    return null;
  },
});

export const filesForManifest = internalQuery({
  args: { exportId: v.id("exports") },
  returns: v.object({
    exportedAt: v.number(),
    schemaVersion: v.union(v.string(), v.null()),
    files: v.array(
      v.object({
        tableName: v.string(),
        path: v.string(),
        rowCount: v.number(),
        sizeBytes: v.number(),
        schema: v.union(v.any(), v.null()),
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
      exportedAt: exp ? exp.requestedAt : Date.now(),
      schemaVersion: exp ? (exp.schemaVersion ?? null) : null,
      files: files.map((f) => ({
        tableName: f.tableName,
        path: f.path,
        rowCount: f.rowCount,
        sizeBytes: f.sizeBytes,
        schema: f.schema ?? null,
      })),
    };
  },
});

export const attachManifest = internalMutation({
  args: {
    exportId: v.id("exports"),
    manifestStorageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.exportId, {
      manifestStorageId: args.manifestStorageId,
    });
    return null;
  },
});

type WorkflowSummary = { tables: number; rows: number; bytes: number };

/**
 * The export workflow: for each requested table, durably export it to a file,
 * then write the manifest. Tables run one-by-one so a large export makes steady,
 * resumable progress; switch to `Promise.all` over `step.runAction` to fan out.
 */
export const exportWorkflow = workflow.define({
  args: {
    exportId: v.id("exports"),
    readerHandle: v.string(),
    tableNames: v.array(v.string()),
    batchSize: v.number(),
  },
  returns: v.object({
    tables: v.number(),
    rows: v.number(),
    bytes: v.number(),
  }),
  handler: async (step, args): Promise<WorkflowSummary> => {
    let rows = 0;
    let bytes = 0;
    for (const tableName of args.tableNames) {
      const res = await step.runAction(internal.workflows.exportTable, {
        exportId: args.exportId,
        tableName,
        readerHandle: args.readerHandle,
        batchSize: args.batchSize,
      });
      rows += res.rowCount;
      bytes += res.sizeBytes;
    }

    await step.runAction(internal.workflows.finalize, {
      exportId: args.exportId,
    });

    return { tables: args.tableNames.length, rows, bytes };
  },
});

/**
 * Runs exactly once when the workflow finishes (success, failure, or cancel).
 * Records the terminal status and the completion time on the export row.
 */
export const onComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ exportId: v.id("exports") }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const patch: {
      completedAt: number;
      status: "completed" | "failed" | "canceled";
      error?: string;
    } = { completedAt: Date.now(), status: "completed" };

    if (args.result.kind === "success") {
      patch.status = "completed";
    } else if (args.result.kind === "canceled") {
      patch.status = "canceled";
    } else {
      patch.status = "failed";
      patch.error = "error" in args.result ? args.result.error : "Unknown error";
    }

    await ctx.db.patch(args.context.exportId, patch);
    return null;
  },
});
