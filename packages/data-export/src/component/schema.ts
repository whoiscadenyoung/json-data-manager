import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Status of an export snapshot.
 *
 * pending    -> created, workflow not yet started
 * running    -> workflow is reading tables and writing files
 * completed  -> all requested tables were written successfully
 * failed     -> the workflow errored (see `error`)
 * canceled   -> the workflow was canceled before finishing
 */
export const exportStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
);

export default defineSchema({
  // One row per export snapshot ("folder"). Groups the per-table files
  // written to component file storage at a single point in time.
  exports: defineTable({
    // Human/machine label for this snapshot, e.g. "nightly" or "manual".
    label: v.optional(v.string()),
    status: exportStatus,
    // Tables that were requested for this export, in order.
    tableNames: v.array(v.string()),
    // Serialized function handle for the host-provided table reader. The
    // workflow calls this to page through the host app's data.
    readerHandle: v.string(),
    format: v.literal("jsonl"),
    // Number of documents read per page when streaming each table.
    batchSize: v.number(),
    // The moment the export was requested (its logical "date of export").
    requestedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    // Workflow id from @convex-dev/workflow, for status/cancel.
    workflowId: v.optional(v.string()),
    // Storage id of the `_manifest.json` describing the folder.
    manifestStorageId: v.optional(v.id("_storage")),
    // Rolled-up totals across all files (populated as files are written).
    totalRows: v.optional(v.number()),
    totalBytes: v.optional(v.number()),
    error: v.optional(v.string()),
    // Version stamp for the exported shape. An explicit label the caller
    // passes, or an auto hash of the captured schemas. Read-back upcasters key
    // off this to migrate old snapshots to the current shape.
    schemaVersion: v.optional(v.string()),
    // Per-table declared schema captured at export time: tableName ->
    // Convex validator JSON (`validator.json`). Makes each snapshot
    // self-describing even after the live table drifts.
    schemas: v.optional(v.record(v.string(), v.any())),
  }).index("by_status", ["status"]),

  // One row per table file written for an export.
  exportFiles: defineTable({
    exportId: v.id("exports"),
    tableName: v.string(),
    // Logical path within the export folder, e.g. "users/documents.jsonl".
    path: v.string(),
    storageId: v.id("_storage"),
    rowCount: v.number(),
    sizeBytes: v.number(),
    // Copied from the export at write time, so each file is self-describing.
    schemaVersion: v.optional(v.string()),
    schema: v.optional(v.any()),
  })
    .index("by_export", ["exportId"])
    .index("by_export_table", ["exportId", "tableName"]),
});
