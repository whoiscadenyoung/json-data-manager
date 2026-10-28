import { ConvexError } from "convex/values";

import type { Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";

/** Throws unless `total` is a non-negative integer row count (issue #129: the field drove progress and the completion check, but nothing validated it). */
export function assertValidTotal(total: number): void {
  if (!Number.isInteger(total) || total < 0) {
    throw new ConvexError("total must be a non-negative integer row count.");
  }
}

/**
 * One data operation at a time per dataset (issue #129): an import,
 * conversion, or simplification still `pending`/`processing` blocks another
 * from starting, so two concurrent workflows can't interleave their writes
 * into one dataset's counters and tile-cache version. A run that crashed
 * hard resolves to `failed` through `handleImportComplete` and unblocks the
 * next one; the durable workflow engine's own resume keeps a live run from
 * wedging here.
 */
export async function assertNoActiveDataRun(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
): Promise<void> {
  const runs = await ctx.db
    .query("imports")
    .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
    .collect();
  if (runs.some((row) => row.status === "pending" || row.status === "processing")) {
    throw new ConvexError(
      "Another import, conversion, or simplification is already running for this dataset — wait for it to finish first.",
    );
  }
}
