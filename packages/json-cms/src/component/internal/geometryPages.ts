import type { GeometryTypeArg } from "@caden/data-core/geojson";
import { ConvexError } from "convex/values";

import type { Id } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { INLINE_GEOMETRY_BYTE_LIMIT, geometryRowBudgetBytes } from "../geometry_storage.js";

// Convex caps a single query execution at reading ~16 MiB total across every
// document it touches — and caps a function's return value at the same 16 MiB
// — independent of, and much larger than, the ~900 KB per-document
// `INLINE_GEOMETRY_BYTE_LIMIT` a single `geometries` row can carry. A dataset
// with hundreds of rows near that inline limit can still blow the 16 MiB
// *cumulative* budget in one unpaginated `.collect()`, even though every
// individual row is safely under its own limit.
//
// `listGeometries` pages through results manually — `.withIndex(...).gt(
// "_creationTime", cursor).take(n)` — rather than using Convex's own
// `.paginate()`: components cannot call `.paginate()` at all ("paginate()
// is only supported in the app" — confirmed against a real deployment, not
// just a doc comment; see `paginateGeometriesBySchema`'s doc comment), so
// there's no `maximumBytesRead` safety net available here. Instead, pages
// are budgeted by *bytes*: rows are `.take()`-n in chunks while the
// cumulative payload estimate stays under the budget, so a page of point
// geometries (a few dozen bytes each) fills toward the row ceiling while a
// page of near-inline-limit polygons stops after a handful — the round-trip
// count tracks the data's actual size, not its worst case. (A fixed 8-row
// cap used to make 13 KB of point data cost 17 round trips; the same data
// now fits one page.) Chunk widths come from the dataset's own worst-case
// row (`schemas.maxGeometryRowBytes`, issue #183): sized for the global
// ~900 KB worst case instead, every take held at most 5 rows, so a 500-row
// page of points cost ~100 sequential reads and hit Convex's system-
// operation timeout.
/** Upper bound on the payload bytes one page may carry (exported for tests). */
export const GEOMETRY_PAGE_BYTE_BUDGET = 5_000_000; // ~5 MB of payload per page — safely under the 16 MiB per-execution read cap (which the schema-existence read and per-document overhead also share), with room for the one-row overshoot below. Sized as much for rendering cadence as for safety: each page is one serial round trip with a render in between, and after real-world feedback that ~10 MB pages read as one big stall per arrival, the budget is small enough that pages land as a steady stream instead.

/** High safety ceiling on rows per page; the byte budget is what actually bounds a real page long before this unless every row is tiny. */
export const MAX_GEOMETRY_PAGE_ROWS = 500;

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
 * Parses a `_creationTime` pagination cursor ("", null → undefined).
 * Shared by the geometry and entries paginators, which resume identically.
 */
export function parseCreationTimeCursor(cursor: string | null): number | undefined {
  const afterCreationTime = cursor === null || cursor === "" ? undefined : Number(cursor);
  if (afterCreationTime !== undefined && !Number.isFinite(afterCreationTime)) {
    throw new ConvexError("Invalid pagination cursor.");
  }
  return afterCreationTime;
}

/**
 * One `.take()` of a schema's `geometries` rows starting just after
 * `afterTime`, at the widest row count the remaining byte budget can
 * safely absorb: never more rows than the budget could hold even if every
 * one were the dataset's worst-case row (`maxRowBytes`), so the possible
 * overshoot at a page boundary — rows read but deliberately left for the
 * next page — stays down to a single worst-case row.
 *
 * Returns `requested` alongside the rows so the caller can tell "the index
 * ran dry" (`rows.length < requested`) from "the page budget stopped us".
 */
async function takeGeometryRows(
  ctx: QueryCtx,
  schemaId: Id<"schemas">,
  afterTime: number | undefined,
  maxRows: number,
  remainingBytes: number,
  maxRowBytes: number,
): Promise<{ requested: number; rows: GeometryDbRow[] }> {
  const requested = Math.min(maxRows, Math.max(1, Math.floor(remainingBytes / maxRowBytes)));
  return {
    requested,
    rows: await ctx.db
      .query("geometries")
      .withIndex("by_schema", (q) =>
        afterTime === undefined
          ? q.eq("schemaId", schemaId)
          : q.eq("schemaId", schemaId).gt("_creationTime", afterTime),
      )
      .order("asc")
      .take(requested),
  };
}

/**
 * The per-row size `takeGeometryRows` divides the remaining budget by: the
 * stored worst case, or `INLINE_GEOMETRY_BYTE_LIMIT` when unknown. Clamped
 * to at least 1 byte (a just-cleared dataset stores 0) and at most the
 * inline limit (no row is ever charged more).
 */
function takeSizingRowBytes(maxGeometryRowBytes: number | undefined): number {
  return Math.min(
    INLINE_GEOMETRY_BYTE_LIMIT,
    Math.max(1, maxGeometryRowBytes ?? INLINE_GEOMETRY_BYTE_LIMIT),
  );
}

/**
 * Manual cursor-based pagination over one schema's `geometries` rows.
 * Convex components cannot call `.paginate()` — confirmed at push time
 * against a real deployment ("paginate() is only supported in the app"),
 * not merely a documented restriction — so this hand-rolls the same shape
 * `.paginate()` would produce (`{page, isDone, continueCursor}`), with an
 * explicit byte budget standing in for the `maximumBytesRead` safety net
 * `.paginate()` would have provided.
 *
 * The cursor is just the last-returned row's `_creationTime` (the index's
 * implicit trailing sort key); resuming means `.gt("_creationTime", cursor)`
 * on the same index range.
 *
 * Rows are read in chunks and accumulate into the page until either
 * the index is exhausted (`isDone`) or the next row would push the page's
 * cumulative payload estimate past `GEOMETRY_PAGE_BYTE_BUDGET` — in which
 * case the page stops early with `isDone: false` and the unserved rows are
 * simply re-read by the next page (the overshoot is at most one worst-case
 * row; see `takeGeometryRows`). `maxGeometryRowBytes` is the schema doc's
 * stored worst-case row size; absent (unknown) falls back to
 * `INLINE_GEOMETRY_BYTE_LIMIT`, the pre-#183 sizing. `numItems` is honored only up to
 * `MAX_GEOMETRY_PAGE_ROWS` — never more, as the last-resort ceiling — and
 * at least one row is always returned per call, so the cursor always
 * advances and a caller paging to `isDone` can never stall.
 */
export async function paginateGeometriesBySchema(
  ctx: QueryCtx,
  schemaId: Id<"schemas">,
  paginationOpts: { cursor: string | null; numItems: number },
  maxGeometryRowBytes: number | undefined,
): Promise<{ continueCursor: string; isDone: boolean; page: GeometryDbRow[] }> {
  const rowLimit = Math.max(1, Math.min(paginationOpts.numItems, MAX_GEOMETRY_PAGE_ROWS)),
    page: GeometryDbRow[] = [];
  // Raised in-page if a row turns out bigger than the stored bound, so a
  // stale (understated) value can oversize at most one take before the
  // rest of the page is sized from the largest row actually seen.
  let maxRowBytes = takeSizingRowBytes(maxGeometryRowBytes),
    payloadBytes = 0,
    afterTime = parseCreationTimeCursor(paginationOpts.cursor),
    budgetFull = false,
    isDone = false;

  while (!budgetFull && page.length < rowLimit) {
    // oxlint-disable-next-line no-await-in-loop -- each chunk resumes from the previous chunk's last row; inherently sequential.
    const { requested, rows: chunk } = await takeGeometryRows(
      ctx,
      schemaId,
      afterTime,
      rowLimit - page.length,
      GEOMETRY_PAGE_BYTE_BUDGET - payloadBytes,
      maxRowBytes,
    );

    let drained = chunk.length < requested;
    for (const row of chunk) {
      const rowBytes = geometryRowBudgetBytes(row);
      maxRowBytes = Math.max(maxRowBytes, rowBytes);
      if (payloadBytes > 0 && payloadBytes + rowBytes > GEOMETRY_PAGE_BYTE_BUDGET) {
        // This row would push the page over budget — stop here and leave it
        // (and everything after) for the next page. The rows behind it were
        // already read either way; nothing is lost, only re-read.
        budgetFull = true;
        break;
      }
      page.push(row);
      payloadBytes += rowBytes;
      afterTime = row._creationTime;
    }

    if (budgetFull || !drained) {
      continue; // More rows may follow; the while conditions decide.
    }
    isDone = true; // The index ran dry inside this page.
    break;
  }

  const lastRow = page[page.length - 1];
  return {
    continueCursor:
      lastRow === undefined ? (paginationOpts.cursor ?? "") : String(lastRow._creationTime),
    isDone,
    page,
  };
}
